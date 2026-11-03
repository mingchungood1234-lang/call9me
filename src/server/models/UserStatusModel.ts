import fs from 'node:fs';
import path from 'node:path';
import type { UserStatus } from '../../shared/types';
import { config } from '../config';

/** Each user's chosen status (online / idle / dnd / invisible), persisted so it survives restarts. */
export class UserStatusModel {
  /** lowercased user ID → status; "online" is the default and isn't stored */
  private readonly statuses = new Map<string, UserStatus>();

  constructor(private readonly file: string) {
    this.load();
  }

  get(userId: string): UserStatus {
    return this.statuses.get(userId.toLowerCase()) ?? 'online';
  }

  set(userId: string, status: UserStatus): void {
    if (status === 'online') this.statuses.delete(userId.toLowerCase());
    else this.statuses.set(userId.toLowerCase(), status);
    this.persist();
  }

  private load(): void {
    try {
      const data: Record<string, UserStatus> = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      for (const [id, status] of Object.entries(data)) this.statuses.set(id, status);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') console.warn(`[status] could not read ${this.file}:`, err);
    }
  }

  private persist(): void {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(Object.fromEntries(this.statuses)));
      fs.renameSync(tmp, this.file);
    } catch (err) {
      console.warn(`[status] could not write ${this.file}:`, err);
    }
  }
}

export const userStatusModel = new UserStatusModel(path.join(config.dataDir, 'statuses.json'));
