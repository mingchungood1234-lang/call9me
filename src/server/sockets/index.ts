import { CONNECT_ERRORS } from '../../shared/types';
import { CallController } from '../controllers/CallController';
import { ChatController } from '../controllers/ChatController';
import { SignalingController } from '../controllers/SignalingController';
import { sessionUserId } from '../middleware/session';
import { callHistoryModel } from '../models/CallHistoryModel';
import { userModel } from '../models/UserModel';
import { appVersion } from '../services/AppVersion';
import { listDirectory } from '../services/UserDirectory';
import type { AppServer } from './types';
import { safeAck } from './util';

export function registerSocketHandlers(io: AppServer): void {
  const signaling = new SignalingController(io);
  const chat = new ChatController(io);
  CallController.signaling = signaling;

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
    signaling.register(socket);
    chat.register(socket);
    socket.on('users:list', (ack) => safeAck(ack)({ ok: true, users: listDirectory() }));
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
