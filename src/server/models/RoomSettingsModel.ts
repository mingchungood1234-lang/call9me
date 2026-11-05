import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { RoomVisibility } from '../../shared/types';
import { config } from '../config';

export interface RoomSettings {
  /** Lowercase room ID. */
  id: string;
  owner: string;
  visibility: RoomVisibility;
  createdAt: number;
  /** Secret in the invite link of a "link" room. */
  key?: string;
  /** People who joined through the invite link or had the room shared with them; they can always come back. */
  members?: string[];
  /** People the owner banned: they can't see or enter the room, not even with its link. */
  banned?: string[];
}

const newKey = () => randomBytes(12).toString('base64url');

/**
 * Who owns each room ID, who may see and join it, persisted to JSON. A room's chat and
 * call share these settings. The first person to use an ID owns it.
 */
export class RoomSettingsModel {
  private readonly rooms = new Map<string, RoomSettings>();
  private persistTimer: NodeJS.Timeout | null = null;

  constructor(private readonly file: string) {
    this.load();
  }

  get(roomId: string): RoomSettings | undefined {
    return this.rooms.get(roomId.toLowerCase());
  }

  all(): RoomSettings[] {
    return [...this.rooms.values()];
  }

  /** The room's settings, creating them (owned by `userId`) if the ID is new. */
  claim(roomId: string, userId: string, visibility: RoomVisibility = 'public'): RoomSettings {
    const id = roomId.toLowerCase();
    let settings = this.rooms.get(id);
    if (!settings) {
      settings = { id, owner: userId, visibility, createdAt: Date.now() };
      if (visibility === 'link') settings.key = newKey();
      this.rooms.set(id, settings);
      this.schedulePersist();
    }
    return settings;
  }

  setVisibility(roomId: string, visibility: RoomVisibility): void {
    const settings = this.get(roomId);
    if (!settings || settings.visibility === visibility) return;
    settings.visibility = visibility;
    settings.key ??= visibility === 'link' ? newKey() : undefined;
    this.schedulePersist();
  }

  /** @returns whether they were a member. */
  removeMember(settings: RoomSettings, userId: string): boolean {
    const key = userId.toLowerCase();
    const before = settings.members?.length ?? 0;
    settings.members = settings.members?.filter((m) => m.toLowerCase() !== key);
    const removed = (settings.members?.length ?? 0) < before;
    if (removed) this.schedulePersist();
    return removed;
  }

  remove(roomId: string): void {
    if (this.rooms.delete(roomId.toLowerCase())) this.schedulePersist();
  }

  isMember(settings: RoomSettings, userId: string): boolean {
    const key = userId.toLowerCase();
    return settings.members?.some((m) => m.toLowerCase() === key) ?? false;
  }

  isBanned(settings: RoomSettings, userId: string): boolean {
    const key = userId.toLowerCase();
    return settings.banned?.some((b) => b.toLowerCase() === key) ?? false;
  }

  ban(settings: RoomSettings, userId: string): void {
    this.removeMember(settings, userId);
    if (this.isBanned(settings, userId)) return;
    (settings.banned ??= []).push(userId);
    this.schedulePersist();
  }

  /** @returns whether they were banned. */
  unban(settings: RoomSettings, userId: string): boolean {
    const key = userId.toLowerCase();
    const before = settings.banned?.length ?? 0;
    settings.banned = settings.banned?.filter((b) => b.toLowerCase() !== key);
    const removed = (settings.banned?.length ?? 0) < before;
    if (removed) this.schedulePersist();
    return removed;
  }

  addMember(settings: RoomSettings, userId: string): void {
    if (this.isMember(settings, userId) || settings.owner.toLowerCase() === userId.toLowerCase()) return;
    (settings.members ??= []).push(userId);
    this.schedulePersist();
  }

  private load(): void {
    try {
      const list: RoomSettings[] = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      for (const room of list) this.rooms.set(room.id, room);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') console.warn(`[rooms] could not read ${this.file}:`, err);
    }
  }

  private schedulePersist(): void {
    if (this.persistTimer) return;
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      try {
        fs.mkdirSync(path.dirname(this.file), { recursive: true });
        const tmp = `${this.file}.tmp`;
        fs.writeFileSync(tmp, JSON.stringify([...this.rooms.values()]));
        fs.renameSync(tmp, this.file);
      } catch (err) {
        console.warn(`[rooms] could not write ${this.file}:`, err);
      }
    }, 500);
  }
}

export const roomSettingsModel = new RoomSettingsModel(path.join(config.dataDir, 'rooms.json'));
