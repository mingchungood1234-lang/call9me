import fs from 'node:fs';
import path from 'node:path';
import type { CallHistoryEntry } from '../../shared/types';
import { config } from '../config';

/** Older entries are dropped beyond this many per user. */
const MAX_ENTRIES_PER_USER = 200;
const PERSIST_DELAY_MS = 1000;

/** Finished calls per user (newest first), persisted to JSON. */
export class CallHistoryModel {
  /** lowercased user ID → entries, newest first */
  private readonly byUser = new Map<string, CallHistoryEntry[]>();
  private persistTimer: NodeJS.Timeout | null = null;

  constructor(private readonly file: string) {
    this.load();
  }

  add(userId: string, entry: CallHistoryEntry): void {
    const key = userId.toLowerCase();
    const entries = this.byUser.get(key) ?? [];
    entries.unshift(entry);
    entries.length = Math.min(entries.length, MAX_ENTRIES_PER_USER);
    this.byUser.set(key, entries);
    this.schedulePersist();
  }

  list(userId: string): CallHistoryEntry[] {
    return [...(this.byUser.get(userId.toLowerCase()) ?? [])];
  }

  clear(userId: string): void {
    if (this.byUser.delete(userId.toLowerCase())) this.schedulePersist();
  }

  private load(): void {
    try {
      const data: Record<string, CallHistoryEntry[]> = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      for (const [key, entries] of Object.entries(data)) if (Array.isArray(entries)) this.byUser.set(key, entries);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') console.warn(`[history] could not read ${this.file}:`, err);
    }
  }

  /** Calls can end in bursts (a group call ending), so writes are batched. */
  private schedulePersist(): void {
    if (this.persistTimer) return;
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      try {
        fs.mkdirSync(path.dirname(this.file), { recursive: true });
        const tmp = `${this.file}.tmp`;
        fs.writeFileSync(tmp, JSON.stringify(Object.fromEntries(this.byUser)));
        fs.renameSync(tmp, this.file);
      } catch (err) {
        console.warn(`[history] could not write ${this.file}:`, err);
      }
    }, PERSIST_DELAY_MS);
  }
}

export const callHistoryModel = new CallHistoryModel(path.join(config.dataDir, 'call-history.json'));
