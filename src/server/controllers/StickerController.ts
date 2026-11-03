import { MAX_STICKER_BYTES } from '../../shared/validation';
import { stickerModel } from '../models/StickerModel';
import { userModel } from '../models/UserModel';
import { decodeImage } from '../services/images';
import type { AppServer, AppSocket } from '../sockets/types';
import { safeAck } from '../sockets/util';

const MAX_STICKERS_PER_USER = 60;

/** Each user's own sticker collection (add from a picture, remove); sending is a chat message. */
export class StickerController {
  constructor(private readonly io: AppServer) {}

  register(socket: AppSocket): void {
    const userId = socket.data.userId;
    socket.emit('stickers:update', stickerModel.list(userId));

    socket.on('stickers:add', (payload, rawAck) => {
      const ack = safeAck(rawAck);
      if (stickerModel.count(userId) >= MAX_STICKERS_PER_USER) {
        return ack({ ok: false, error: `You can keep up to ${MAX_STICKERS_PER_USER} stickers. Remove one first.` });
      }
      const image = decodeImage(payload?.image, MAX_STICKER_BYTES);
      if (!image) return ack({ ok: false, error: 'That picture could not be used (PNG, WebP or GIF, under 256 KB)' });
      try {
        const sticker = stickerModel.add(userId, image.type, image.data);
        ack({ ok: true, sticker });
      } catch (err) {
        console.warn('[stickers] could not save', err);
        return ack({ ok: false, error: 'Could not save the sticker' });
      }
      this.sendList(userId);
    });

    socket.on('stickers:remove', (payload, rawAck) => {
      const ack = safeAck(rawAck);
      if (typeof payload?.id !== 'string' || !stickerModel.remove(userId, payload.id)) {
        return ack({ ok: false, error: 'No such sticker' });
      }
      ack({ ok: true });
      this.sendList(userId);
    });
  }

  private sendList(userId: string): void {
    const user = userModel.find(userId);
    if (user) this.io.to(user.socketId).emit('stickers:update', stickerModel.list(userId));
  }
}
