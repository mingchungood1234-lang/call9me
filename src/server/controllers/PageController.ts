import type { Request, Response } from 'express';
import { PIN_RULES, USER_ID_RULES } from '../../shared/validation';
import { config, isAdmin } from '../config';
import { refreshSessionCookie, requestUserId } from '../middleware/session';
import { accountModel } from '../models/AccountModel';
import { googleEnabled, pendingGoogleFor, suggestId } from './GoogleAuthController';

const ERROR_MESSAGES: Record<string, string> = {
  session: 'Please sign in to continue.',
  devices: 'This ID is already open on too many devices. Close it on one of them, or sign out there.',
  google: 'Google sign-in did not complete. Please try again.',
  'google-off': 'Google sign-in is not set up on this server.',
};

/** Only same-site app URLs are allowed as a post-sign-in destination (no open redirects). */
export function safeNext(value: unknown): string {
  return typeof value === 'string' && /^\/app(\?[\w\-=&%.]*)?$/.test(value) ? value : '/app';
}

export class PageController {
  /** GET / — landing page where the user picks an ID and PIN. */
  static landing(req: Request, res: Response): void {
    const code = typeof req.query.error === 'string' ? req.query.error : '';
    // Installed PWAs start at "/": go straight to the app when already signed in.
    if (requestUserId(req) && (!code || code === 'session')) {
      res.redirect(safeNext(req.query.next));
      return;
    }
    // After "Continue with Google" for a new Google account: pick an ID (or link one).
    const google = pendingGoogleFor(req);
    res.render('index', {
      error: ERROR_MESSAGES[code] ?? null,
      rules: USER_ID_RULES,
      pinRules: PIN_RULES,
      googleEnabled: googleEnabled(),
      googlePending: google ? { email: google.email, suggestion: suggestId(google) } : null,
    });
  }

  /** GET /app — the main calling + chat page; requires a signed-in session. */
  static app(req: Request, res: Response): void {
    const userId = requestUserId(req);
    if (!userId) {
      // Keep the target (e.g. a call-room invite link) so sign-in can return to it.
      const next = req.originalUrl !== '/app' ? `&next=${encodeURIComponent(req.originalUrl)}` : '';
      res.redirect(`/?error=session${next}`);
      return;
    }
    // Escape "<" so the JSON can't break out of its <script> tag.
    const iceJson = JSON.stringify(config.iceServers).replace(/</g, '\\u003c');
    res.set('Cache-Control', 'no-store');
    refreshSessionCookie(req, res);
    res.render('app', {
      userId,
      iceJson,
      googleEnabled: googleEnabled(),
      googleEmail: accountModel.googleEmailOf(userId) ?? null,
      admin: isAdmin(userId), // can post in the Public chat
    });
  }
}
