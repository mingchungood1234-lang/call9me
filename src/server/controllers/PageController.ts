import type { Request, Response } from 'express';
import { PIN_RULES, USER_ID_RULES } from '../../shared/validation';
import { config } from '../config';
import { requestUserId } from '../middleware/session';

const ERROR_MESSAGES: Record<string, string> = {
  session: 'Please sign in to continue.',
  taken: 'This ID is already open in another tab or device.',
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
    res.render('index', { error: ERROR_MESSAGES[code] ?? null, rules: USER_ID_RULES, pinRules: PIN_RULES });
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
    res.render('app', { userId, iceJson });
  }
}
