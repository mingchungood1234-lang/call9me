import type { Request, Response } from 'express';
import type { PushSubscriptionJSON } from '../../shared/types';
import { requestUserId } from '../middleware/session';
import { pushSubscriptionModel } from '../models/PushSubscriptionModel';
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
  }

  /** POST /api/push/unsubscribe { endpoint } */
  static unsubscribe(req: Request, res: Response): void {
    const userId = requestUserId(req);
    const { endpoint } = (req.body ?? {}) as { endpoint?: unknown };
    if (userId && typeof endpoint === 'string') pushSubscriptionModel.removeForUser(userId, endpoint);
    res.json({ ok: true });
  }
}
