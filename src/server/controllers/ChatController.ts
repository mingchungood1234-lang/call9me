import { isValidRoomId, MAX_MESSAGE_LENGTH, mentionsIn, ROOM_ID_RULES } from '../../shared/validation';
import { accountModel } from '../models/AccountModel';
import { callModel } from '../models/CallModel';
import { roomModel } from '../models/RoomModel';
import { roomSettingsModel } from '../models/RoomSettingsModel';
import { stickerModel } from '../models/StickerModel';
import { userModel } from '../models/UserModel';
import { pushService } from '../services/PushService';
import { roomDirectory } from '../services/RoomDirectory';
import type { AppServer, AppSocket } from '../sockets/types';
import { safeAck } from '../sockets/util';

const channel = (roomId: string) => `room:${roomId}`;
const CHAT_PUSH_THROTTLE_MS = 15_000;

/** Chat rooms: anyone allowed in (see RoomDirectory: public, or a friend of the owner) can join and talk. */
export class ChatController {
  constructor(private readonly io: AppServer) {}

  register(socket: AppSocket): void {
    const userId = socket.data.userId;

    socket.on('chat:join', (payload, rawAck) => {
      const ack = safeAck(rawAck);
      if (!isValidRoomId(payload?.roomId)) return ack({ ok: false, error: `Invalid room ID. ${ROOM_ID_RULES}` });

      const roomId = roomModel.normalize(payload.roomId);
      const denied = roomDirectory.denyReason(roomId, userId, payload.key);
      if (denied) return ack({ ok: false, error: denied });
      roomSettingsModel.claim(roomId, userId); // first to use a new ID owns it (public by default)

      const alreadyMember = roomModel.isMember(roomId, userId);
      roomModel.join(roomId, userId);
      roomModel.follow(roomId, userId);
      socket.join(channel(roomId));

      ack({ ok: true, roomId, history: roomModel.history(roomId), members: roomModel.members(roomId) });
      if (!alreadyMember) {
        const notice = roomModel.addMessage(roomId, userId, `${userId} joined`, true);
        socket.to(channel(roomId)).emit('chat:message', notice);
      }
      this.emitMembers(roomId);
      roomDirectory.changed();
    });

    // Leaving on purpose also stops notifications; disconnecting (app closed) doesn't.
    socket.on('chat:leave', (payload) => {
      if (!isValidRoomId(payload?.roomId)) return;
      socket.leave(channel(roomModel.normalize(payload.roomId)));
      this.leave(payload.roomId, userId);
      roomModel.unfollow(payload.roomId, userId);
      roomDirectory.changed();
    });

    socket.on('chat:message', (payload, rawAck) => {
      const ack = safeAck(rawAck);
      if (!isValidRoomId(payload?.roomId) || !roomModel.isMember(payload.roomId, userId)) {
        return ack({ ok: false, error: 'Join the room before sending messages' });
      }
      const text = typeof payload.text === 'string' ? payload.text.trim() : '';
      if (!text) return ack({ ok: false, error: 'Message is empty' });
      if (text.length > MAX_MESSAGE_LENGTH) {
        return ack({ ok: false, error: `Message is longer than ${MAX_MESSAGE_LENGTH} characters` });
      }
      const message = roomModel.addMessage(payload.roomId, userId, text);
      this.io.to(channel(message.roomId)).emit('chat:message', message);
      ack({ ok: true });
      const tagged = this.notifyMentions(message.roomId, userId, text);
      this.pushToMembers(message.roomId, userId, text, tagged);
    });

    // A sticker from our own collection, posted big in the room.
    socket.on('chat:sticker', (payload, rawAck) => {
      const ack = safeAck(rawAck);
      if (!isValidRoomId(payload?.roomId) || !roomModel.isMember(payload.roomId, userId)) {
        return ack({ ok: false, error: 'Join the room before sending stickers' });
      }
      const url = typeof payload.stickerId === 'string' ? stickerModel.urlOf(userId, payload.stickerId) : undefined;
      if (!url) return ack({ ok: false, error: 'That sticker no longer exists' });
      const message = roomModel.addMessage(payload.roomId, userId, '', false, url);
      this.io.to(channel(message.roomId)).emit('chat:message', message);
      ack({ ok: true });
      this.pushToMembers(message.roomId, userId, 'sent a sticker');
    });

    // Leaving for good: the chat, its notifications and our membership.
    socket.on('rooms:leave', (payload, rawAck) => {
      const ack = safeAck(rawAck);
      if (!isValidRoomId(payload?.roomId)) return ack({ ok: false, error: `Invalid room ID. ${ROOM_ID_RULES}` });
      const roomId = roomModel.normalize(payload.roomId);
      socket.leave(channel(roomId));
      this.leave(roomId, userId);
      roomModel.unfollow(roomId, userId);
      const settings = roomSettingsModel.get(roomId);
      if (settings) roomSettingsModel.removeMember(settings, userId);
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
      if (callModel.findByRoom(settings.id)) {
        return ack({ ok: false, error: `A call is going on in #${settings.id}. Delete it once the call ends.` });
      }
      const room = channel(settings.id);
      this.io.to(room).emit('chat:deleted', { roomId: settings.id, by: userId });
      this.io.in(room).socketsLeave(room);
      roomModel.deleteRoom(settings.id);
      roomSettingsModel.remove(settings.id);
      ack({ ok: true });
      roomDirectory.changed();
    });
  }

  handleDisconnect(userId: string): void {
    for (const roomId of roomModel.roomsOf(userId)) this.leave(roomId, userId);
    roomDirectory.changed();
  }

  private leave(roomId: string, userId: string): void {
    if (!roomModel.isMember(roomId, userId)) return;
    const notice = roomModel.addMessage(roomId, userId, `${userId} left`, true);
    roomModel.leave(roomId, userId);
    this.io.to(channel(notice.roomId)).emit('chat:message', notice);
    this.emitMembers(notice.roomId);
  }

  /**
   * Notifications for everyone in or following the room (including users whose app is
   * closed), at most one per room every few seconds. The service worker skips it when
   * the app is on screen.
   */
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
      if (user) this.io.to(user.socketId).emit('chat:mention', { from, roomId, text: body });
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

  /** `skip`: lowercased IDs already notified (e.g. by a mention). */
  private pushToMembers(roomId: string, from: string, text: string, skip: Set<string> = new Set()): void {
    const body = text.length > 120 ? `${text.slice(0, 117)}…` : text;
    const recipients = new Set([...roomModel.members(roomId), ...roomModel.followersOf(roomId)]);
    for (const member of recipients) {
      if (member === from || skip.has(member.toLowerCase())) continue;
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
