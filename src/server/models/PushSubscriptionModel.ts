import fs from 'node:fs';
import path from 'node:path';
import type { PushSubscriptionJSON } from '../../shared/types';
import { config } from '../config';

interface StoredSubscription {
  userId: string;
  subscription: PushSubscriptionJSON;
  createdAt: number;
}

/**
 * Web Push subscriptions per user (a user may have several devices), persisted to JSON.
 * Each push endpoint belongs to exactly one user at a time.
 */
export class PushSubscriptionModel {
  /** endpoint → subscription */
  private readonly byEndpoint = new Map<string, StoredSubscription>();

  constructor(private readonly file: string) {
    this.load();
  }

  add(userId: string, subscription: PushSubscriptionJSON): void {
    this.byEndpoint.set(subscription.endpoint, { userId, subscription, createdAt: Date.now() });
    this.persist();
  }

  remove(endpoint: string): void {
    if (this.byEndpoint.delete(endpoint)) this.persist();
  }

  removeForUser(userId: string, endpoint: string): void {
    const existing = this.byEndpoint.get(endpoint);
    if (existing && existing.userId.toLowerCase() === userId.toLowerCase()) this.remove(endpoint);
  }

  forUser(userId: string): PushSubscriptionJSON[] {
    const key = userId.toLowerCase();
    return [...this.byEndpoint.values()].filter((s) => s.userId.toLowerCase() === key).map((s) => s.subscription);
  }

  private load(): void {
    try {
      const list: StoredSubscription[] = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      for (const item of list) this.byEndpoint.set(item.subscription.endpoint, item);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') console.warn(`[push] could not read ${this.file}:`, err);
    }
  }

  private persist(): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify([...this.byEndpoint.values()], null, 2));
    fs.renameSync(tmp, this.file);
  }
}

export const pushSubscriptionModel = new PushSubscriptionModel(path.join(config.dataDir, 'push-subscriptions.json'));
