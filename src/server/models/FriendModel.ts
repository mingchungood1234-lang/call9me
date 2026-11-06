import fs from 'node:fs';
import path from 'node:path';
import type { FriendRequest, FriendsState } from '../../shared/types';
import { config } from '../config';

/** [from, to, message, sent at] (requests from before messages were required have none). */
type StoredRequest = [string, string, string?, number?];

interface StoredFriends {
  /** Pairs of IDs (as registered), each listed once. */
  friends: [string, string][];
  requests: StoredRequest[];
  /** Lowercased IDs that turned on "auto-block incoming friend requests". */
  blockRequests?: string[];
}

const key = (id: string) => id.toLowerCase();
const pairKey = (a: string, b: string) => [key(a), key(b)].sort().join('|');

/**
 * Friendships and pending friend requests, persisted to JSON. IDs are compared
 * case-insensitively but kept with their registered casing for display.
 */
export class FriendModel {
  /** pairKey → [a, b] */
  private readonly friends = new Map<string, [string, string]>();
  /** "from|to" (lowercased) → [from, to, message, at] */
  private readonly requests = new Map<string, StoredRequest>();
  private readonly blocking = new Set<string>();
  private persistTimer: NodeJS.Timeout | null = null;

  constructor(private readonly file: string) {
    this.load();
  }

  areFriends(a: string, b: string): boolean {
    return this.friends.has(pairKey(a, b));
  }

  hasRequest(from: string, to: string): boolean {
    return this.requests.has(`${key(from)}|${key(to)}`);
  }

  friendsOf(userId: string): string[] {
    const me = key(userId);
    const result: string[] = [];
    for (const [a, b] of this.friends.values()) {
      if (key(a) === me) result.push(b);
      else if (key(b) === me) result.push(a);
    }
    return result.sort((x, y) => x.localeCompare(y));
  }

  state(userId: string): FriendsState {
    const me = key(userId);
    const incoming: FriendRequest[] = [];
    const outgoing: FriendRequest[] = [];
    for (const [from, to, message = '', at = 0] of this.requests.values()) {
      if (key(to) === me) incoming.push({ id: from, message, at });
      else if (key(from) === me) outgoing.push({ id: to, message, at });
    }
    return { friends: this.friendsOf(userId), incoming, outgoing, blockRequests: this.blocksRequests(userId) };
  }

  /** The note sent with a pending request ('' if none). */
  requestMessage(from: string, to: string): string {
    return this.requests.get(`${key(from)}|${key(to)}`)?.[2] ?? '';
  }

  addRequest(from: string, to: string, message: string): void {
    this.requests.set(`${key(from)}|${key(to)}`, [from, to, message, Date.now()]);
    this.schedulePersist();
  }

  blocksRequests(userId: string): boolean {
    return this.blocking.has(key(userId));
  }

  setBlockRequests(userId: string, block: boolean): void {
    if (block) this.blocking.add(key(userId));
    else this.blocking.delete(key(userId));
    this.schedulePersist();
  }

  /** @returns whether there was such a request. */
  removeRequest(from: string, to: string): boolean {
    const removed = this.requests.delete(`${key(from)}|${key(to)}`);
    if (removed) this.schedulePersist();
    return removed;
  }

  addFriends(a: string, b: string): void {
    this.removeRequest(a, b);
    this.removeRequest(b, a);
    this.friends.set(pairKey(a, b), [a, b]);
    this.schedulePersist();
  }

  /** @returns whether they were friends. */
  removeFriends(a: string, b: string): boolean {
    const removed = this.friends.delete(pairKey(a, b));
    if (removed) this.schedulePersist();
    return removed;
  }

  private load(): void {
    try {
      const data: StoredFriends = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      for (const [a, b] of data.friends ?? []) this.friends.set(pairKey(a, b), [a, b]);
      for (const request of data.requests ?? []) this.requests.set(`${key(request[0])}|${key(request[1])}`, request);
      for (const id of data.blockRequests ?? []) this.blocking.add(id);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') console.warn(`[friends] could not read ${this.file}:`, err);
    }
  }

  private schedulePersist(): void {
    if (this.persistTimer) return;
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      const data: StoredFriends = {
        friends: [...this.friends.values()],
        requests: [...this.requests.values()],
        blockRequests: [...this.blocking],
      };
      try {
        fs.mkdirSync(path.dirname(this.file), { recursive: true });
        const tmp = `${this.file}.tmp`;
        fs.writeFileSync(tmp, JSON.stringify(data));
        fs.renameSync(tmp, this.file);
      } catch (err) {
        console.warn(`[friends] could not write ${this.file}:`, err);
      }
    }, 500);
  }
}

export const friendModel = new FriendModel(path.join(config.dataDir, 'friends.json'));
