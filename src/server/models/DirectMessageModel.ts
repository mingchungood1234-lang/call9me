import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DM_ROOM_PREFIX, isDmRoomId } from '../../shared/validation';
import { config } from '../config';
import { friendModel } from './FriendModel';

const key = (id: string) => id.toLowerCase();
const same = (a: string, b: string) => key(a) === key(b);

/**
 * Direct-message conversations between two friends. Each pair gets one chat room with a
 * reserved ID ("dm--" + a hash of the pair), so DMs reuse everything chat rooms already do
 * (history, unread counts, typing, stickers, notifications). This maps those IDs to the pair
 * and decides who may use them: only the two people, and only while they're friends.
 */
export class DirectMessageModel {
  /** room ID → [a, b] (IDs as registered) */
  private readonly pairs = new Map<string, [string, string]>();
  private persistTimer: NodeJS.Timeout | null = null;

  constructor(private readonly file: string) {
    this.load();
  }

  /** The DM room of two people (created on first use). */
  roomFor(a: string, b: string): string {
    const pair = [key(a), key(b)].sort().join('|');
    const id = `${DM_ROOM_PREFIX}${createHash('sha256').update(pair).digest('hex').slice(0, 32 - DM_ROOM_PREFIX.length)}`;
    if (!this.pairs.has(id)) {
      this.pairs.set(id, [a, b]);
      this.schedulePersist();
    }
    return id;
  }

  /** The two people of a DM room, if it is one. */
  pairOf(roomId: string): [string, string] | undefined {
    return isDmRoomId(roomId) ? this.pairs.get(roomId.toLowerCase()) : undefined;
  }

  /** In `userId`'s DM room: the other person. */
  peerOf(roomId: string, userId: string): string | undefined {
    const pair = this.pairOf(roomId);
    if (!pair) return undefined;
    if (same(pair[0], userId)) return pair[1];
    return same(pair[1], userId) ? pair[0] : undefined;
  }

  /** May `userId` read and write this DM? (one of the two, and they're still friends) */
  canUse(roomId: string, userId: string): boolean {
    const peer = this.peerOf(roomId, userId);
    return !!peer && friendModel.areFriends(userId, peer);
  }

  private load(): void {
    try {
      const data: Record<string, [string, string]> = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      for (const [id, pair] of Object.entries(data)) this.pairs.set(id, pair);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') console.warn(`[dm] could not read ${this.file}:`, err);
    }
  }

  private schedulePersist(): void {
    if (this.persistTimer) return;
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      try {
        fs.mkdirSync(path.dirname(this.file), { recursive: true });
        const tmp = `${this.file}.tmp`;
        fs.writeFileSync(tmp, JSON.stringify(Object.fromEntries(this.pairs)));
        fs.renameSync(tmp, this.file);
      } catch (err) {
        console.warn(`[dm] could not write ${this.file}:`, err);
      }
    }, 500);
  }
}

export const directMessageModel = new DirectMessageModel(path.join(config.dataDir, 'direct-messages.json'));
