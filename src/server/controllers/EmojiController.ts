import { EMOJI_NAME_RULES, isValidEmojiName, MAX_EMOJI_BYTES } from '../../shared/validation';
import { emojiModel } from '../models/EmojiModel';
import { decodeImage } from '../services/images';
import type { AppServer, AppSocket } from '../sockets/types';
import { safeAck } from '../sockets/util';

const MAX_EMOJI_TOTAL = 300;
const MAX_EMOJI_PER_USER = 40;

/** Custom emoji made from pictures: anyone can add some; everyone can use them as `:name:`. */
export class EmojiController {
  constructor(private readonly io: AppServer) {}

  register(socket: AppSocket): void {
    const userId = socket.data.userId;
    socket.emit('emoji:update', emojiModel.list());

    socket.on('emoji:add', (payload, rawAck) => {
      const ack = safeAck(rawAck);
      const name = typeof payload?.name === 'string' ? payload.name.toLowerCase() : '';
      if (!isValidEmojiName(name)) return ack({ ok: false, error: `Invalid name. ${EMOJI_NAME_RULES}` });
      if (emojiModel.has(name)) return ack({ ok: false, error: `:${name}: already exists. Pick another name.` });
      if (emojiModel.count() >= MAX_EMOJI_TOTAL) return ack({ ok: false, error: 'The emoji collection is full' });
      if (emojiModel.count(userId) >= MAX_EMOJI_PER_USER) {
        return ack({ ok: false, error: `You can add up to ${MAX_EMOJI_PER_USER} emoji. Remove one first.` });
      }
      const image = decodeImage(payload.image, MAX_EMOJI_BYTES);
      if (!image) return ack({ ok: false, error: 'That picture could not be used (PNG, WebP or GIF, small size)' });

      try {
        const entry = emojiModel.add(name, userId, image.type, image.data);
        ack({ ok: true, emoji: emojiModel.toPublic(entry) });
      } catch (err) {
        console.warn('[emoji] could not save', err);
        return ack({ ok: false, error: 'Could not save the emoji' });
      }
      this.broadcast();
    });

    socket.on('emoji:remove', (payload, rawAck) => {
      const ack = safeAck(rawAck);
      const entry = typeof payload?.name === 'string' ? emojiModel.get(payload.name) : undefined;
      if (!entry) return ack({ ok: false, error: 'No such emoji' });
      if (entry.owner.toLowerCase() !== userId.toLowerCase()) {
        return ack({ ok: false, error: `Only ${entry.owner} can remove :${entry.name}:` });
      }
      emojiModel.remove(entry.name);
      ack({ ok: true });
      this.broadcast();
    });
  }

  private broadcast(): void {
    this.io.emit('emoji:update', emojiModel.list());
  }
}
