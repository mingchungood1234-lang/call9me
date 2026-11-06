import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config';

interface StoredToken {
  userId: string;
  token: string;
  createdAt: number;
}

/**
 * Firebase Cloud Messaging tokens of the Android app, per user (one per installed app),
 * persisted to JSON. Each token belongs to exactly one user at a time.
 */
export class FcmTokenModel {
  /** token → owner */
  private readonly byToken = new Map<string, StoredToken>();

  constructor(private readonly file: string) {
    this.load();
  }

  add(userId: string, token: string): void {
    const existing = this.byToken.get(token);
    if (existing?.userId === userId) return;
    this.byToken.set(token, { userId, token, createdAt: Date.now() });
    this.persist();
  }

  remove(token: string): void {
    if (this.byToken.delete(token)) this.persist();
  }

  removeForUser(userId: string, token: string): void {
    const existing = this.byToken.get(token);
    if (existing && existing.userId.toLowerCase() === userId.toLowerCase()) this.remove(token);
  }

  forUser(userId: string): string[] {
    const key = userId.toLowerCase();
    return [...this.byToken.values()].filter((t) => t.userId.toLowerCase() === key).map((t) => t.token);
  }

  private load(): void {
    try {
      const list: StoredToken[] = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      for (const item of list) this.byToken.set(item.token, item);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') console.warn(`[fcm] could not read ${this.file}:`, err);
    }
  }

  private persist(): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify([...this.byToken.values()], null, 2));
    fs.renameSync(tmp, this.file);
  }
}

export const fcmTokenModel = new FcmTokenModel(path.join(config.dataDir, 'fcm-tokens.json'));
