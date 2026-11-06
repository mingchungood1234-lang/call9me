import type { ChatRoomPreview } from '../../shared/types';
import { isValidRoomId, MAX_MESSAGE_LENGTH, mentionsIn, PUBLIC_ROOM_ID, ROOM_ID_RULES } from '../../shared/validation';
import { isAdmin } from '../config';
import { accountModel } from '../models/AccountModel';
import { callModel } from '../models/CallModel';
import { pushSubscriptionModel } from '../models/PushSubscriptionModel';
import { roomModel } from '../models/RoomModel';
import { roomSettingsModel, type RoomSettings } from '../models/RoomSettingsModel';
import { stickerModel } from '../models/StickerModel';
import { userChannel, userModel } from '../models/UserModel';
import { userStatusModel } from '../models/UserStatusModel';
import { pushService } from '../services/PushService';
import { roomDirectory } from '../services/RoomDirectory';
import type { AppServer, AppSocket } from '../sockets/types';
import { safeAck } from '../sockets/util';

const channel = (roomId: string) => `room:${roomId}`;
const CHAT_PUSH_THROTTLE_MS = 15_000;
/** Messages shown in a room's preview before joining it. */
const PREVIEW_MESSAGES = 8;
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/**
 * Chat rooms. Joining a room puts it in your chat list (you "follow" it) until you leave
 * it; you get its messages live in the list, even while another room is open. "Members"
 * are the people viewing a room's conversation right now. Anyone allowed in (see
 * RoomDirectory) can join and talk. The Public chat is in everyone's list; only admins post.
 */
export class ChatController {
  constructor(private readonly io: AppServer) {}

  register(socket: AppSocket): void {
    const userId = socket.data.userId;

    // Live messages from every room in our list, plus the chat list itself.
    for (const roomId of [PUBLIC_ROOM_ID, ...roomModel.followedBy(userId)]) socket.join(channel(roomId));
    socket.emit('chat:rooms', this.chatList(userId));

    // Opens a room's conversation (joining the room first if it isn't in our list yet).
    socket.on('chat:join', (payload, rawAck) => {
      const ack = safeAck(rawAck);
      if (!isValidRoomId(payload?.roomId)) return ack({ ok: false, error: `Invalid room ID. ${ROOM_ID_RULES}` });

      const roomId = roomModel.normalize(payload.roomId);
      const isPublic = roomId === PUBLIC_ROOM_ID;
      if (!isPublic) {
        const denied = roomDirectory.denyReason(roomId, userId, payload.key);
        if (denied) return ack({ ok: false, error: denied });
        roomSettingsModel.claim(roomId, userId); // first to use a new ID owns it (public by default)
      }

      // Everyone is always in the Public chat; other rooms are joined once, then stay in the list.
      const newlyJoined = !isPublic && !roomModel.isFollower(roomId, userId);
      roomModel.join(roomId, userId);
      if (!isPublic) {
        roomModel.follow(roomId, userId);
        // Joined for good: they keep access even if the room is made private or link-only later.
        roomSettingsModel.addMember(roomSettingsModel.claim(roomId, userId), userId);
      }
      roomModel.markRead(userId, roomId);
      // All our devices get the room's live messages, not just this one.
      this.io.in(userChannel(userId)).socketsJoin(channel(roomId));

      ack({ ok: true, roomId, history: roomModel.history(roomId), members: roomModel.members(roomId) });
      if (newlyJoined) {
        const notice = roomModel.addMessage(roomId, userId, `${userId} joined`, true);
        socket.to(channel(roomId)).emit('chat:message', notice);
        this.syncList(socket, userId);
      }
      this.emitMembers(roomId);
      roomDirectory.changed();
    });

    // What a room looks like before joining: its listing and latest messages. Grants nothing.
    socket.on('chat:preview', (payload, rawAck) => {
      const ack = safeAck(rawAck);
      if (!isValidRoomId(payload?.roomId)) return ack({ ok: false, error: `Invalid room ID. ${ROOM_ID_RULES}` });
      const settings = roomSettingsModel.get(payload.roomId);
      if (!settings) return ack({ ok: true, room: null, recent: [] });
      const denied = roomDirectory.denyReason(settings.id, userId, payload.key, false);
      if (denied) return ack({ ok: false, error: denied });
      const recent = roomModel.messagesOf(settings.id).filter((m) => !m.system).slice(-PREVIEW_MESSAGES);
      roomModel.release(settings.id); // loaded only for this peek
      ack({ ok: true, room: roomDirectory.summary(settings, userId), recent });
    });

    // Pin / mute / archive a room in our list. The Public chat can only be muted.
    socket.on('chat:prefs', (payload, rawAck) => {
      const ack = safeAck(rawAck);
      if (!isValidRoomId(payload?.roomId)) return ack({ ok: false, error: `Invalid room ID. ${ROOM_ID_RULES}` });
      const roomId = roomModel.normalize(payload.roomId);
      const isPublic = roomId === PUBLIC_ROOM_ID;
      if (!isPublic && !roomModel.isFollower(roomId, userId)) return ack({ ok: false, error: `Join #${roomId} first` });
      const flag = (value: unknown) => (typeof value === 'boolean' ? value : undefined);
      roomModel.setPrefs(userId, roomId, {
        muted: flag(payload.muted),
        pinned: isPublic ? undefined : flag(payload.pinned),
        archived: isPublic ? undefined : flag(payload.archived),
      });
      ack({ ok: true });
      this.syncList(socket, userId);
    });

    // Back to the chat list: no longer viewing, but still in the room (and its messages).
    socket.on('chat:close', (payload) => {
      if (!isValidRoomId(payload?.roomId)) return;
      this.stopViewing(roomModel.normalize(payload.roomId), userId);
    });

    socket.on('chat:read', (payload) => {
      if (isValidRoomId(payload?.roomId)) roomModel.markRead(userId, payload.roomId);
    });

    // Older clients: closing a room also took it off their list (but they stay a member).
    socket.on('chat:leave', (payload) => {
      if (!isValidRoomId(payload?.roomId) || roomModel.normalize(payload.roomId) === PUBLIC_ROOM_ID) return;
      this.leaveRoom(socket, roomModel.normalize(payload.roomId), userId, false);
    });

    socket.on('chat:message', (payload, rawAck) => {
      const ack = safeAck(rawAck);
      const denied = this.cannotPost(payload?.roomId, userId);
      if (denied) return ack({ ok: false, error: denied });
      const text = typeof payload.text === 'string' ? payload.text.trim() : '';
      if (!text) return ack({ ok: false, error: 'Message is empty' });
      if (text.length > MAX_MESSAGE_LENGTH) {
        return ack({ ok: false, error: `Message is longer than ${MAX_MESSAGE_LENGTH} characters` });
      }
      const message = roomModel.addMessage(payload.roomId, userId, text);
      roomModel.markRead(userId, message.roomId);
      this.io.to(channel(message.roomId)).emit('chat:message', message);
      ack({ ok: true });
      const tagged = this.notifyMentions(message.roomId, userId, text);
      this.pushToMembers(message.roomId, userId, text, tagged);
    });

    // "Alice is typing…" for the others in the room. Invisible users never show up typing
    // ("stopped" still goes through; one already shown expires on its own within seconds).
    socket.on('chat:typing', (payload) => {
      if (!isValidRoomId(payload?.roomId) || this.cannotPost(payload.roomId, userId)) return;
      const typing = payload.typing === true;
      if (typing && userStatusModel.get(userId) === 'invisible') return;
      const roomId = roomModel.normalize(payload.roomId);
      socket.to(channel(roomId)).emit('chat:typing', { roomId, userId, typing });
    });

    // A sticker from our own collection, posted big in the room.
    socket.on('chat:sticker', (payload, rawAck) => {
      const ack = safeAck(rawAck);
      const denied = this.cannotPost(payload?.roomId, userId);
      if (denied) return ack({ ok: false, error: denied });
      const url = typeof payload.stickerId === 'string' ? stickerModel.urlOf(userId, payload.stickerId) : undefined;
      if (!url) return ack({ ok: false, error: 'That sticker no longer exists' });
      const message = roomModel.addMessage(payload.roomId, userId, '', false, url);
      roomModel.markRead(userId, message.roomId);
      this.io.to(channel(message.roomId)).emit('chat:message', message);
      ack({ ok: true });
      this.pushToMembers(message.roomId, userId, 'sent a sticker');
    });

    // Leaving for good: off our chat list, no more notifications, and our membership is gone.
    socket.on('rooms:leave', (payload, rawAck) => {
      const ack = safeAck(rawAck);
      if (!isValidRoomId(payload?.roomId)) return ack({ ok: false, error: `Invalid room ID. ${ROOM_ID_RULES}` });
      const roomId = roomModel.normalize(payload.roomId);
      if (roomId === PUBLIC_ROOM_ID) return ack({ ok: false, error: 'Everyone stays in the Public chat' });
      this.leaveRoom(socket, roomId, userId);
      ack({ ok: true });
    });

    // ---- The owner's controls: who's in the room, removing and banning people ----

    socket.on('rooms:members', (payload, rawAck) => {
      const ack = safeAck(rawAck);
      const settings = this.ownedRoom(payload?.roomId, userId);
      if (typeof settings === 'string') return ack({ ok: false, error: settings });
      const banned = [...(settings.banned ?? [])].sort((a, b) => a.localeCompare(b));
      ack({ ok: true, members: this.joinedMembers(settings), banned });
    });

    socket.on('rooms:remove-member', (payload, rawAck) => {
      const ack = safeAck(rawAck);
      const settings = this.ownedRoom(payload?.roomId, userId);
      if (typeof settings === 'string') return ack({ ok: false, error: settings });
      const target = typeof payload.userId === 'string' ? payload.userId : '';
      const error = this.removeMember(settings, target, payload.ban === true, userId);
      ack(error ? { ok: false, error } : { ok: true });
    });

    socket.on('rooms:unban', (payload, rawAck) => {
      const ack = safeAck(rawAck);
      const settings = this.ownedRoom(payload?.roomId, userId);
      if (typeof settings === 'string') return ack({ ok: false, error: settings });
      if (typeof payload.userId !== 'string' || !roomSettingsModel.unban(settings, payload.userId)) {
        return ack({ ok: false, error: `That person is not banned from #${settings.id}` });
      }
      ack({ ok: true });
      roomDirectory.changed();
    });

    // Only the owner can delete a room; everyone in its chat is moved out first.
    socket.on('rooms:delete', (payload, rawAck) => {
      const ack = safeAck(rawAck);
      const settings = isValidRoomId(payload?.roomId) ? roomSettingsModel.get(payload.roomId) : undefined;
      if (!settings) return ack({ ok: false, error: 'No such room' });
      if (settings.owner.toLowerCase() !== userId.toLowerCase()) {
        return ack({ ok: false, error: `Only ${settings.owner} can delete #${settings.id}` });
      }
      const error = this.deleteRoom(settings, userId);
      ack(error ? { ok: false, error } : { ok: true });
    });
  }

  /**
   * Takes `target` out of a room (`ban`: for good). Used by the room's owner and by admins
   * (`by`). @returns why not, or null.
   */
  removeMember(settings: RoomSettings, target: string, ban: boolean, by: string): string | null {
    if (!target || same(target, settings.owner)) return 'Choose someone else to remove';
    const wasIn = roomDirectory.hasJoined(settings, target);
    if (!wasIn && !ban) return `${target} is not in #${settings.id}`;

    if (ban) roomSettingsModel.ban(settings, target);
    else roomSettingsModel.removeMember(settings, target);
    const follower = roomModel.followersOf(settings.id).find((f) => same(f, target));
    if (follower) roomModel.unfollow(settings.id, follower);
    const viewer = roomModel.members(settings.id).find((m) => same(m, target));
    if (viewer) roomModel.leave(settings.id, viewer);
    const user = userModel.find(target);
    if (user) {
      this.io.in(user.channel).socketsLeave(channel(settings.id));
      this.io.to(user.channel).emit('chat:removed', { roomId: settings.id, by, banned: ban });
    }
    if (wasIn) {
      const notice = roomModel.addMessage(settings.id, by, `${target} was ${ban ? 'banned' : 'removed'}`, true);
      this.io.to(channel(settings.id)).emit('chat:message', notice);
    }
    this.emitMembers(settings.id);
    roomDirectory.changed();
    return null;
  }

  /** Deletes a room for everyone (not while its call is on). @returns why not, or null. */
  deleteRoom(settings: RoomSettings, by: string): string | null {
    if (callModel.findByRoom(settings.id)) return `A call is going on in #${settings.id}. Delete it once the call ends.`;
    const room = channel(settings.id);
    this.io.to(room).emit('chat:deleted', { roomId: settings.id, by });
    this.io.in(room).socketsLeave(room);
    roomModel.deleteRoom(settings.id);
    roomSettingsModel.remove(settings.id);
    roomDirectory.changed();
    return null;
  }

  /** An admin wipes a room's chat (the Public chat too); everyone in it sees it go. @returns messages removed. */
  clearHistory(roomId: string, by: string): number {
    const id = roomModel.normalize(roomId);
    const count = roomModel.clearHistory(id);
    this.io.to(channel(id)).emit('chat:cleared', { roomId: id });
    const notice = roomModel.addMessage(id, by, `Chat history was cleared by an admin`, true);
    this.io.to(channel(id)).emit('chat:message', notice);
    this.resendChatLists(id);
    return count;
  }

  /** Everyone gets the room's chat list again (after an admin cleared its history). */
  resendChatLists(roomId: string): void {
    for (const id of roomModel.followersOf(roomId)) {
      const user = userModel.find(id);
      if (user) this.io.to(user.channel).emit('chat:rooms', this.chatList(user.id));
    }
  }

  /** Closing the app just stops viewing; the rooms stay in the user's list. */
  handleDisconnect(userId: string): void {
    for (const roomId of roomModel.roomsOf(userId)) this.stopViewing(roomId, userId);
    roomDirectory.changed();
  }

  /** Public chat first, then our rooms by latest activity. */
  private chatList(userId: string): ChatRoomPreview[] {
    const preview = (id: string): ChatRoomPreview => {
      const messages = roomModel.messagesOf(id);
      return {
        id,
        lastMessage: [...messages].reverse().find((m) => !m.system) ?? messages.at(-1),
        unread: roomModel.unreadCount(id, userId),
        visibility: roomSettingsModel.get(id)?.visibility,
        ...roomModel.prefsOf(userId, id),
      };
    };
    const rooms = roomModel
      .followedBy(userId)
      .filter((id) => id !== PUBLIC_ROOM_ID)
      .map(preview)
      .sort((a, b) => (b.lastMessage?.timestamp ?? 0) - (a.lastMessage?.timestamp ?? 0));
    return [preview(PUBLIC_ROOM_ID), ...rooms];
  }

  /** @returns the room's settings if `userId` owns it, else why not. */
  private ownedRoom(roomId: unknown, userId: string): RoomSettings | string {
    const settings = isValidRoomId(roomId) ? roomSettingsModel.get(roomId) : undefined;
    if (!settings) return 'No such room';
    if (!same(settings.owner, userId)) return `Only ${settings.owner} can manage #${settings.id}`;
    return settings;
  }

  /** Everyone who belongs to the room besides its owner: members and followers, sorted. */
  private joinedMembers(settings: RoomSettings): string[] {
    const byKey = new Map<string, string>();
    for (const id of [...(settings.members ?? []), ...roomModel.followersOf(settings.id)]) {
      if (!same(id, settings.owner)) byKey.set(id.toLowerCase(), id);
    }
    return [...byKey.values()].sort((a, b) => a.localeCompare(b));
  }

  /** @returns why `userId` can't post in `roomId`, or null. */
  private cannotPost(roomId: unknown, userId: string): string | null {
    // Joined, or viewing it now: another of our devices may have closed the room meanwhile.
    const inRoom = isValidRoomId(roomId) && (roomModel.isMember(roomId, userId) || roomModel.isFollower(roomId, userId));
    if (!inRoom) return 'Open the room before sending messages';
    if (roomModel.normalize(roomId) === PUBLIC_ROOM_ID && !isAdmin(userId)) return 'Only admins can post in the Public chat';
    return null;
  }

  private stopViewing(roomId: string, userId: string): void {
    if (!roomModel.isMember(roomId, userId)) return;
    roomModel.leave(roomId, userId);
    this.emitMembers(roomId);
  }

  /** `dropMembership`: also give up access granted by an invite link or a share. */
  private leaveRoom(socket: AppSocket, roomId: string, userId: string, dropMembership = true): void {
    const wasIn = roomModel.isFollower(roomId, userId) || roomModel.isMember(roomId, userId);
    roomModel.leave(roomId, userId);
    if (wasIn) {
      const notice = roomModel.addMessage(roomId, userId, `${userId} left`, true);
      this.io.to(channel(roomId)).emit('chat:message', notice);
    }
    this.io.in(userChannel(userId)).socketsLeave(channel(roomId));
    roomModel.unfollow(roomId, userId);
    const settings = roomSettingsModel.get(roomId);
    if (settings && dropMembership) roomSettingsModel.removeMember(settings, userId);
    this.emitMembers(roomId);
    roomDirectory.changed();
    this.syncList(socket, userId);
  }

  /** Our other devices get the updated chat list (after joining, leaving or changing a room's options). */
  private syncList(socket: AppSocket, userId: string): void {
    socket.to(userChannel(userId)).emit('chat:rooms', this.chatList(userId));
  }

  /**
   * `@someone` in a message: they're told in the app and get a push (never throttled),
   * even if they're not in the room — but only if they're allowed in, so a private
   * room's messages never reach outsiders. @returns the IDs that were notified.
   */
  private notifyMentions(roomId: string, from: string, text: string): Set<string> {
    const notified = new Set<string>();
    const body = text.length > 140 ? `${text.slice(0, 137)}…` : text;
    for (const written of mentionsIn(text)) {
      const id = accountModel.canonicalId(written);
      if (!id || id.toLowerCase() === from.toLowerCase() || roomDirectory.denyReason(roomId, id)) continue;
      notified.add(id.toLowerCase());
      const user = userModel.find(id);
      if (user) this.io.to(user.channel).emit('chat:mention', { from, roomId, text: body });
      pushService.notify(id, {
        type: 'chat',
        title: `${from} mentioned you in #${roomId}`,
        body,
        tag: `mention-${roomId}-${Date.now()}`,
        url: `/app?room=${roomId}`,
      });
    }
    return notified;
  }

  /**
   * Notifications for everyone in the room (including users whose app is closed) who hasn't
   * muted it, at most one per room every few seconds; the service worker skips it when the
   * app is on screen.
   * Public chat posts (announcements) go to everyone, every time.
   * `skip`: lowercased IDs already notified (e.g. by a mention).
   */
  private pushToMembers(roomId: string, from: string, text: string, skip: Set<string> = new Set()): void {
    const body = text.length > 120 ? `${text.slice(0, 117)}…` : text;
    if (roomId === PUBLIC_ROOM_ID) {
      for (const id of pushSubscriptionModel.userIds()) {
        if (id.toLowerCase() === from.toLowerCase() || skip.has(id.toLowerCase()) || roomModel.isMuted(id, roomId)) continue;
        pushService.notify(id, {
          type: 'chat',
          title: `📢 Public chat · ${from}`,
          body,
          tag: `public-${Date.now()}`,
          url: `/app?room=${PUBLIC_ROOM_ID}`,
        });
      }
      return;
    }
    const recipients = new Set([...roomModel.members(roomId), ...roomModel.followersOf(roomId)]);
    for (const member of recipients) {
      if (member === from || skip.has(member.toLowerCase()) || roomModel.isMuted(member, roomId)) continue;
      pushService.notify(
        member,
        { type: 'chat', title: `#${roomId} · ${from}`, body, tag: `chat-${roomId}`, url: `/app?room=${roomId}` },
        { throttleMs: CHAT_PUSH_THROTTLE_MS },
      );
    }
  }

  private emitMembers(roomId: string): void {
    this.io.to(channel(roomId)).emit('chat:members', { roomId, members: roomModel.members(roomId) });
  }
}
