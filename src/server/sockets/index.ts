import { CONNECT_ERRORS, USER_STATUSES } from '../../shared/types';
import { CallController } from '../controllers/CallController';
import { ChatController } from '../controllers/ChatController';
import { EmojiController } from '../controllers/EmojiController';
import { FriendController } from '../controllers/FriendController';
import { RoomController } from '../controllers/RoomController';
import { SignalingController } from '../controllers/SignalingController';
import { sessionUserId } from '../middleware/session';
import { callHistoryModel } from '../models/CallHistoryModel';
import { MAX_AVATAR_BYTES } from '../../shared/validation';
import { avatarModel } from '../models/AvatarModel';
import { userModel } from '../models/UserModel';
import { decodeImage } from '../services/images';
import { userStatusModel } from '../models/UserStatusModel';
import { appVersion } from '../services/AppVersion';
import { roomDirectory } from '../services/RoomDirectory';
import { listDirectory } from '../services/UserDirectory';
import type { AppServer } from './types';
import { safeAck } from './util';

export function registerSocketHandlers(io: AppServer): void {
  const signaling = new SignalingController(io);
  const chat = new ChatController(io);
  const friends = new FriendController(io);
  const rooms = new RoomController(io);
  const emoji = new EmojiController(io);
  CallController.signaling = signaling;
  roomDirectory.init(io);

  // Handshake: the session cookie decides who this socket is; one connection per ID.
  io.use((socket, next) => {
    const userId = sessionUserId(socket.handshake.headers.cookie);
    if (!userId) return next(new Error(CONNECT_ERRORS.UNAUTHORIZED));
    const user = userModel.add(userId, socket.id);
    if (!user) return next(new Error(CONNECT_ERRORS.ID_TAKEN));
    socket.data.userId = user.id;
    next();
  });

  io.on('connection', (socket) => {
    const userId = socket.data.userId;
    console.log(`[socket] ${userId} connected`);

    // Every (re)connect — including the reconnect after a deploy restarts the server —
    // tells the page which front-end build is current, so stale pages can update.
    socket.emit('app:version', { version: appVersion() });
    emoji.register(socket); // before chat, so `:name:` in history renders on the first paint
    signaling.register(socket);
    chat.register(socket);
    friends.register(socket); // also sends this user's friends and requests
    rooms.register(socket);
    roomDirectory.sendTo(userId);
    socket.on('users:list', (ack) => safeAck(ack)({ ok: true, users: listDirectory() }));

    // Profile pictures (Settings).
    socket.emit('avatars:update', avatarModel.urls());
    socket.on('profile:avatar', (payload, rawAck) => {
      const ack = safeAck(rawAck);
      if (payload?.image === null) {
        avatarModel.remove(userId);
      } else {
        const image = decodeImage(payload?.image, MAX_AVATAR_BYTES);
        if (!image) return ack({ ok: false, error: 'That picture could not be used (PNG, WebP or GIF, under 256 KB)' });
        try {
          avatarModel.set(userId, image.type, image.data);
        } catch (err) {
          console.warn('[avatars] could not save', err);
          return ack({ ok: false, error: 'Could not save the picture' });
        }
      }
      ack({ ok: true });
      io.emit('avatars:update', avatarModel.urls());
    });

    // Status (Settings): online / idle / do not disturb / invisible.
    socket.emit('status:update', { status: userStatusModel.get(userId) });
    socket.on('status:set', (payload, rawAck) => {
      const ack = safeAck(rawAck);
      if (!USER_STATUSES.includes(payload?.status)) return ack({ ok: false, error: 'Unknown status' });
      userStatusModel.set(userId, payload.status);
      ack({ ok: true });
      signaling.broadcastUsers(); // everyone's lists (and room lists) show the new status
    });
    socket.on('history:list', (ack) => safeAck(ack)({ ok: true, entries: callHistoryModel.list(userId) }));
    socket.on('history:clear', (ack) => {
      callHistoryModel.clear(userId);
      safeAck(ack)({ ok: true });
    });
    socket.on('client:visibility', (payload) => {
      const user = userModel.find(userId);
      if (user && user.socketId === socket.id) user.visible = payload?.visible === true;
    });

    // A call may be ringing for this user already (the app was opened from a call notification).
    const user = userModel.find(userId);
    if (user) signaling.deliverPendingInvite(user);
    signaling.broadcastUsers();

    socket.on('disconnect', () => {
      const user = userModel.find(userId);
      if (user && user.socketId === socket.id) {
        user.visible = false; // gone: notifications must reach the device again
        signaling.handleDisconnect(user);
        chat.handleDisconnect(userId);
        userModel.remove(userId);
        signaling.broadcastUsers();
      }
      console.log(`[socket] ${userId} disconnected`);
    });
  });
}
