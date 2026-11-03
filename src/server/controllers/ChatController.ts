import { isValidRoomId, MAX_MESSAGE_LENGTH, ROOM_ID_RULES } from '../../shared/validation';
import { roomModel } from '../models/RoomModel';
import { roomSettingsModel } from '../models/RoomSettingsModel';
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
      this.pushToMembers(message.roomId, userId, text);
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
  private pushToMembers(roomId: string, from: string, text: string): void {
    const body = text.length > 120 ? `${text.slice(0, 117)}…` : text;
    const recipients = new Set([...roomModel.members(roomId), ...roomModel.followersOf(roomId)]);
    for (const member of recipients) {
      if (member === from) continue;
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
