import type { Request, Response } from 'express';
import type { PushSubscriptionJSON } from '../../shared/types';
import { requestUserId } from '../middleware/session';
import { CallController } from './CallController';
import { fcmTokenModel } from '../models/FcmTokenModel';
import { pushSubscriptionModel } from '../models/PushSubscriptionModel';
import { fcm } from '../services/Fcm';
import { pushService } from '../services/PushService';

/** Decoded byte length of a base64url string, or -1 if it isn't base64url. */
function base64UrlBytes(value: unknown): number {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+=*$/.test(value)) return -1;
  return Buffer.from(value, 'base64url').length;
}

function isSubscription(value: unknown): value is PushSubscriptionJSON {
  const v = value as PushSubscriptionJSON | undefined;
  return (
    !!v &&
    typeof v.endpoint === 'string' &&
    /^https:\/\//.test(v.endpoint) &&
    v.endpoint.length < 2000 &&
    base64UrlBytes(v.keys?.p256dh) === 65 && // uncompressed P-256 public key
    base64UrlBytes(v.keys?.auth) === 16
  );
}

export class PushController {
  /** GET /api/push/key — VAPID public key for PushManager.subscribe(). */
  static publicKey(_req: Request, res: Response): void {
    res.json({ publicKey: pushService.publicKey });
  }

  /** POST /api/push/subscribe { subscription } — requires a session. */
  static subscribe(req: Request, res: Response): void {
    const userId = requestUserId(req);
    if (!userId) {
      res.status(401).json({ ok: false, error: 'Not signed in' });
      return;
    }
    const { subscription } = (req.body ?? {}) as { subscription?: unknown };
    if (!isSubscription(subscription)) {
      res.status(400).json({ ok: false, error: 'Invalid subscription' });
      return;
    }
    pushSubscriptionModel.add(userId, {
      endpoint: subscription.endpoint,
      keys: { p256dh: subscription.keys.p256dh, auth: subscription.keys.auth },
    });
    res.json({ ok: true });
    // Reachable-while-offline status changed: refresh everyone's people list.
    CallController.signaling?.broadcastUsers();
  }

  /** POST /api/push/test — sends a test notification to all of my devices and reports each push service's answer. */
  static async test(req: Request, res: Response): Promise<void> {
    const userId = requestUserId(req);
    if (!userId) {
      res.status(401).json({ ok: false, error: 'Not signed in' });
      return;
    }
    const results = await pushService.sendTest(userId);
    res.json({ ok: results.length > 0 && results.every((r) => r.ok), results });
  }

  /** POST /api/push/android { token } — the Android app's Firebase token for this user (requires a session). */
  static androidRegister(req: Request, res: Response): void {
    const userId = requestUserId(req);
    if (!userId) {
      res.status(401).json({ ok: false, error: 'Not signed in' });
      return;
    }
    const { token } = (req.body ?? {}) as { token?: unknown };
    if (typeof token !== 'string' || !/^[\w:.-]{20,4096}$/.test(token)) {
      res.status(400).json({ ok: false, error: 'Invalid token' });
      return;
    }
    if (!fcm.enabled) {
      res.status(503).json({ ok: false, error: 'Android push is not set up on this server' });
      return;
    }
    fcmTokenModel.add(userId, token);
    res.json({ ok: true });
    CallController.signaling?.broadcastUsers();
  }

  /** POST /api/push/android/remove { token } — e.g. on sign-out or when notifications are turned off. */
  static androidRemove(req: Request, res: Response): void {
    const userId = requestUserId(req);
    const { token } = (req.body ?? {}) as { token?: unknown };
    if (userId && typeof token === 'string') fcmTokenModel.removeForUser(userId, token);
    res.json({ ok: true });
    CallController.signaling?.broadcastUsers();
  }

  /** POST /api/push/unsubscribe { endpoint } */
  static unsubscribe(req: Request, res: Response): void {
    const userId = requestUserId(req);
    const { endpoint } = (req.body ?? {}) as { endpoint?: unknown };
    if (userId && typeof endpoint === 'string') pushSubscriptionModel.removeForUser(userId, endpoint);
    res.json({ ok: true });
    CallController.signaling?.broadcastUsers();
  }
}
