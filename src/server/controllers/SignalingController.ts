import type { Ack, IceCandidate, PushPayload, SessionDescription } from '../../shared/types';
import { isValidRoomId, ROOM_ID_RULES } from '../../shared/validation';
import { config } from '../config';
import { accountModel } from '../models/AccountModel';
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
  return { type: 'missed-call', title: 'Missed call', body: `${from} tried to call you`, tag: `call-${from}`, url: '/app' };
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
  };
}

/**
 * Group call setup + WebRTC signaling relay (full mesh).
 *
 * Calls hold participants and pending invites. When someone accepts, they send an
 * offer to every existing participant; offers/answers/ICE are relayed only between
 * members of the same call. The server never touches media.
 */
export class SignalingController {
  /** "callId|userId" → ring timeout */
  private readonly inviteTimers = new Map<string, NodeJS.Timeout>();

  constructor(private readonly io: AppServer) {
    callHistory.onEntry = (userId, entry) => {
      const user = userModel.find(userId);
      if (user) this.io.to(user.socketId).emit('history:new', entry);
    };
  }

  register(socket: AppSocket): void {
    const me = () => userModel.find(socket.data.userId);

    socket.on('call:invite', (payload, ack) => this.invite(me(), payload, safeAck(ack)));
    socket.on('call:join-room', (payload, ack) => this.joinRoom(me(), payload, safeAck(ack)));
    socket.on('call:accept', (payload, ack) =>
      this.accept(me(), payload?.callId, payload?.video !== false, safeAck(ack)),
    );
    socket.on('call:reject', (payload) => {
      const user = me();
      const reason = typeof payload?.reason === 'string' ? payload.reason.slice(0, 100) : 'declined';
      if (user) this.declineInvite(user.id, payload?.callId, reason);
    });
    socket.on('call:leave', () => this.leave(me(), 'left'));
    socket.on('call:screen', (payload) => {
      const user = me();
      const call = user && callModel.get(user.callId);
      if (!user || !call) return;
      const sharing = payload?.sharing === true;
      this.eachParticipant(call, (p) => this.io.to(p.socketId).emit('call:screen', { from: user.id, sharing }), user.id);
    });
    socket.on('call:camera', (payload) => {
      const user = me();
      const call = user && callModel.get(user.callId);
      if (!user || !call) return;
      const on = payload?.on === true;
      this.eachParticipant(call, (p) => this.io.to(p.socketId).emit('call:camera', { from: user.id, on }), user.id);
    });

    socket.on('webrtc:offer', (payload) => {
      if (!isSessionDescription(payload?.sdp, 'offer')) return;
      this.relay(me(), payload.to, (to, from) => this.io.to(to.socketId).emit('webrtc:offer', { from, sdp: payload.sdp }));
    });
    socket.on('webrtc:answer', (payload) => {
      if (!isSessionDescription(payload?.sdp, 'answer')) return;
      this.relay(me(), payload.to, (to, from) => this.io.to(to.socketId).emit('webrtc:answer', { from, sdp: payload.sdp }));
    });
    socket.on('webrtc:ice', (payload) => {
      if (!isIceCandidate(payload?.candidate)) return;
      this.relay(me(), payload.to, (to, from) =>
        this.io.to(to.socketId).emit('webrtc:ice', { from, candidate: payload.candidate }),
      );
    });
  }

  /**
   * Leaves any call when a user disconnects. A ringing invite keeps ringing via push
   * if the user has notifications on (phone locked / app closed); otherwise it's declined.
   */
  handleDisconnect(user: OnlineUser): void {
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
    this.leave(user, 'disconnected');
  }

  /** On (re)connect, hand the app any call still ringing for this user — e.g. opened from a call notification. */
  deliverPendingInvite(user: OnlineUser): void {
    const call = callModel.findInviteFor(user.id);
    const invite = call?.invited.get(user.id);
    if (!call || !invite) return;
    user.invitedTo = call.id;
    this.io.to(user.socketId).emit('call:incoming', {
      callId: call.id,
      roomId: call.roomId,
      from: invite.by,
      video: call.video,
      participants: [...call.participants],
    });
  }

  /**
   * Declines a ringing invite. Works for offline users too (the notification's Decline
   * button calls this over HTTP). @returns whether there was an invite to decline.
   */
  declineInvite(userId: string, callId: unknown, reason: string): boolean {
    if (typeof callId !== 'string') return false;
    const user = userModel.find(userId);
    if (user?.invitedTo === callId) user.invitedTo = null;

    const call = callModel.get(callId);
    if (!call?.invited.delete(userId)) return false;
    this.clearInviteTimer(callId, userId);
    if (reason === 'declined') callHistory.declined(call, userId);
    callHistory.finish(callId, userId, reason === 'declined' ? 'declined' : 'missed');

    this.eachParticipant(call, (p) => this.io.to(p.socketId).emit('call:rejected', { callId, from: userId, reason }));
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
    payload: { to: string; video: boolean },
    ack: Ack<{ callId: string; to: string; offline: boolean }>,
  ): void {
    if (!caller) return ack({ ok: false, error: 'Not registered' });
    if (caller.invitedTo) return ack({ ok: false, error: 'Answer or decline your incoming call first' });

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
      this.io.to(target.socketId).emit('call:incoming', {
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
    payload: { roomId: string; video: boolean; key?: string },
    ack: Ack<{ callId: string; roomId: string; participants: string[]; video: boolean }>,
  ): void {
    if (!user) return ack({ ok: false, error: 'Not registered' });
    if (!isValidRoomId(payload?.roomId)) return ack({ ok: false, error: `Invalid room ID. ${ROOM_ID_RULES}` });
    if (user.invitedTo) return ack({ ok: false, error: 'Answer or decline your incoming call first' });
    if (user.callId) return ack({ ok: false, error: 'Leave your current call first' });

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
    callHistory.join(call, user.id, video);

    const callId = call.id;
    this.eachParticipant(call, (p) => this.io.to(p.socketId).emit('call:peer-joined', { callId, userId: user.id }), user.id);
    // Like accepting an invite: the newcomer sends an offer to each existing participant.
    ack({ ok: true, callId, roomId: call.roomId!, participants: existing, video: call.video });
    this.emitUpdate(call);
    this.broadcastUsers();
  }

  private accept(
    user: OnlineUser | undefined,
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
    callHistory.join(call, user.id, video);

    this.eachParticipant(call, (p) => this.io.to(p.socketId).emit('call:peer-joined', { callId, userId: user.id }), user.id);
    // The newcomer sends an offer to each existing participant.
    ack({ ok: true, callId, participants: existing, video: call.video });
    this.emitUpdate(call);
    this.broadcastUsers();
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
      this.io.to(user.socketId).emit('call:cancelled', { callId, reason: 'no answer' });
    }
    pushService.notify(userId, missedCallPush(invite.by));
    this.eachParticipant(call, (p) => this.io.to(p.socketId).emit('call:rejected', { callId, from: userId, reason: 'no answer' }));

    if (!this.endIfEmpty(call)) this.emitUpdate(call);
    this.broadcastUsers();
  }

  private leave(user: OnlineUser | undefined, reason: string): void {
    if (!user?.callId) return;
    const call = callModel.get(user.callId);
    user.callId = null;
    if (call) {
      call.participants.delete(user.id);
      callHistory.finish(call.id, user.id, 'cancelled');
      this.eachParticipant(call, (p) =>
        this.io.to(p.socketId).emit('call:peer-left', { callId: call.id, userId: user.id, reason }),
      );
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
    const alone = call.roomId === null && call.participants.size === 1 && call.invited.size === 0;
    if (call.participants.size > 0 && !alone) return false;

    for (const id of call.participants) callHistory.finish(call.id, id, 'unanswered');
    this.eachParticipant(call, (p) => {
      p.callId = null;
      this.io.to(p.socketId).emit('call:ended', { callId: call.id, reason: 'everyone else left' });
    });
    for (const [userId, invite] of call.invited) {
      this.clearInviteTimer(call.id, userId);
      callHistory.finish(call.id, userId, 'missed');
      const user = userModel.find(userId);
      if (user && user.invitedTo === call.id) {
        user.invitedTo = null;
        this.io.to(user.socketId).emit('call:cancelled', { callId: call.id, reason: 'caller hung up' });
      }
      pushService.notify(userId, missedCallPush(invite.by));
    }
    callModel.delete(call.id);
    return true;
  }

  // ---- Helpers ----

  private relay(sender: OnlineUser | undefined, to: unknown, send: (target: OnlineUser, from: string) => void): void {
    if (!sender?.callId || typeof to !== 'string') return;
    const target = userModel.find(to);
    if (target && target.id !== sender.id && target.callId === sender.callId) send(target, sender.id);
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
      video: call.video,
    };
    this.eachParticipant(call, (p) => this.io.to(p.socketId).emit('call:update', state));
  }

  private clearInviteTimer(callId: string, userId: string): void {
    const key = `${callId}|${userId}`;
    const timer = this.inviteTimers.get(key);
    if (timer) clearTimeout(timer);
    this.inviteTimers.delete(key);
  }
}
