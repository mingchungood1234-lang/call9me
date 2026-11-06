import type { Request, Response } from 'express';
import { PIN_RULES, USER_ID_RULES } from '../../shared/validation';
import { config, isAdmin } from '../config';
import { parseCookies, refreshSessionCookie, requestUserId } from '../middleware/session';
import { accountModel } from '../models/AccountModel';
import { androidApp } from '../services/AndroidApp';
import { mailEnabled } from '../services/Mailer';
import { pinResets } from '../services/PinReset';
import { adminPasscodeSet } from './AdminController';
import { APP_FLOW_COOKIE, googleEnabled, pendingGoogleFor, suggestId } from './GoogleAuthController';

const ERROR_MESSAGES: Record<string, string> = {
  session: 'Please sign in to continue.',
  devices: 'This ID is already open on too many devices. Close it on one of them, or sign out there.',
  suspended: 'This ID has been suspended by an admin.',
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
      // Keep the Android app's launch marker (?twa=1) so /app knows it runs inside the app.
      const next = safeNext(req.query.next);
      res.redirect(req.query.twa === '1' ? `${next}${next.includes('?') ? '&' : '?'}twa=1` : next);
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
      mailEnabled: mailEnabled(),
      reset: null,
    });
  }

  /**
   * GET /get-app — Android browsers are sent here (views/partials/head.ejs): Call9me on Android
   * is the app, not the website or PWA. Download it, or open it when already installed.
   */
  static getApp(req: Request, res: Response): void {
    const app = androidApp();
    // Same-site paths only (never "//other.site").
    const next = typeof req.query.next === 'string' && /^\/(?!\/)[\w\-/?=&%.]*$/.test(req.query.next) ? req.query.next : '/';
    if (!app) {
      res.redirect(next);
      return;
    }
    // Opens the installed app at the same page (e.g. a call link); without it, back to this page.
    const host = req.hostname;
    const fallback = encodeURIComponent(`https://${host}/get-app`);
    const inApp = `${next}${next.includes('?') ? '&' : '?'}twa=1`;
    const openUrl = `intent://${host}${inApp}#Intent;scheme=https;package=${app.packageName};S.browser_fallback_url=${fallback};end`;
    res.set('Cache-Control', 'no-store');
    res.render('get-app', { next, openUrl, versionName: app.versionName, sizeMb: (app.size / 1024 / 1024).toFixed(1) });
  }

  /** GET /reset-pin?token=… — the link from a "Forgot PIN?" email: choose a new PIN. */
  static resetPin(req: Request, res: Response): void {
    const token = typeof req.query.token === 'string' ? req.query.token : '';
    const key = pinResets.peek(token);
    res.set('Cache-Control', 'no-store');
    res.set('Referrer-Policy', 'no-referrer'); // the token is in the URL
    res.render('index', {
      error: key ? null : 'This reset link has expired or was already used. Ask for a new one below.',
      rules: USER_ID_RULES,
      pinRules: PIN_RULES,
      googleEnabled: false,
      googlePending: null,
      mailEnabled: mailEnabled(),
      reset: key ? { token, userId: accountModel.canonicalId(key) ?? key } : null,
    });
  }

  /** GET /admin — the admin dashboard: admins only (everyone else gets a 404); unlocked with ADMIN_PASSCODE. */
  static admin(req: Request, res: Response): void {
    const userId = requestUserId(req);
    if (!userId) {
      res.redirect('/?error=session');
      return;
    }
    if (!isAdmin(userId)) {
      res.status(404).send('Not found');
      return;
    }
    res.set('Cache-Control', 'no-store');
    refreshSessionCookie(req, res);
    res.render('admin', { userId, passcodeSet: adminPasscodeSet() });
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
    // A Custom Tab finishing "Continue with Google" for the Android app: hand the sign-in to the app.
    if (parseCookies(req.headers.cookie)[APP_FLOW_COOKIE]) {
      res.redirect('/auth/app-return');
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
