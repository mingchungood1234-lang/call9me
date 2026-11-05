import { CONNECT_ERRORS, USER_STATUSES } from '../../shared/types';
import { CallController } from '../controllers/CallController';
import { ChatController } from '../controllers/ChatController';
import { EmojiController } from '../controllers/EmojiController';
import { FriendController } from '../controllers/FriendController';
import { StickerController } from '../controllers/StickerController';
import { RoomController } from '../controllers/RoomController';
import { SignalingController } from '../controllers/SignalingController';
import { sessionUserId } from '../middleware/session';
import { callHistoryModel } from '../models/CallHistoryModel';
import { MAX_AVATAR_BYTES } from '../../shared/validation';
import { avatarModel } from '../models/AvatarModel';
import { userChannel, userModel } from '../models/UserModel';
import { decodeImage } from '../services/images';
import { userStatusModel } from '../models/UserStatusModel';
import { appVersion } from '../services/AppVersion';
import { roomDirectory } from '../services/RoomDirectory';
import { listDirectory } from '../services/UserDirectory';
import { applyRateLimits } from './rateLimits';
import type { AppServer } from './types';
import { safeAck } from './util';

export function registerSocketHandlers(io: AppServer): void {
  const signaling = new SignalingController(io);
  const chat = new ChatController(io);
  const friends = new FriendController(io);
  const rooms = new RoomController(io);
  const emoji = new EmojiController(io);
  const stickers = new StickerController(io);
  CallController.signaling = signaling;
  roomDirectory.init(io);

  // Handshake: the session cookie decides who this socket is. An ID can be open on a few devices at once.
  io.use((socket, next) => {
    const userId = sessionUserId(socket.handshake.headers.cookie);
    if (!userId) return next(new Error(CONNECT_ERRORS.UNAUTHORIZED));
    const user = userModel.add(userId, socket.id);
    if (!user) return next(new Error(CONNECT_ERRORS.TOO_MANY_DEVICES));
    socket.data.userId = user.id;
    next();
  });

  io.on('connection', (socket) => {
    const userId = socket.data.userId;
    const firstDevice = userModel.find(userId)?.sockets.size === 1;
    console.log(`[socket] ${userId} connected (${userModel.find(userId)?.sockets.size ?? 0} device(s))`);
    socket.join(userChannel(userId)); // everything sent "to this user" reaches all of their devices
    applyRateLimits(socket);

    // Every (re)connect — including the reconnect after a deploy restarts the server —
    // tells the page which front-end build is current, so stale pages can update.
    socket.emit('app:version', { version: appVersion() });
    emoji.register(socket); // before chat, so `:name:` in history renders on the first paint
    stickers.register(socket);
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
      if (!user) return;
      if (payload?.visible === true) user.visibleSockets.add(socket.id);
      else user.visibleSockets.delete(socket.id);
    });

    // A call may be ringing for this user already (the app was opened from a call notification).
    const user = userModel.find(userId);
    if (user) {
      signaling.deliverPendingInvite(user, socket.id);
      signaling.sendElsewhereTo(user, socket.id); // in a call on another device: offer to move it here
      signaling.sendRejoinableTo(user, socket.id); // dropped out of a call a moment ago: offer to rejoin
    }
    // The people list (who's online, which offline friends can be rung): everyone needs it
    // when we come online; another device of ours only needs it itself.
    if (firstDevice) signaling.broadcastUsers();
    else socket.emit('users:update', listDirectory());

    socket.on('disconnect', () => {
      const user = userModel.find(userId);
      if (user) {
        // Forget this device first, so notifications reach the others again if it was the visible one.
        const wasLast = userModel.removeSocket(userId, socket.id);
        signaling.handleDisconnect(user, socket.id, wasLast);
        if (wasLast) {
          chat.handleDisconnect(userId);
          signaling.broadcastUsers();
        }
      }
      console.log(`[socket] ${userId} disconnected`);
    });
  });
}
