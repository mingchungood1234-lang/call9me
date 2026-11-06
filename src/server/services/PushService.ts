import fs from 'node:fs';
import path from 'node:path';
import webpush from 'web-push';
import type { PushPayload, PushTestResult } from '../../shared/types';
import { config } from '../config';
import { fcmTokenModel } from '../models/FcmTokenModel';
import { pushSubscriptionModel } from '../models/PushSubscriptionModel';
import { userModel } from '../models/UserModel';
import { userStatusModel } from '../models/UserStatusModel';
import { fcm } from './Fcm';

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
  if (
    /localhost|\.local\b|example\.(com|org)|yourdomain|\s/i.test(subject) ||
    !/^(mailto:[^@\s]+@[^@\s]+\.[a-z]{2,}|https:\/\/[^\s]+\.[a-z]{2,}\/?)$/i.test(subject)
  ) {
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
    // If this key changes between deploys, existing subscriptions break (Apple: BadJwtToken)
    // until each device re-subscribes — the app does that automatically on next open.
    console.log(`[push] VAPID subject: ${config.vapidSubject} · public key: ${keys.publicKey.slice(0, 16)}…`);
    webpush.setVapidDetails(config.vapidSubject, keys.publicKey, keys.privateKey);
  }

  /** Whether the user can be reached while offline: a browser/PWA subscription or the Android app. */
  hasSubscribers(userId: string): boolean {
    return pushSubscriptionModel.forUser(userId).length > 0 || this.androidTokens(userId).length > 0;
  }

  private androidTokens(userId: string): string[] {
    return fcm.enabled ? fcmTokenModel.forUser(userId) : [];
  }

  /**
   * Pushes to the user's devices unless the app is on their screen right now (the page
   * shows calls/messages itself then). Every push that is sent must show a notification:
   * iOS cancels the subscription after a few "silent" pushes.
   */
  notify(userId: string, payload: PushPayload, { throttleMs = 0 }: NotifyOptions = {}): void {
    if (userModel.isVisible(userId)) return;
    if (userStatusModel.get(userId) === 'dnd') return; // Do not disturb: no notifications at all
    const subscriptions = pushSubscriptionModel.forUser(userId);
    const androidTokens = this.androidTokens(userId);
    if (subscriptions.length === 0 && androidTokens.length === 0) return;

    if (throttleMs > 0) {
      const key = `${userId.toLowerCase()}|${payload.tag}`;
      const last = this.lastSent.get(key) ?? 0;
      if (Date.now() - last < throttleMs) return;
      this.lastSent.set(key, Date.now());
    }
    for (const subscription of subscriptions) void this.send(subscription, payload);
    for (const token of androidTokens) void this.sendAndroid(token, payload);
  }

  /**
   * An invite stopped ringing (answered, declined, cancelled, timed out): the Android app
   * stops its ringtone and call screen. Sent even while the app is visible, since the phone
   * may ring on its own.
   */
  stopRinging(userId: string, callId: string): void {
    for (const token of this.androidTokens(userId)) {
      void this.sendAndroidData(token, { type: 'call-end', callId }, { high: true, ttlSeconds: 60 });
    }
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
    return Promise.all([
      ...pushSubscriptionModel.forUser(userId).map((s) => this.send(s, payload)),
      ...this.androidTokens(userId).map((t) => this.sendAndroid(t, payload)),
    ]);
  }

  /** The Android app gets data messages and builds its own notifications (full-screen call, etc.). */
  private sendAndroid(token: string, payload: PushPayload): Promise<PushTestResult> {
    const data: Record<string, string> = {
      type: payload.type,
      title: payload.title,
      body: payload.body,
      tag: payload.tag,
      url: payload.url,
    };
    if (payload.callId) data.callId = payload.callId;
    if (payload.icon) data.icon = payload.icon;
    if (payload.from) data.from = payload.from;
    if (payload.video !== undefined) data.video = payload.video ? '1' : '0';
    const call = payload.type === 'call';
    return this.sendAndroidData(token, data, {
      high: call,
      ttlSeconds: call ? Math.ceil(config.offlineRingTimeoutMs / 1000) : 60 * 60,
    });
  }

  private async sendAndroidData(
    token: string,
    data: Record<string, string>,
    opts: { high: boolean; ttlSeconds: number },
  ): Promise<PushTestResult> {
    const result = await fcm.send(token, data, opts);
    if (result.unregistered) fcmTokenModel.remove(token);
    if (!result.ok) console.warn(`[fcm] push rejected: ${result.status} ${result.error ?? ''}`);
    return { service: 'fcm.googleapis.com (Android app)', ok: result.ok, status: result.status, error: result.error };
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
