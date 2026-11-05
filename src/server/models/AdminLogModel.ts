import fs from 'node:fs';
import path from 'node:path';
import type { AdminLogEntry } from '../../shared/types';
import { config } from '../config';

/** Entries kept (oldest dropped first). */
const MAX_ENTRIES = 2000;

/** Every admin action (and failed unlock), newest last, persisted to JSON. */
export class AdminLogModel {
  private readonly entries: AdminLogEntry[] = [];

  constructor(private readonly file: string) {
    this.load();
  }

  add(admin: string, action: string, target: string, detail?: string): void {
    const entry: AdminLogEntry = { at: Date.now(), admin, action, target };
    if (detail) entry.detail = detail;
    this.entries.push(entry);
    if (this.entries.length > MAX_ENTRIES) this.entries.splice(0, this.entries.length - MAX_ENTRIES);
    console.log(`[admin] ${admin} ${action} ${target}${detail ? ` (${detail})` : ''}`);
    this.persist();
  }

  /** Newest first. */
  recent(limit = 300): AdminLogEntry[] {
    return this.entries.slice(-limit).reverse();
  }

  private load(): void {
    try {
      const list: AdminLogEntry[] = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (Array.isArray(list)) this.entries.push(...list.slice(-MAX_ENTRIES));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') console.warn(`[admin] could not read ${this.file}:`, err);
    }
  }

  private persist(): void {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(this.entries));
      fs.renameSync(tmp, this.file);
    } catch (err) {
      console.warn('[admin] could not save the audit log:', err);
    }
  }
}

export const adminLogModel = new AdminLogModel(path.join(config.dataDir, 'admin-log.json'));
