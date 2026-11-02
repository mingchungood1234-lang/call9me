import fs from 'node:fs';
import path from 'node:path';
import webpush from 'web-push';
import type { PushPayload } from '../../shared/types';
import { config } from '../config';
import { pushSubscriptionModel } from '../models/PushSubscriptionModel';

interface VapidKeys {
  publicKey: string;
  privateKey: string;
}

/** VAPID keys from env, else from data/vapid.json, else generated once and saved there. */
function loadVapidKeys(): VapidKeys {
  const { VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY } = process.env;
  if (VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY) return { publicKey: VAPID_PUBLIC_KEY, privateKey: VAPID_PRIVATE_KEY };

  const file = path.join(config.dataDir, 'vapid.json');
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as VapidKeys;
  } catch {
    const keys = webpush.generateVAPIDKeys();
    fs.mkdirSync(config.dataDir, { recursive: true });
    fs.writeFileSync(file, JSON.stringify(keys, null, 2));
    console.log(`[push] generated VAPID keys in ${file}`);
    return keys;
  }
}

/** Sends Web Push notifications to every device a user has subscribed. */
export class PushService {
  readonly publicKey: string;
  /** "userId|tag" → last send time, to avoid flooding devices with chat pushes. */
  private readonly lastSent = new Map<string, number>();

  constructor() {
    const keys = loadVapidKeys();
    this.publicKey = keys.publicKey;
    webpush.setVapidDetails(config.vapidSubject, keys.publicKey, keys.privateKey);
  }

  hasSubscribers(userId: string): boolean {
    return pushSubscriptionModel.forUser(userId).length > 0;
  }

  /**
   * @param throttleMs skip if the same user got a push with the same tag within this window.
   */
  notify(userId: string, payload: PushPayload, throttleMs = 0): void {
    const subscriptions = pushSubscriptionModel.forUser(userId);
    if (subscriptions.length === 0) return;

    if (throttleMs > 0) {
      const key = `${userId.toLowerCase()}|${payload.tag}`;
      const last = this.lastSent.get(key) ?? 0;
      if (Date.now() - last < throttleMs) return;
      this.lastSent.set(key, Date.now());
    }

    const body = JSON.stringify(payload);
    const urgency = payload.type === 'call' ? 'high' : 'normal';
    // A call push is useless once the call stops ringing.
    const ttl = payload.type === 'call' ? Math.ceil(config.offlineRingTimeoutMs / 1000) : 60 * 60;
    for (const subscription of subscriptions) {
      webpush
        .sendNotification(subscription as webpush.PushSubscription, body, { TTL: ttl, urgency })
        .catch((err: { statusCode?: number }) => {
          // 404/410: the browser dropped this subscription; forget it.
          if (err.statusCode === 404 || err.statusCode === 410) pushSubscriptionModel.remove(subscription.endpoint);
          else console.warn('[push] send failed', err.statusCode ?? err);
        });
    }
  }
}

export const pushService = new PushService();
