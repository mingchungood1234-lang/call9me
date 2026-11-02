import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { ChatMessage } from '../../shared/types';
import { config } from '../config';

interface Room {
  id: string;
  members: Set<string>;
  messages: ChatMessage[];
}

/**
 * Public chat rooms. Room IDs are case-insensitive (stored lowercase).
 *
 * Members are users connected to a room right now. Followers are users who joined a
 * room and haven't left it on purpose — they keep getting push notifications for it
 * while their app is closed. Followers are persisted; rooms and messages are in memory.
 * A room's history is discarded once nobody is in it and nobody follows it.
 */
export class RoomModel {
  private readonly rooms = new Map<string, Room>();
  /** roomId → user IDs */
  private readonly followers = new Map<string, Set<string>>();
  private persistTimer: NodeJS.Timeout | null = null;

  constructor(private readonly followersFile: string) {
    this.loadFollowers();
  }

  normalize(roomId: string): string {
    return roomId.toLowerCase();
  }

  join(roomId: string, userId: string): Room {
    const id = this.normalize(roomId);
    let room = this.rooms.get(id);
    if (!room) {
      room = { id, members: new Set(), messages: [] };
      this.rooms.set(id, room);
    }
    room.members.add(userId);
    return room;
  }

  leave(roomId: string, userId: string): void {
    const id = this.normalize(roomId);
    const room = this.rooms.get(id);
    if (!room) return;
    room.members.delete(userId);
    this.dropIfAbandoned(id);
  }

  isMember(roomId: string, userId: string): boolean {
    return this.rooms.get(this.normalize(roomId))?.members.has(userId) ?? false;
  }

  roomsOf(userId: string): string[] {
    return [...this.rooms.values()].filter((r) => r.members.has(userId)).map((r) => r.id);
  }

  members(roomId: string): string[] {
    return [...(this.rooms.get(this.normalize(roomId))?.members ?? [])].sort();
  }

  history(roomId: string): ChatMessage[] {
    return [...(this.rooms.get(this.normalize(roomId))?.messages ?? [])];
  }

  addMessage(roomId: string, from: string, text: string, system = false): ChatMessage {
    const id = this.normalize(roomId);
    const message: ChatMessage = { id: randomUUID(), roomId: id, from, text, timestamp: Date.now(), system };
    const room = this.rooms.get(id);
    if (room) {
      room.messages.push(message);
      if (room.messages.length > config.chatHistoryLimit) room.messages.shift();
    }
    return message;
  }

  // ---- Followers (notifications while offline) ----

  follow(roomId: string, userId: string): void {
    const id = this.normalize(roomId);
    let set = this.followers.get(id);
    if (!set) {
      set = new Set();
      this.followers.set(id, set);
    }
    if (!set.has(userId)) {
      set.add(userId);
      this.schedulePersist();
    }
  }

  unfollow(roomId: string, userId: string): void {
    const id = this.normalize(roomId);
    const set = this.followers.get(id);
    if (!set?.delete(userId)) return;
    if (set.size === 0) this.followers.delete(id);
    this.dropIfAbandoned(id);
    this.schedulePersist();
  }

  /** On sign-out: stop all chat notifications for this user. */
  unfollowAll(userId: string): void {
    for (const roomId of [...this.followers.keys()]) this.unfollow(roomId, userId);
  }

  followersOf(roomId: string): string[] {
    return [...(this.followers.get(this.normalize(roomId)) ?? [])];
  }

  private dropIfAbandoned(id: string): void {
    const room = this.rooms.get(id);
    if (room && room.members.size === 0 && !this.followers.has(id)) this.rooms.delete(id);
  }

  private loadFollowers(): void {
    try {
      const data: Record<string, string[]> = JSON.parse(fs.readFileSync(this.followersFile, 'utf8'));
      for (const [roomId, users] of Object.entries(data)) {
        if (users.length) this.followers.set(roomId, new Set(users));
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') console.warn(`[rooms] could not read ${this.followersFile}:`, err);
    }
  }

  private schedulePersist(): void {
    if (this.persistTimer) return;
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      const data = Object.fromEntries([...this.followers].map(([roomId, users]) => [roomId, [...users]]));
      try {
        fs.mkdirSync(path.dirname(this.followersFile), { recursive: true });
        const tmp = `${this.followersFile}.tmp`;
        fs.writeFileSync(tmp, JSON.stringify(data));
        fs.renameSync(tmp, this.followersFile);
      } catch (err) {
        console.warn('[rooms] could not save followers:', err);
      }
    }, 1000);
  }
}

export const roomModel = new RoomModel(path.join(config.dataDir, 'room-followers.json'));
