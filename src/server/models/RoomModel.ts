import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { ChatMessage, RoomPrefs } from '../../shared/types';
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
 * while their app is closed. Followers, read marks and each user's room preferences are
 * persisted; so is the chat history of permanent rooms (see `isPermanent`). Rooms are
 * dropped from memory once nobody is in them and nobody follows them.
 */
export class RoomModel {
  private readonly rooms = new Map<string, Room>();
  /** roomId → user IDs */
  private readonly followers = new Map<string, Set<string>>();
  private persistTimer: NodeJS.Timeout | null = null;
  /** Permanent rooms' histories waiting to be written (roomId → messages). */
  private readonly pendingHistory = new Map<string, ChatMessage[]>();
  private historyTimer: NodeJS.Timeout | null = null;

  /** Permanent rooms keep their chat history on disk (set up by the room directory). */
  isPermanent: (roomId: string) => boolean = () => false;

  /** "user|room" → when they last read it */
  private readonly reads = new Map<string, number>();
  private readsTimer: NodeJS.Timeout | null = null;
  private readonly readsFile: string;

  /** "user|room" → their pinned / muted / archived choices */
  private readonly prefs = new Map<string, RoomPrefs>();
  private prefsTimer: NodeJS.Timeout | null = null;
  private readonly prefsFile: string;

  constructor(
    private readonly followersFile: string,
    private readonly historyDir: string,
  ) {
    this.readsFile = path.join(path.dirname(followersFile), 'room-reads.json');
    this.prefsFile = path.join(path.dirname(followersFile), 'room-prefs.json');
    this.loadFollowers();
    this.loadReads();
    this.loadPrefs();
  }

  normalize(roomId: string): string {
    return roomId.toLowerCase();
  }

  join(roomId: string, userId: string): Room {
    const id = this.normalize(roomId);
    let room = this.rooms.get(id);
    if (!room) {
      room = { id, members: new Set(), messages: this.isPermanent(id) ? this.loadHistory(id) : [] };
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
    this.release(id);
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

  /** A room's messages for previews: a permanent room's saved history is loaded if needed. */
  messagesOf(roomId: string): ChatMessage[] {
    const id = this.normalize(roomId);
    let room = this.rooms.get(id);
    if (!room && this.isPermanent(id)) {
      room = { id, members: new Set(), messages: this.loadHistory(id) };
      this.rooms.set(id, room);
    }
    return room?.messages ?? [];
  }

  /** The rooms this user has joined (follows), i.e. their chat list. */
  followedBy(userId: string): string[] {
    const key = userId.toLowerCase();
    return [...this.followers].filter(([, users]) => [...users].some((u) => u.toLowerCase() === key)).map(([id]) => id);
  }

  isFollower(roomId: string, userId: string): boolean {
    const key = userId.toLowerCase();
    return [...(this.followers.get(this.normalize(roomId)) ?? [])].some((u) => u.toLowerCase() === key);
  }

  // ---- Read marks (unread counts in the chat list) ----

  private readKey(userId: string, roomId: string): string {
    return `${userId.toLowerCase()}|${this.normalize(roomId)}`;
  }

  markRead(userId: string, roomId: string): void {
    this.reads.set(this.readKey(userId, roomId), Date.now());
    this.scheduleReads();
  }

  /** Messages from others since this user last read the room. */
  unreadCount(roomId: string, userId: string): number {
    const since = this.reads.get(this.readKey(userId, roomId)) ?? 0;
    const me = userId.toLowerCase();
    return this.messagesOf(roomId).filter((m) => !m.system && m.timestamp > since && m.from.toLowerCase() !== me).length;
  }

  // ---- Each user's preferences per room ----

  prefsOf(userId: string, roomId: string): RoomPrefs {
    return { ...this.prefs.get(this.readKey(userId, roomId)) };
  }

  /** Merges `changes` into their preferences for the room (false values are dropped). */
  setPrefs(userId: string, roomId: string, changes: RoomPrefs): RoomPrefs {
    const key = this.readKey(userId, roomId);
    const next: RoomPrefs = { ...this.prefs.get(key) };
    for (const name of ['pinned', 'muted', 'archived'] as const) {
      if (changes[name] === undefined) continue;
      if (changes[name]) next[name] = true;
      else delete next[name];
    }
    if (Object.keys(next).length) this.prefs.set(key, next);
    else this.prefs.delete(key);
    this.schedulePrefs();
    return { ...next };
  }

  isMuted(userId: string, roomId: string): boolean {
    return this.prefs.get(this.readKey(userId, roomId))?.muted ?? false;
  }

  private clearPrefs(userId: string, roomId: string): void {
    if (this.prefs.delete(this.readKey(userId, roomId))) this.schedulePrefs();
  }

  private loadPrefs(): void {
    try {
      const data: Record<string, RoomPrefs> = JSON.parse(fs.readFileSync(this.prefsFile, 'utf8'));
      for (const [key, prefs] of Object.entries(data)) this.prefs.set(key, prefs);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') console.warn(`[rooms] could not read ${this.prefsFile}:`, err);
    }
  }

  private schedulePrefs(): void {
    if (this.prefsTimer) return;
    this.prefsTimer = setTimeout(() => {
      this.prefsTimer = null;
      try {
        fs.mkdirSync(path.dirname(this.prefsFile), { recursive: true });
        const tmp = `${this.prefsFile}.tmp`;
        fs.writeFileSync(tmp, JSON.stringify(Object.fromEntries(this.prefs)));
        fs.renameSync(tmp, this.prefsFile);
      } catch (err) {
        console.warn('[rooms] could not save room preferences:', err);
      }
    }, 1000);
  }

  private loadReads(): void {
    try {
      const data: Record<string, number> = JSON.parse(fs.readFileSync(this.readsFile, 'utf8'));
      for (const [key, at] of Object.entries(data)) this.reads.set(key, at);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') console.warn(`[rooms] could not read ${this.readsFile}:`, err);
    }
  }

  private scheduleReads(): void {
    if (this.readsTimer) return;
    this.readsTimer = setTimeout(() => {
      this.readsTimer = null;
      try {
        fs.mkdirSync(path.dirname(this.readsFile), { recursive: true });
        const tmp = `${this.readsFile}.tmp`;
        fs.writeFileSync(tmp, JSON.stringify(Object.fromEntries(this.reads)));
        fs.renameSync(tmp, this.readsFile);
      } catch (err) {
        console.warn('[rooms] could not save read marks:', err);
      }
    }, 2000);
  }

  /** `sticker`: the sticker picture URL for a sticker message. */
  addMessage(roomId: string, from: string, text: string, system = false, sticker?: string): ChatMessage {
    const id = this.normalize(roomId);
    const message: ChatMessage = { id: randomUUID(), roomId: id, from, text, timestamp: Date.now(), system };
    if (sticker) message.sticker = sticker;
    this.messagesOf(id); // loads a permanent room's saved history if nobody has it open
    const room = this.rooms.get(id);
    if (room) {
      room.messages.push(message);
      if (room.messages.length > config.chatHistoryLimit) room.messages.shift();
      if (this.isPermanent(id)) this.scheduleHistory(id, room.messages);
    }
    return message;
  }

  /** Deletes a room's messages (memory and disk); members and followers stay. @returns the messages people wrote. */
  clearHistory(roomId: string): number {
    const id = this.normalize(roomId);
    const messages = this.messagesOf(id);
    const count = messages.filter((m) => !m.system).length;
    messages.length = 0;
    this.pendingHistory.delete(id);
    fs.rmSync(this.historyFile(id), { force: true });
    this.release(id);
    return count;
  }

  /** Forgets a room completely: members, messages, followers and any saved history. */
  deleteRoom(roomId: string): void {
    const id = this.normalize(roomId);
    this.rooms.delete(id);
    if (this.followers.delete(id)) this.schedulePersist();
    for (const key of [...this.prefs.keys()]) if (key.endsWith(`|${id}`)) this.prefs.delete(key);
    this.schedulePrefs();
    this.pendingHistory.delete(id);
    fs.rmSync(this.historyFile(id), { force: true });
  }

  // ---- Permanent rooms' history ----

  private historyFile(id: string): string {
    return path.join(this.historyDir, `${id}.json`);
  }

  private loadHistory(id: string): ChatMessage[] {
    try {
      const messages: ChatMessage[] = JSON.parse(fs.readFileSync(this.historyFile(id), 'utf8'));
      return Array.isArray(messages) ? messages.slice(-config.chatHistoryLimit) : [];
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') console.warn(`[rooms] could not read history of #${id}:`, err);
      return [];
    }
  }

  /** Writes are batched; the array is kept even if the room is dropped from memory meanwhile. */
  private scheduleHistory(id: string, messages: ChatMessage[]): void {
    this.pendingHistory.set(id, messages);
    if (this.historyTimer) return;
    this.historyTimer = setTimeout(() => {
      this.historyTimer = null;
      for (const [roomId, list] of this.pendingHistory) {
        try {
          fs.mkdirSync(this.historyDir, { recursive: true });
          const tmp = `${this.historyFile(roomId)}.tmp`;
          fs.writeFileSync(tmp, JSON.stringify(list));
          fs.renameSync(tmp, this.historyFile(roomId));
        } catch (err) {
          console.warn(`[rooms] could not save history of #${roomId}:`, err);
        }
      }
      this.pendingHistory.clear();
    }, 1000);
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
    this.clearPrefs(userId, id);
    this.release(id);
    this.schedulePersist();
  }

  followersOf(roomId: string): string[] {
    return [...(this.followers.get(this.normalize(roomId)) ?? [])];
  }

  /** Drops the room from memory if nobody is in it or follows it (its saved history stays on disk). */
  release(roomId: string): void {
    const id = this.normalize(roomId);
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

export const roomModel = new RoomModel(
  path.join(config.dataDir, 'room-followers.json'),
  path.join(config.dataDir, 'room-history'),
);
