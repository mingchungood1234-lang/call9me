import type { Ack, CallElsewhere, CallRejoin, IceCandidate, PushPayload, SessionDescription } from '../../shared/types';
import { isValidRoomId, PUBLIC_ROOM_ID, ROOM_ID_RULES } from '../../shared/validation';
import { config } from '../config';
import { accountModel } from '../models/AccountModel';
import { avatarModel } from '../models/AvatarModel';
import { callModel, type Call } from '../models/CallModel';
import { roomSettingsModel } from '../models/RoomSettingsModel';
import { userModel, type OnlineUser } from '../models/UserModel';
import { userStatusModel } from '../models/UserStatusModel';
import { callHistory } from '../services/CallHistory';
import { pushService } from '../services/PushService';
import { roomDirectory } from '../services/RoomDirectory';
import { listDirectory } from '../services/UserDirectory';
import type { AppServer, AppSocket } from '../sockets/types';
import { safeAck } from '../sockets/util';

const MAX_SDP_LENGTH = 100_000;
const ON_OTHER_DEVICE = "You're in a call on another device. Hang up there first.";

function isSessionDescription(value: unknown, type: SessionDescription['type']): value is SessionDescription {
  const v = value as SessionDescription | undefined;
  return !!v && v.type === type && typeof v.sdp === 'string' && v.sdp.length <= MAX_SDP_LENGTH;
}

function isIceCandidate(value: unknown): value is IceCandidate {
  const v = value as IceCandidate | undefined;
  return !!v && typeof v.candidate === 'string' && v.candidate.length <= 2_000;
}

/** Uses the same tag as the "incoming call" push so it replaces that notification. */
function missedCallPush(from: string): PushPayload {
  return {
    type: 'missed-call',
    title: 'Missed call',
    body: `${from} tried to call you`,
    tag: `call-${from}`,
    url: '/app',
    icon: avatarModel.urlOf(from),
  };
}

/** "Incoming call" notification; opening it answers the call (`/app?answer=<callId>`). */
function callPush(call: Call, from: string): PushPayload {
  return {
    type: 'call',
    title: `Incoming ${call.video ? 'video' : 'voice'} call`,
    body: call.roomId
      ? `${from} invited you to call room #${call.roomId}`
      : call.participants.size > 1
        ? `${from} invited you to a group call`
        : `${from} is calling you`,
    tag: `call-${from}`,
    url: `/app?answer=${call.id}`,
    callId: call.id,
    icon: avatarModel.urlOf(from), // the caller's picture (Android/desktop; iOS always shows the app icon)
  };
}

/**
 * Group call setup + WebRTC signaling relay (full mesh).
 *
 * Calls hold participants and pending invites. When someone accepts, they send an
 * offer to every existing participant; offers/answers/ICE are relayed only between
 * members of the same call. The server never touches media.
 *
 * A user may be signed in on several devices: an invite rings all of them, and the one
 * that answers (or starts the call) is the user's call device — everything about the
 * call goes only there, and only it can act in the call.
 */
export class SignalingController {
  /** "callId|userId" → ring timeout */
  private readonly inviteTimers = new Map<string, NodeJS.Timeout>();
  /** "callId|userId" → end of the minute someone who left has to rejoin */
  private readonly rejoinTimers = new Map<string, NodeJS.Timeout>();

  constructor(private readonly io: AppServer) {
    callHistory.onEntry = (userId, entry) => {
      const user = userModel.find(userId);
      if (user) this.io.to(user.channel).emit('history:new', entry);
    };
  }

  register(socket: AppSocket): void {
    const me = () => userModel.find(socket.data.userId);
    /** Us, if this device is the one in our call. */
    const inCallHere = () => {
      const user = me();
      return user?.callId && user.callSocketId === socket.id ? user : undefined;
    };

    socket.on('call:invite', (payload, ack) => this.invite(me(), socket.id, payload, safeAck(ack)));
    socket.on('call:join-room', (payload, ack) => this.joinRoom(me(), socket.id, payload, safeAck(ack)));
    socket.on('call:accept', (payload, ack) =>
      this.accept(me(), socket.id, payload?.callId, payload?.video !== false, safeAck(ack)),
    );
    socket.on('call:reject', (payload) => {
      const user = me();
      const reason = typeof payload?.reason === 'string' ? payload.reason.slice(0, 100) : 'declined';
      if (user) this.declineInvite(user.id, payload?.callId, reason, socket.id);
    });
    socket.on('call:leave', () => this.leave(inCallHere(), 'left'));
    socket.on('call:move-here', (ack) => this.moveHere(me(), socket.id, safeAck(ack)));
    socket.on('call:rejoin', (payload, ack) =>
      this.rejoin(me(), socket.id, payload?.callId, payload?.video !== false, safeAck(ack)),
    );
    socket.on('call:screen', (payload) => {
      const user = inCallHere();
      const call = user && callModel.get(user.callId);
      if (!user || !call) return;
      const sharing = payload?.sharing === true;
      this.eachParticipant(call, (p) => this.io.to(userModel.callTarget(p)).emit('call:screen', { from: user.id, sharing }), user.id);
    });
    socket.on('call:camera', (payload) => {
      const user = inCallHere();
      const call = user && callModel.get(user.callId);
      if (!user || !call) return;
      const on = payload?.on === true;
      this.eachParticipant(call, (p) => this.io.to(userModel.callTarget(p)).emit('call:camera', { from: user.id, on }), user.id);
    });

    socket.on('webrtc:offer', (payload) => {
      if (!isSessionDescription(payload?.sdp, 'offer')) return;
      this.relay(inCallHere(), payload.to, (to, from) => this.io.to(to).emit('webrtc:offer', { from, sdp: payload.sdp }));
    });
    socket.on('webrtc:answer', (payload) => {
      if (!isSessionDescription(payload?.sdp, 'answer')) return;
      this.relay(inCallHere(), payload.to, (to, from) => this.io.to(to).emit('webrtc:answer', { from, sdp: payload.sdp }));
    });
    socket.on('webrtc:ice', (payload) => {
      if (!isIceCandidate(payload?.candidate)) return;
      this.relay(inCallHere(), payload.to, (to, from) => this.io.to(to).emit('webrtc:ice', { from, candidate: payload.candidate }));
    });
  }

  /**
   * One of the user's devices disconnected: if it was the one in a call, they leave the
   * call. Once their last device is gone, a ringing invite keeps ringing via push if they
   * have notifications on (phone locked / app closed); otherwise it's declined.
   */
  handleDisconnect(user: OnlineUser, socketId: string, wasLastDevice: boolean): void {
    if (user.callSocketId === socketId) this.leave(user, 'disconnected');
    if (!wasLastDevice) return;
    if (user.invitedTo) {
      const call = callModel.get(user.invitedTo);
      const invite = call?.invited.get(user.id);
      if (call && invite && pushService.hasSubscribers(user.id)) {
        user.invitedTo = null;
        pushService.notify(user.id, callPush(call, invite.by));
      } else {
        this.declineInvite(user.id, user.invitedTo, 'disconnected');
      }
    }
  }

  /** A newly connected device learns about a call we dropped out of a moment ago, so it can rejoin. */
  sendRejoinableTo(user: OnlineUser, socketId: string): void {
    const call = callModel.findRejoinFor(user.id);
    if (call && !user.callId) this.io.to(socketId).emit('call:rejoinable', this.rejoinInfo(call, user.id));
  }

  /** A newly connected device learns about the call we're in on another device, so it can take it over. */
  sendElsewhereTo(user: OnlineUser, socketId: string): void {
    if (user.callId && user.callSocketId !== socketId) this.io.to(socketId).emit('call:elsewhere', this.elsewhere(user));
  }

  /** On (re)connect, hand this device any call still ringing for this user — e.g. opened from a call notification. */
  deliverPendingInvite(user: OnlineUser, socketId: string): void {
    const call = callModel.findInviteFor(user.id);
    const invite = call?.invited.get(user.id);
    if (!call || !invite) return;
    user.invitedTo = call.id;
    this.io.to(socketId).emit('call:incoming', {
      callId: call.id,
      roomId: call.roomId,
      from: invite.by,
      video: call.video,
      participants: [...call.participants],
    });
  }

  /**
   * Declines a ringing invite. Works for offline users too (the notification's Decline
   * button calls this over HTTP). Their other devices stop ringing; `fromSocketId` is the
   * device that declined. @returns whether there was an invite to decline.
   */
  declineInvite(userId: string, callId: unknown, reason: string, fromSocketId?: string): boolean {
    if (typeof callId !== 'string') return false;
    const user = userModel.find(userId);
    if (user?.invitedTo === callId) user.invitedTo = null;

    const call = callModel.get(callId);
    if (!call?.invited.delete(userId)) return false;
    if (user) {
      const others = fromSocketId ? this.io.to(user.channel).except(fromSocketId) : this.io.to(user.channel);
      others.emit('call:cancelled', { callId, reason: `${reason} on another device` });
    }
    this.clearInviteTimer(callId, userId);
    if (reason === 'declined') callHistory.declined(call, userId);
    callHistory.finish(callId, userId, reason === 'declined' ? 'declined' : 'missed');

    this.eachParticipant(call, (p) => this.io.to(userModel.callTarget(p)).emit('call:rejected', { callId, from: userId, reason }));
    if (!this.endIfEmpty(call)) this.emitUpdate(call);
    this.broadcastUsers();
    return true;
  }

  /** Called after every change to who's online or in which call — room call counts change with it. */
  broadcastUsers(): void {
    this.io.emit('users:update', listDirectory());
    roomDirectory.changed();
  }

  // ---- Call lifecycle ----

  private invite(
    caller: OnlineUser | undefined,
    socketId: string,
    payload: { to: string; video: boolean },
    ack: Ack<{ callId: string; to: string; offline: boolean }>,
  ): void {
    if (!caller) return ack({ ok: false, error: 'Not registered' });
    if (caller.invitedTo) return ack({ ok: false, error: 'Answer or decline your incoming call first' });
    if (caller.callId && caller.callSocketId !== socketId) return ack({ ok: false, error: ON_OTHER_DEVICE });

    const targetId = typeof payload?.to === 'string' ? payload.to : '';
    const target = userModel.find(targetId);
    // Offline users with notifications on (e.g. an installed PWA that's closed) are rung via push.
    const offlineId =
      !target && targetId && pushService.hasSubscribers(targetId) ? (accountModel.canonicalId(targetId) ?? null) : null;
    if (!target && !offlineId) return ack({ ok: false, error: `User "${targetId}" is not online` });
    const calleeId = target?.id ?? offlineId!;
    if (calleeId === caller.id) return ack({ ok: false, error: 'You cannot call yourself' });
    if (userStatusModel.get(calleeId) === 'dnd') return ack({ ok: false, error: `${calleeId} is on Do not disturb` });

    let call = callModel.get(caller.callId);
    if (call?.participants.has(calleeId)) return ack({ ok: false, error: `${calleeId} is already in this call` });
    if (call?.invited.has(calleeId)) return ack({ ok: false, error: `${calleeId} is already being called` });
    if ((target && userModel.isBusy(target)) || callModel.findInviteFor(calleeId)) {
      return ack({ ok: false, error: `${calleeId} is busy right now` });
    }
    if (call && callModel.size(call) >= config.maxCallParticipants) {
      return ack({ ok: false, error: `Calls are limited to ${config.maxCallParticipants} people` });
    }

    if (!call) {
      call = callModel.create(caller.id, payload.video !== false);
      caller.callId = call.id;
      caller.callSocketId = socketId;
    }
    call.invited.set(calleeId, { by: caller.id, at: Date.now() });
    callHistory.dial(call, caller.id, calleeId, payload.video !== false);

    const callId = call.id;
    this.inviteTimers.set(
      `${callId}|${calleeId}`,
      setTimeout(() => this.expireInvite(callId, calleeId), target ? config.ringTimeoutMs : config.offlineRingTimeoutMs),
    );

    if (target) {
      target.invitedTo = call.id;
      this.io.to(target.channel).emit('call:incoming', {
        callId,
        roomId: call.roomId,
        from: caller.id,
        video: call.video,
        participants: [...call.participants],
      });
    }
    // Rings the device when the app is closed or in the background (the service worker skips it when visible).
    pushService.notify(calleeId, callPush(call, caller.id));

    // An invisible callee rings like someone whose app is closed, so calling doesn't reveal them.
    ack({ ok: true, callId, to: calleeId, offline: !target || userStatusModel.get(calleeId) === 'invisible' });
    this.emitUpdate(call);
    this.broadcastUsers();
  }

  /** Joins the call room with this ID, opening it if nobody is there yet. */
  private joinRoom(
    user: OnlineUser | undefined,
    socketId: string,
    payload: { roomId: string; video: boolean; key?: string },
    ack: Ack<{ callId: string; roomId: string; participants: string[]; video: boolean }>,
  ): void {
    if (!user) return ack({ ok: false, error: 'Not registered' });
    if (!isValidRoomId(payload?.roomId)) return ack({ ok: false, error: `Invalid room ID. ${ROOM_ID_RULES}` });
    if (user.invitedTo) return ack({ ok: false, error: 'Answer or decline your incoming call first' });
    if (user.callId) return ack({ ok: false, error: user.callSocketId === socketId ? 'Leave your current call first' : ON_OTHER_DEVICE });

    if (payload.roomId.toLowerCase() === PUBLIC_ROOM_ID) {
      return ack({ ok: false, error: 'The Public chat has no call. Use another room ID.' });
    }
    const denied = roomDirectory.denyReason(payload.roomId, user.id, payload.key);
    if (denied) return ack({ ok: false, error: denied });
    roomSettingsModel.claim(payload.roomId, user.id); // first to use a new ID owns it

    const video = payload.video !== false;
    let call = callModel.findByRoom(payload.roomId);
    if (call && callModel.size(call) >= config.maxCallParticipants) {
      return ack({ ok: false, error: `Room #${call.roomId} is full (${config.maxCallParticipants} people max)` });
    }

    const existing = call ? [...call.participants] : [];
    if (call) call.participants.add(user.id);
    else call = callModel.create(user.id, video, payload.roomId);
    user.callId = call.id;
    user.callSocketId = socketId;
    this.backFromAway(call, user.id);
    callHistory.join(call, user.id, video);

    const callId = call.id;
    this.eachParticipant(call, (p) => this.io.to(userModel.callTarget(p)).emit('call:peer-joined', { callId, userId: user.id }), user.id);
    // Like accepting an invite: the newcomer sends an offer to each existing participant.
    ack({ ok: true, callId, roomId: call.roomId!, participants: existing, video: call.video });
    this.emitUpdate(call);
    this.broadcastUsers();
  }

  private accept(
    user: OnlineUser | undefined,
    socketId: string,
    callId: unknown,
    video: boolean,
    ack: Ack<{ callId: string; participants: string[]; video: boolean }>,
  ): void {
    if (!user || typeof callId !== 'string' || user.invitedTo !== callId) {
      return ack({ ok: false, error: 'No incoming call to accept' });
    }
    this.clearInviteTimer(callId, user.id);
    user.invitedTo = null;

    const call = callModel.get(callId);
    if (!call || !call.invited.delete(user.id)) {
      this.broadcastUsers();
      return ack({ ok: false, error: 'This call is no longer available' });
    }

    const existing = [...call.participants];
    call.participants.add(user.id);
    user.callId = call.id;
    user.callSocketId = socketId;
    this.backFromAway(call, user.id);
    callHistory.join(call, user.id, video);
    // Our other devices stop ringing.
    this.io.to(user.channel).except(socketId).emit('call:cancelled', { callId, reason: 'answered on another device' });

    this.eachParticipant(call, (p) => this.io.to(userModel.callTarget(p)).emit('call:peer-joined', { callId, userId: user.id }), user.id);
    // The newcomer sends an offer to each existing participant.
    ack({ ok: true, callId, participants: existing, video: call.video });
    this.emitUpdate(call);
    this.broadcastUsers();
  }

  /**
   * Hands our call to this device: the device that had it is told to drop out without
   * leaving, and everyone else drops their connection to it and takes offers from here.
   */
  private moveHere(user: OnlineUser | undefined, socketId: string, ack: Ack<CallElsewhere>): void {
    const call = user && callModel.get(user.callId);
    if (!user || !call) return ack({ ok: false, error: 'There is no call to move here' });
    if (user.callSocketId === socketId) return ack({ ok: false, error: 'The call is already on this device' });

    const previous = user.callSocketId;
    user.callSocketId = socketId;
    if (previous) this.io.to(previous).emit('call:moved', { callId: call.id });
    this.eachParticipant(
      call,
      (p) => this.io.to(userModel.callTarget(p)).emit('call:peer-moved', { callId: call.id, userId: user.id }),
      user.id,
    );
    ack({ ok: true, ...this.elsewhere(user)! });
    this.emitUpdate(call); // also tells the old device the call is now "elsewhere", so it can take it back
  }

  /** Back into a call left less than a minute ago: like accepting, the newcomer sends the offers. */
  private rejoin(
    user: OnlineUser | undefined,
    socketId: string,
    callId: unknown,
    video: boolean,
    ack: Ack<CallElsewhere>,
  ): void {
    const call = typeof callId === 'string' ? callModel.get(callId) : undefined;
    if (!user || !call || !call.recent.has(user.id)) return ack({ ok: false, error: 'That call is over' });
    if (user.callId || user.invitedTo) return ack({ ok: false, error: 'Leave your current call first' });
    if (callModel.size(call) >= config.maxCallParticipants) {
      return ack({ ok: false, error: `Calls are limited to ${config.maxCallParticipants} people` });
    }
    this.clearRejoinTimer(call.id, user.id);
    call.recent.delete(user.id);
    const existing = [...call.participants];
    call.participants.add(user.id);
    user.callId = call.id;
    user.callSocketId = socketId;
    this.backFromAway(call, user.id);
    callHistory.join(call, user.id, video); // their history entry was kept open, so it stays one call

    this.eachParticipant(call, (p) => this.io.to(userModel.callTarget(p)).emit('call:peer-joined', { callId: call.id, userId: user.id }), user.id);
    ack({ ok: true, callId: call.id, roomId: call.roomId, participants: existing, video: call.video });
    this.io.to(user.channel).emit('call:rejoinable', { ...this.rejoinInfo(call, user.id), until: 0 });
    this.emitUpdate(call);
    this.broadcastUsers();
  }

  /** `user` just left `call` (others are still in it): it waits a minute for them to come back. */
  private allowRejoin(call: Call, user: OnlineUser): void {
    const until = Date.now() + config.rejoinWindowMs;
    call.recent.set(user.id, until);
    const callId = call.id;
    this.clearRejoinTimer(callId, user.id);
    this.rejoinTimers.set(`${callId}|${user.id}`, setTimeout(() => this.expireRejoin(callId, user.id), config.rejoinWindowMs));
    this.io.to(user.channel).emit('call:rejoinable', this.rejoinInfo(call, user.id));
  }

  /** Their minute is up: the call is over for them (and ends if that leaves someone alone). */
  private expireRejoin(callId: string, userId: string): void {
    this.rejoinTimers.delete(`${callId}|${userId}`);
    const call = callModel.get(callId);
    if (!call?.recent.delete(userId)) return;
    callHistory.finish(callId, userId, 'cancelled');
    this.tellRejoinOver(call, userId);
    if (!this.endIfEmpty(call)) this.emitUpdate(call);
    this.broadcastUsers();
  }

  private rejoinInfo(call: Call, userId: string): CallRejoin {
    return {
      callId: call.id,
      roomId: call.roomId,
      participants: [...call.participants].filter((p) => p !== userId),
      video: call.video,
      until: call.recent.get(userId) ?? 0,
    };
  }

  private tellRejoinOver(call: Call, userId: string): void {
    const user = userModel.find(userId);
    if (user) this.io.to(user.channel).emit('call:rejoinable', { ...this.rejoinInfo(call, userId), until: 0 });
  }

  /** Back in a call they'd just left (by its room ID, or a new invite): stop waiting for them. */
  private backFromAway(call: Call, userId: string): void {
    if (!call.recent.delete(userId)) return;
    this.clearRejoinTimer(call.id, userId);
    this.tellRejoinOver(call, userId);
  }

  private clearRejoinTimer(callId: string, userId: string): void {
    const key = `${callId}|${userId}`;
    const timer = this.rejoinTimers.get(key);
    if (timer) clearTimeout(timer);
    this.rejoinTimers.delete(key);
  }

  private expireInvite(callId: string, userId: string): void {
    this.inviteTimers.delete(`${callId}|${userId}`);
    const call = callModel.get(callId);
    const invite = call?.invited.get(userId);
    if (!call || !invite) return;

    call.invited.delete(userId);
    callHistory.finish(callId, userId, 'missed');
    const user = userModel.find(userId);
    if (user && user.invitedTo === callId) {
      user.invitedTo = null;
      this.io.to(user.channel).emit('call:cancelled', { callId, reason: 'no answer' });
    }
    pushService.notify(userId, missedCallPush(invite.by));
    this.eachParticipant(call, (p) => this.io.to(userModel.callTarget(p)).emit('call:rejected', { callId, from: userId, reason: 'no answer' }));

    if (!this.endIfEmpty(call)) this.emitUpdate(call);
    this.broadcastUsers();
  }

  private leave(user: OnlineUser | undefined, reason: string): void {
    if (!user?.callId) return;
    const call = callModel.get(user.callId);
    user.callId = null;
    user.callSocketId = null;
    this.sendElsewhere(user);
    if (call) {
      call.participants.delete(user.id);
      this.eachParticipant(call, (p) =>
        this.io.to(userModel.callTarget(p)).emit('call:peer-left', { callId: call.id, userId: user.id, reason }),
      );
      // Others are still there: they wait a minute in case we come back (dropped connection,
      // wrong button). Our history entry stays open until then.
      if (call.participants.size > 0) this.allowRejoin(call, user);
      else callHistory.finish(call.id, user.id, 'cancelled');
      if (!this.endIfEmpty(call)) this.emitUpdate(call);
    }
    this.broadcastUsers();
  }

  /**
   * A call ends when nobody is left to talk to: no participants, or (for invite-only
   * calls) a single participant with nobody still ringing. Call rooms stay open while
   * anyone is in them, so others can still join by ID. Pending invites are cancelled.
   * @returns whether the call was ended.
   */
  private endIfEmpty(call: Call): boolean {
    // Someone who just left may still come back: an invite-only call waits for them.
    const alone = call.roomId === null && call.participants.size === 1 && call.invited.size === 0 && call.recent.size === 0;
    if (call.participants.size > 0 && !alone) return false;

    for (const id of call.participants) callHistory.finish(call.id, id, 'unanswered');
    this.eachParticipant(call, (p) => {
      this.io.to(userModel.callTarget(p)).emit('call:ended', { callId: call.id, reason: 'everyone else left' });
      p.callId = null;
      p.callSocketId = null;
      this.sendElsewhere(p);
    });
    for (const userId of call.recent.keys()) {
      this.clearRejoinTimer(call.id, userId);
      callHistory.finish(call.id, userId, 'cancelled');
      this.tellRejoinOver(call, userId);
    }
    call.recent.clear();
    for (const [userId, invite] of call.invited) {
      this.clearInviteTimer(call.id, userId);
      callHistory.finish(call.id, userId, 'missed');
      const user = userModel.find(userId);
      if (user && user.invitedTo === call.id) {
        user.invitedTo = null;
        this.io.to(user.channel).emit('call:cancelled', { callId: call.id, reason: 'caller hung up' });
      }
      pushService.notify(userId, missedCallPush(invite.by));
    }
    callModel.delete(call.id);
    return true;
  }

  // ---- Helpers ----

  /** Passes signaling to `to`'s call device, if they're in the sender's call. */
  private relay(sender: OnlineUser | undefined, to: unknown, send: (target: string, from: string) => void): void {
    if (!sender?.callId || typeof to !== 'string') return;
    const target = userModel.find(to);
    if (target && target.id !== sender.id && target.callId === sender.callId) send(userModel.callTarget(target), sender.id);
  }

  private eachParticipant(call: Call, fn: (user: OnlineUser) => void, exceptId?: string): void {
    for (const id of call.participants) {
      if (id === exceptId) continue;
      const user = userModel.find(id);
      if (user) fn(user);
    }
  }

  private emitUpdate(call: Call): void {
    const state = {
      callId: call.id,
      roomId: call.roomId,
      participants: [...call.participants],
      invited: [...call.invited.keys()],
      away: [...call.recent.keys()],
      video: call.video,
    };
    this.eachParticipant(call, (p) => {
      this.io.to(userModel.callTarget(p)).emit('call:update', state);
      this.sendElsewhere(p);
    });
  }

  /** The call `user` is in, as their other devices see it (null: none). */
  private elsewhere(user: OnlineUser): CallElsewhere | null {
    const call = callModel.get(user.callId);
    if (!call) return null;
    return { callId: call.id, roomId: call.roomId, participants: [...call.participants].filter((p) => p !== user.id), video: call.video };
  }

  /** Keeps the user's other devices (those not in the call) told about the call they're in. */
  private sendElsewhere(user: OnlineUser): void {
    if (user.sockets.size < 2 && user.callSocketId) return; // no other device to tell
    const others = user.callSocketId ? this.io.to(user.channel).except(user.callSocketId) : this.io.to(user.channel);
    others.emit('call:elsewhere', this.elsewhere(user));
  }

  private clearInviteTimer(callId: string, userId: string): void {
    const key = `${callId}|${userId}`;
    const timer = this.inviteTimers.get(key);
    if (timer) clearTimeout(timer);
    this.inviteTimers.delete(key);
  }
}
