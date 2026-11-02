import fs from 'node:fs';
import path from 'node:path';
import webpush from 'web-push';
import type { PushPayload, PushTestResult } from '../../shared/types';
import { config } from '../config';
import { pushSubscriptionModel } from '../models/PushSubscriptionModel';
import { userModel } from '../models/UserModel';

interface VapidKeys {
  publicKey: string;
  privateKey: string;
}

interface NotifyOptions {
  /** Skip if the same user got a push with the same tag within this window. */
  throttleMs?: number;
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

/** Apple's push service rejects VAPID subjects on localhost / .local (403 BadJwtToken). */
function warnAboutSubject(subject: string): void {
  if (/localhost|\.local\b|example\.(com|org)/i.test(subject) || !/^(mailto:.+@.+\..+|https:\/\/.+)$/i.test(subject)) {
    console.warn(
      `[push] VAPID_SUBJECT "${subject}" is a placeholder. Apple (iPhone/iPad) rejects these, so iOS ` +
        'notifications will fail. Set VAPID_SUBJECT=mailto:you@yourdomain.com (or https://yourdomain.com) in .env.',
    );
  }
}

function endpointHost(endpoint: string): string {
  try {
    return new URL(endpoint).host;
  } catch {
    return 'unknown';
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
    warnAboutSubject(config.vapidSubject);
    webpush.setVapidDetails(config.vapidSubject, keys.publicKey, keys.privateKey);
  }

  hasSubscribers(userId: string): boolean {
    return pushSubscriptionModel.forUser(userId).length > 0;
  }

  /**
   * Pushes to the user's devices unless the app is on their screen right now (the page
   * shows calls/messages itself then). Every push that is sent must show a notification:
   * iOS cancels the subscription after a few "silent" pushes.
   */
  notify(userId: string, payload: PushPayload, { throttleMs = 0 }: NotifyOptions = {}): void {
    if (userModel.find(userId)?.visible) return;
    const subscriptions = pushSubscriptionModel.forUser(userId);
    if (subscriptions.length === 0) return;

    if (throttleMs > 0) {
      const key = `${userId.toLowerCase()}|${payload.tag}`;
      const last = this.lastSent.get(key) ?? 0;
      if (Date.now() - last < throttleMs) return;
      this.lastSent.set(key, Date.now());
    }
    for (const subscription of subscriptions) void this.send(subscription, payload);
  }

  /** Sends a test notification to all of a user's devices and reports what each push service answered. */
  async sendTest(userId: string): Promise<PushTestResult[]> {
    const payload: PushPayload = {
      type: 'chat',
      title: 'Call9me test notification',
      body: 'Notifications are working on this device.',
      tag: 'test',
      url: '/app',
    };
    return Promise.all(pushSubscriptionModel.forUser(userId).map((s) => this.send(s, payload)));
  }

  private async send(subscription: webpush.PushSubscription, payload: PushPayload): Promise<PushTestResult> {
    const service = endpointHost(subscription.endpoint);
    const urgency = payload.type === 'call' ? 'high' : 'normal';
    // A call push is useless once the call stops ringing.
    const ttl = payload.type === 'call' ? Math.ceil(config.offlineRingTimeoutMs / 1000) : 60 * 60;
    try {
      const res = await webpush.sendNotification(subscription, JSON.stringify(payload), { TTL: ttl, urgency });
      return { service, ok: true, status: res.statusCode };
    } catch (err) {
      const e = err as { statusCode?: number; body?: string; message?: string };
      // 404/410: the device dropped this subscription (e.g. iOS revoked it); forget it.
      if (e.statusCode === 404 || e.statusCode === 410) pushSubscriptionModel.remove(subscription.endpoint);
      const detail = (e.body || e.message || '').toString().slice(0, 200);
      console.warn(`[push] ${service} rejected the push: ${e.statusCode ?? ''} ${detail}`);
      return { service, ok: false, status: e.statusCode ?? 0, error: detail };
    }
  }
}

export const pushService = new PushService();
