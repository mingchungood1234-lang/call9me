import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config';
import type { ImageType } from '../services/images';

interface StoredAvatar {
  type: ImageType;
  updatedAt: number;
}

/** Profile pictures, one per user, in `<data>/avatars/` (file name: lowercased user ID). */
export class AvatarModel {
  /** lowercased user ID → avatar */
  private readonly avatars = new Map<string, StoredAvatar>();
  private readonly indexFile: string;

  constructor(readonly dir: string) {
    this.indexFile = path.join(dir, 'avatars.json');
    this.load();
  }

  /** Everyone's picture URL, by lowercased user ID (the version query busts caches on change). */
  urls(): Record<string, string> {
    return Object.fromEntries([...this.avatars].map(([key, a]) => [key, `/avatars/${key}.${a.type}?v=${a.updatedAt}`]));
  }

  set(userId: string, type: ImageType, data: Buffer): void {
    const key = userId.toLowerCase();
    this.removeFile(key);
    fs.mkdirSync(this.dir, { recursive: true });
    fs.writeFileSync(path.join(this.dir, `${key}.${type}`), data);
    this.avatars.set(key, { type, updatedAt: Date.now() });
    this.persist();
  }

  remove(userId: string): void {
    const key = userId.toLowerCase();
    if (!this.avatars.has(key)) return;
    this.removeFile(key);
    this.avatars.delete(key);
    this.persist();
  }

  private removeFile(key: string): void {
    const old = this.avatars.get(key);
    if (old) fs.rmSync(path.join(this.dir, `${key}.${old.type}`), { force: true });
  }

  private load(): void {
    try {
      const data: Record<string, StoredAvatar> = JSON.parse(fs.readFileSync(this.indexFile, 'utf8'));
      for (const [key, a] of Object.entries(data)) this.avatars.set(key, a);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') console.warn(`[avatars] could not read ${this.indexFile}:`, err);
    }
  }

  private persist(): void {
    fs.mkdirSync(this.dir, { recursive: true });
    const tmp = `${this.indexFile}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(Object.fromEntries(this.avatars)));
    fs.renameSync(tmp, this.indexFile);
  }
}

export const avatarModel = new AvatarModel(path.join(config.dataDir, 'avatars'));
