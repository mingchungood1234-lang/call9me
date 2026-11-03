import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { Sticker } from '../../shared/types';
import { config } from '../config';
import type { ImageType } from '../services/images';

interface StoredSticker {
  id: string;
  type: ImageType;
  createdAt: number;
}

/** Each user's own sticker collection; pictures live in `<data>/stickers/<user>/`. */
export class StickerModel {
  /** lowercased user ID → stickers, newest first */
  private readonly byUser = new Map<string, StoredSticker[]>();
  private readonly indexFile: string;

  constructor(readonly dir: string) {
    this.indexFile = path.join(dir, 'stickers.json');
    this.load();
  }

  private url(userKey: string, s: StoredSticker): string {
    return `/stickers/${userKey}/${s.id}.${s.type}`;
  }

  list(userId: string): Sticker[] {
    const key = userId.toLowerCase();
    return (this.byUser.get(key) ?? []).map((s) => ({ id: s.id, url: this.url(key, s) }));
  }

  count(userId: string): number {
    return this.byUser.get(userId.toLowerCase())?.length ?? 0;
  }

  /** The URL of one of this user's stickers, if they have it. */
  urlOf(userId: string, id: string): string | undefined {
    const key = userId.toLowerCase();
    const sticker = this.byUser.get(key)?.find((s) => s.id === id);
    return sticker ? this.url(key, sticker) : undefined;
  }

  add(userId: string, type: ImageType, data: Buffer): Sticker {
    const key = userId.toLowerCase();
    const sticker: StoredSticker = { id: randomBytes(9).toString('base64url'), type, createdAt: Date.now() };
    fs.mkdirSync(path.join(this.dir, key), { recursive: true });
    fs.writeFileSync(path.join(this.dir, key, `${sticker.id}.${type}`), data);
    this.byUser.set(key, [sticker, ...(this.byUser.get(key) ?? [])]);
    this.persist();
    return { id: sticker.id, url: this.url(key, sticker) };
  }

  /** @returns whether it existed. Messages already sent with it show "sticker removed". */
  remove(userId: string, id: string): boolean {
    const key = userId.toLowerCase();
    const list = this.byUser.get(key) ?? [];
    const sticker = list.find((s) => s.id === id);
    if (!sticker) return false;
    fs.rmSync(path.join(this.dir, key, `${id}.${sticker.type}`), { force: true });
    this.byUser.set(key, list.filter((s) => s !== sticker));
    this.persist();
    return true;
  }

  private load(): void {
    try {
      const data: Record<string, StoredSticker[]> = JSON.parse(fs.readFileSync(this.indexFile, 'utf8'));
      for (const [key, list] of Object.entries(data)) if (Array.isArray(list)) this.byUser.set(key, list);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') console.warn(`[stickers] could not read ${this.indexFile}:`, err);
    }
  }

  private persist(): void {
    fs.mkdirSync(this.dir, { recursive: true });
    const tmp = `${this.indexFile}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(Object.fromEntries(this.byUser)));
    fs.renameSync(tmp, this.indexFile);
  }
}

export const stickerModel = new StickerModel(path.join(config.dataDir, 'stickers'));
