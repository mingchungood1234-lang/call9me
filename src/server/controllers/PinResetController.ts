import type { Request, Response } from 'express';
import { isValidEmail, isValidPin, isValidUserId, PIN_RULES } from '../../shared/validation';
import { config } from '../config';
import { requestUserId } from '../middleware/session';
import { accountModel } from '../models/AccountModel';
import { adminLogModel } from '../models/AdminLogModel';
import { mailEnabled, pinResetMail, recoveryChangedMail, sendMail } from '../services/Mailer';
import { pinResets } from '../services/PinReset';
import { allowRequest, clientIp, httpLimits } from '../services/RateLimiter';
import { AdminController } from './AdminController';

/** The same answer whether or not the ID exists or has an email, so nobody can probe accounts. */
const SENT_MESSAGE = 'If that ID has a recovery email, a reset link is on its way. Check your inbox (and spam).';

/**
 * Sends the reset email for `userId` (if it has an address). Used by "Forgot PIN?" and by
 * admins. @returns where it went, or undefined (no address / email off).
 */
export async function sendPinReset(userId: string): Promise<string | undefined> {
  const id = accountModel.canonicalId(userId);
  const to = id ? accountModel.recoveryEmailOf(id) : undefined;
  if (!id || !to || !mailEnabled()) return undefined;
  const token = pinResets.create(id);
  const link = `${config.publicUrl}/reset-pin?token=${encodeURIComponent(token)}`;
  await sendMail(pinResetMail(to, id, link, Math.round(config.pinResetTtlMs / 60_000)));
  return to;
}

export class PinResetController {
  /** POST /api/forgot-pin { id } — emails a reset link to the ID's recovery address. */
  static async forgot(req: Request, res: Response): Promise<void> {
    if (!mailEnabled()) {
      res.status(503).json({ ok: false, error: 'PIN reset by email is not set up on this server. Ask an admin for a new PIN.' });
      return;
    }
    const { id } = (req.body ?? {}) as { id?: unknown };
    if (!isValidUserId(id)) {
      res.status(400).json({ ok: false, error: 'Enter your ID.' });
      return;
    }
    if (!allowRequest(res, httpLimits.forgotPin, clientIp(req))) return;
    if (!allowRequest(res, httpLimits.forgotPinPerId, id.toLowerCase())) return;
    // Answer at once and the same way every time; the email goes out in the background.
    res.json({ ok: true, message: SENT_MESSAGE });
    if (accountModel.isSuspended(id)) return;
    sendPinReset(id).catch((err) => console.warn('[mail] could not send a PIN reset email:', err instanceof Error ? err.message : err));
  }

  /** POST /api/reset-pin { token, pin } — sets the new PIN; every device is signed out. */
  static async reset(req: Request, res: Response): Promise<void> {
    if (!allowRequest(res, httpLimits.resetPin, clientIp(req))) return;
    const { token, pin } = (req.body ?? {}) as { token?: unknown; pin?: unknown };
    if (!isValidPin(pin)) {
      res.status(400).json({ ok: false, error: PIN_RULES });
      return;
    }
    const key = pinResets.consume(token);
    const id = key ? accountModel.canonicalId(key) : undefined;
    if (!id) {
      res.status(400).json({ ok: false, error: 'This link has expired or was already used. Ask for a new one.' });
      return;
    }
    await accountModel.setPin(id, pin); // also lifts any wrong-PIN lockout
    const count = AdminController.signOutEverywhere(id);
    adminLogModel.add(id, 'self-reset-pin', id, `by email${count ? `, signed out ${count} session(s)` : ''}`);
    res.json({ ok: true, userId: id });
  }

  /** GET /api/account/recovery-email — the signed-in user's recovery email (and whether email works here). */
  static get(req: Request, res: Response): void {
    const userId = requestUserId(req);
    if (!userId) {
      res.status(401).json({ ok: false, error: 'Please sign in.' });
      return;
    }
    res.set('Cache-Control', 'no-store');
    res.json({
      ok: true,
      email: accountModel.ownRecoveryEmailOf(userId) ?? null,
      googleEmail: accountModel.googleEmailOf(userId) ?? null,
      hasPin: accountModel.hasPin(userId),
      mailEnabled: mailEnabled(),
    });
  }

  /**
   * POST /api/account/recovery-email { email, pin } — sets (or with an empty email, removes)
   * it. The current PIN is required, so someone using an unlocked phone can't redirect resets.
   */
  static async set(req: Request, res: Response): Promise<void> {
    const userId = requestUserId(req);
    if (!userId) {
      res.status(401).json({ ok: false, error: 'Please sign in.' });
      return;
    }
    if (!allowRequest(res, httpLimits.login, `recovery:${userId.toLowerCase()}`)) return;
    const { email, pin } = (req.body ?? {}) as { email?: unknown; pin?: unknown };
    const cleaned = typeof email === 'string' ? email.trim() : '';
    if (cleaned && !isValidEmail(cleaned)) {
      res.status(400).json({ ok: false, error: 'That does not look like an email address.' });
      return;
    }
    if (accountModel.hasPin(userId)) {
      if (!isValidPin(pin)) {
        res.status(400).json({ ok: false, error: 'Enter your current PIN to confirm.' });
        return;
      }
      const wrong = await accountModel.verifyPin(userId, pin);
      if (wrong) {
        res.status(401).json({ ok: false, error: wrong });
        return;
      }
    }
    const previous = accountModel.ownRecoveryEmailOf(userId);
    accountModel.setRecoveryEmail(userId, cleaned || undefined);
    res.json({ ok: true, email: cleaned || null });
    // Tell the old address, so a takeover of the recovery email can't go unnoticed.
    if (previous && previous.toLowerCase() !== cleaned.toLowerCase() && mailEnabled()) {
      sendMail(recoveryChangedMail(previous, userId, cleaned)).catch((err) =>
        console.warn('[mail] could not send a recovery-email notice:', err instanceof Error ? err.message : err),
      );
    }
  }
}
