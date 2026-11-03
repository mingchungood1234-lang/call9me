import fs from 'node:fs';
import path from 'node:path';
import type { CustomEmoji } from '../../shared/types';
import { config } from '../config';

export type EmojiImageType = 'png' | 'webp' | 'gif';

interface StoredEmoji {
  name: string;
  owner: string;
  type: EmojiImageType;
  createdAt: number;
}

/** Custom picture emoji (shared by everyone); images live next to the index in `<data>/emoji/`. */
export class EmojiModel {
  private readonly emoji = new Map<string, StoredEmoji>();
  private readonly indexFile: string;

  constructor(readonly dir: string) {
    this.indexFile = path.join(dir, 'emoji.json');
    this.load();
  }

  has(name: string): boolean {
    return this.emoji.has(name);
  }

  get(name: string): StoredEmoji | undefined {
    return this.emoji.get(name);
  }

  count(owner?: string): number {
    if (!owner) return this.emoji.size;
    return [...this.emoji.values()].filter((e) => e.owner.toLowerCase() === owner.toLowerCase()).length;
  }

  list(): CustomEmoji[] {
    return [...this.emoji.values()]
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((e) => this.toPublic(e));
  }

  toPublic(e: StoredEmoji): CustomEmoji {
    // The version query lets browsers cache images forever, yet see a re-added name's new picture.
    return { name: e.name, owner: e.owner, url: `/emoji/${e.name}.${e.type}?v=${e.createdAt}` };
  }

  fileFor(name: string, type: EmojiImageType): string {
    return path.join(this.dir, `${name}.${type}`);
  }

  add(name: string, owner: string, type: EmojiImageType, data: Buffer): StoredEmoji {
    fs.mkdirSync(this.dir, { recursive: true });
    fs.writeFileSync(this.fileFor(name, type), data);
    const entry: StoredEmoji = { name, owner, type, createdAt: Date.now() };
    this.emoji.set(name, entry);
    this.persist();
    return entry;
  }

  remove(name: string): void {
    const entry = this.emoji.get(name);
    if (!entry) return;
    this.emoji.delete(name);
    fs.rmSync(this.fileFor(name, entry.type), { force: true });
    this.persist();
  }

  private load(): void {
    try {
      const list: StoredEmoji[] = JSON.parse(fs.readFileSync(this.indexFile, 'utf8'));
      for (const e of list) this.emoji.set(e.name, e);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') console.warn(`[emoji] could not read ${this.indexFile}:`, err);
    }
  }

  private persist(): void {
    fs.mkdirSync(this.dir, { recursive: true });
    const tmp = `${this.indexFile}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify([...this.emoji.values()]));
    fs.renameSync(tmp, this.indexFile);
  }
}

export const emojiModel = new EmojiModel(path.join(config.dataDir, 'emoji'));
