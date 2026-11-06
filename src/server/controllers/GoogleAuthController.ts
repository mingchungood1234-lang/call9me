import { createHash, randomBytes } from 'node:crypto';
import type { Request, Response } from 'express';
import type { LoginResponse } from '../../shared/types';
import { isValidPin, isValidUserId, PIN_RULES, USER_ID_RULES } from '../../shared/validation';
import { config } from '../config';
import { parseCookies, requestUserId, SESSION_COOKIE, sessionTokenFrom, setSessionCookie } from '../middleware/session';
import { accountModel } from '../models/AccountModel';
import { sessionModel } from '../models/SessionModel';
import { allowRequest, clientIp, httpLimits } from '../services/RateLimiter';
import { androidApp } from '../services/AndroidApp';
import { safeNext } from './PageController';

const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const STATE_COOKIE = 'g_state';
const PENDING_COOKIE = 'g_pending';
/** Set in the Custom Tab while a sign-in for the Android app is in progress (see head.ejs). */
export const APP_FLOW_COOKIE = 'c9m_app_flow';
const FLOW_TTL_MS = 10 * 60 * 1000;
/** How long the app has to pick up a sign-in handed over from the Custom Tab. */
const HANDOFF_TTL_MS = 2 * 60 * 1000;

/** The native Android app (WebView) adds "Call9meAndroid/<version>" to its user agent. */
export function isAndroidAppRequest(req: Request): boolean {
  return /\bCall9meAndroid\//.test(req.get('user-agent') ?? '');
}

interface Flow {
  verifier: string;
  next: string;
  /** Signed in already: link Google to this ID instead of signing in. */
  linkTo: string | null;
  /** Started in the Android app: finish in a Custom Tab, then hand the session back to the app. */
  app: boolean;
  expires: number;
}

/** A Google account that has no Call9me ID yet: the user picks one (or links an existing one). */
export interface PendingGoogle {
  sub: string;
  email: string;
  name: string;
  next: string;
  expires: number;
}

/** state → flow (one sign-in attempt). */
const flows = new Map<string, Flow>();
/** token (cookie) → Google account waiting for an ID. */
const pending = new Map<string, PendingGoogle>();
/** Android app: ticket (opened in the Custom Tab) → state of the flow it continues. */
const tickets = new Map<string, { state: string; expires: number }>();
/** Android app: one-time token (sent to the app) → the user it signs in. */
const handoffs = new Map<string, { userId: string; expires: number }>();

function prune(): void {
  const now = Date.now();
  for (const [k, v] of flows) if (v.expires < now) flows.delete(k);
  for (const [k, v] of pending) if (v.expires < now) pending.delete(k);
  for (const [k, v] of tickets) if (v.expires < now) tickets.delete(k);
  for (const [k, v] of handoffs) if (v.expires < now) handoffs.delete(k);
}

function googleAuthUrl(req: Request, state: string, verifier: string): string {
  const params = new URLSearchParams({
    client_id: config.google.clientId,
    redirect_uri: redirectUri(req),
    response_type: 'code',
    scope: 'openid email profile',
    state,
    code_challenge: createHash('sha256').update(verifier).digest('base64url'),
    code_challenge_method: 'S256',
    prompt: 'select_account',
  });
  return `${AUTH_URL}?${params}`;
}

/**
 * Ends a Custom Tab sign-in for the Android app: a page that opens the app (explicitly by
 * package, so no other app can catch the token) at `path`, which signs the app in.
 */
function renderReturnToApp(req: Request, res: Response, path: string): void {
  res.clearCookie(APP_FLOW_COOKIE, { path: '/' });
  const pkg = androidApp()?.packageName ?? (process.env.ANDROID_PACKAGE?.trim() || 'com.call9me.app');
  const intentUrl = `intent://${req.hostname}${path}#Intent;scheme=https;package=${pkg};end`;
  res.set('Cache-Control', 'no-store');
  res.set('Referrer-Policy', 'no-referrer');
  res.render('app-return', { intentUrl });
}

/** One-time token the app redeems at /auth/app to get its own session for `userId`. */
function handoffPath(userId: string): string {
  prune();
  const token = randomBytes(24).toString('base64url');
  handoffs.set(token, { userId, expires: Date.now() + HANDOFF_TTL_MS });
  return `/auth/app?token=${token}`;
}

export function googleEnabled(): boolean {
  return !!(config.google.clientId && config.google.clientSecret);
}

function redirectUri(req: Request): string {
  const base = config.publicUrl || `${req.protocol}://${req.get('host')}`;
  return `${base}/auth/google/callback`;
}

function shortCookie(req: Request, res: Response, name: string, value: string): void {
  res.cookie(name, value, { httpOnly: true, sameSite: 'lax', secure: req.secure, maxAge: FLOW_TTL_MS, path: '/' });
}

/** The Google account waiting for an ID in this browser, if any (for the landing page). */
export function pendingGoogleFor(req: Request): PendingGoogle | undefined {
  prune();
  const token = parseCookies(req.headers.cookie)[PENDING_COOKIE];
  return token ? pending.get(token) : undefined;
}

/** A free ID suggestion from the Google name or email ("Mary Ann" → "Mary_Ann"). */
export function suggestId(p: PendingGoogle): string {
  const base = (p.name || p.email.split('@')[0])
    .normalize('NFKD')
    .replace(/[^A-Za-z0-9_ ]/g, '')
    .trim()
    .replace(/\s+/g, '_')
    .slice(0, 16);
  let candidate = /^[A-Za-z]/.test(base) ? base : `u_${base}`;
  if (candidate.length < 3) candidate = `user_${randomBytes(2).toString('hex')}`;
  for (let n = 2; accountModel.exists(candidate) && n < 1000; n++) candidate = `${candidate.slice(0, 16)}${n}`;
  return isValidUserId(candidate) ? candidate : '';
}

/** Reads the claims of an ID token received straight from Google's token endpoint (over TLS). */
function decodeIdToken(idToken: string): Record<string, unknown> | null {
  try {
    return JSON.parse(Buffer.from(idToken.split('.')[1] ?? '', 'base64url').toString('utf8'));
  } catch {
    return null;
  }
}

/** "Continue with Google": OAuth 2.0 authorization code flow with PKCE. */
export class GoogleAuthController {
  /** GET /auth/google?next=…  (when signed in: links Google to the current ID) */
  static start(req: Request, res: Response): void {
    if (!googleEnabled()) {
      res.redirect('/?error=google-off');
      return;
    }
    prune();
    const state = randomBytes(16).toString('base64url');
    const verifier = randomBytes(32).toString('base64url');
    const app = isAndroidAppRequest(req);
    flows.set(state, {
      verifier,
      next: safeNext(req.query.next),
      linkTo: requestUserId(req) ?? null,
      app,
      expires: Date.now() + FLOW_TTL_MS,
    });
    if (app) {
      // Google refuses sign-in inside an app's WebView: the app opens this URL in a Custom Tab
      // (a real browser), which continues the same flow.
      const ticket = randomBytes(24).toString('base64url');
      tickets.set(ticket, { state, expires: Date.now() + FLOW_TTL_MS });
      res.redirect(`/auth/google/continue?ticket=${ticket}`);
      return;
    }
    // Ties the attempt to this browser (stops someone sending you their sign-in link).
    shortCookie(req, res, STATE_COOKIE, state);
    res.redirect(googleAuthUrl(req, state, verifier));
  }

  /** GET /auth/google/continue?ticket=… — in the Custom Tab: the app's sign-in goes on to Google. */
  static continueInBrowser(req: Request, res: Response): void {
    prune();
    const ticket = typeof req.query.ticket === 'string' ? req.query.ticket : '';
    const entry = tickets.get(ticket);
    tickets.delete(ticket);
    const flow = entry ? flows.get(entry.state) : undefined;
    if (!entry || !flow) {
      res.redirect('/?error=google');
      return;
    }
    shortCookie(req, res, STATE_COOKIE, entry.state);
    shortCookie(req, res, APP_FLOW_COOKIE, '1');
    res.redirect(googleAuthUrl(req, entry.state, flow.verifier));
  }

  /** GET /auth/app-return — in the Custom Tab, after picking a new ID: move that sign-in to the app. */
  static appReturn(req: Request, res: Response): void {
    const userId = requestUserId(req);
    if (!userId) {
      res.redirect('/');
      return;
    }
    // The browser's own session isn't needed: the app gets a fresh one.
    sessionModel.destroy(sessionTokenFrom(req.headers.cookie));
    res.clearCookie(SESSION_COOKIE, { path: '/' });
    renderReturnToApp(req, res, handoffPath(userId));
  }

  /** GET /auth/app?token=… — in the app: redeem the one-time token for the app's own session. */
  static appRedeem(req: Request, res: Response): void {
    prune();
    const token = typeof req.query.token === 'string' ? req.query.token : '';
    const handoff = handoffs.get(token);
    handoffs.delete(token);
    if (!handoff || !isAndroidAppRequest(req)) {
      res.redirect('/?error=google');
      return;
    }
    if (accountModel.isSuspended(handoff.userId)) {
      res.redirect('/?error=suspended');
      return;
    }
    sessionModel.destroy(sessionTokenFrom(req.headers.cookie));
    setSessionCookie(req, res, sessionModel.create(handoff.userId));
    res.redirect('/app');
  }

  /** GET /auth/google/callback?code=…&state=… */
  static async callback(req: Request, res: Response): Promise<void> {
    const state = typeof req.query.state === 'string' ? req.query.state : '';
    const flow = flows.get(state);
    flows.delete(state);
    res.clearCookie(STATE_COOKIE, { path: '/' });
    if (!flow || flow.expires < Date.now() || parseCookies(req.headers.cookie)[STATE_COOKIE] !== state) {
      res.redirect('/?error=google');
      return;
    }
    if (typeof req.query.code !== 'string') {
      res.redirect(flow.linkTo ? '/app' : '/'); // cancelled on Google's page
      return;
    }

    let claims: Record<string, unknown> | null = null;
    try {
      const tokenRes = await fetch(TOKEN_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          code: req.query.code,
          client_id: config.google.clientId,
          client_secret: config.google.clientSecret,
          redirect_uri: redirectUri(req),
          grant_type: 'authorization_code',
          code_verifier: flow.verifier,
        }),
      });
      const data = (await tokenRes.json()) as { id_token?: string; error?: string };
      if (!tokenRes.ok || !data.id_token) throw new Error(data.error ?? `HTTP ${tokenRes.status}`);
      claims = decodeIdToken(data.id_token);
    } catch (err) {
      console.warn('[google] token exchange failed:', err);
    }

    const valid =
      claims &&
      claims.aud === config.google.clientId &&
      (claims.iss === 'https://accounts.google.com' || claims.iss === 'accounts.google.com') &&
      typeof claims.exp === 'number' &&
      claims.exp * 1000 > Date.now() &&
      typeof claims.sub === 'string' &&
      claims.email_verified === true &&
      typeof claims.email === 'string';
    if (!valid || !claims) {
      res.redirect('/?error=google');
      return;
    }
    const sub = claims.sub as string;
    const email = claims.email as string;

    // Signed in already: link this Google account to the current ID.
    if (flow.linkTo && accountModel.exists(flow.linkTo)) {
      accountModel.linkGoogle(flow.linkTo, sub, email);
      if (flow.app) renderReturnToApp(req, res, '/app?google=linked'); // the app is still signed in
      else res.redirect('/app?google=linked');
      return;
    }

    const id = accountModel.idForGoogle(sub);
    if (id) {
      if (flow.app) {
        if (accountModel.isSuspended(id)) res.redirect('/?error=suspended');
        else renderReturnToApp(req, res, handoffPath(id));
        return;
      }
      GoogleAuthController.signIn(req, res, id, flow.next);
      return;
    }

    // New here: pick an ID (or link an existing one) on the landing page.
    const token = randomBytes(24).toString('base64url');
    pending.set(token, {
      sub,
      email,
      name: typeof claims.name === 'string' ? claims.name : '',
      // App: after picking an ID here, the sign-in moves over to the app.
      next: flow.app ? '/auth/app-return' : flow.next,
      expires: Date.now() + FLOW_TTL_MS,
    });
    shortCookie(req, res, PENDING_COOKIE, token);
    res.redirect('/?google=choose');
  }

  /** POST /api/google/complete { id, pin? } — finishes a first Google sign-in: new ID, or link an existing one (with its PIN). */
  static async complete(req: Request, res: Response<LoginResponse & { next?: string }>): Promise<void> {
    const token = parseCookies(req.headers.cookie)[PENDING_COOKIE];
    const p = token ? pending.get(token) : undefined;
    if (!token || !p || p.expires < Date.now()) {
      res.status(400).json({ ok: false, error: 'Google sign-in expired. Please try again.' });
      return;
    }
    const { id, pin } = (req.body ?? {}) as { id?: unknown; pin?: unknown };
    if (!isValidUserId(id)) {
      res.status(400).json({ ok: false, error: `Invalid ID. ${USER_ID_RULES}` });
      return;
    }
    if (!allowRequest(res, httpLimits.login, clientIp(req))) return;

    let finalId: string;
    let created = false;
    if (pin !== undefined && pin !== '') {
      // Link to an existing ID, proven with its PIN.
      if (!isValidPin(pin)) {
        res.status(400).json({ ok: false, error: PIN_RULES });
        return;
      }
      if (!accountModel.exists(id)) {
        res.status(404).json({ ok: false, error: `There is no ID "${id}". Leave the PIN empty to create it.` });
        return;
      }
      const result = await accountModel.login(id, pin);
      if (!result.ok) {
        res.status(401).json(result);
        return;
      }
      finalId = result.id;
      accountModel.linkGoogle(finalId, p.sub, p.email);
    } else {
      if (!accountModel.createWithGoogle(id, p.sub, p.email)) {
        res.status(409).json({ ok: false, error: `"${id}" is taken. Pick another ID, or enter its PIN to link it.` });
        return;
      }
      finalId = id;
      created = true;
    }

    pending.delete(token);
    res.clearCookie(PENDING_COOKIE, { path: '/' });
    sessionModel.destroy(sessionTokenFrom(req.headers.cookie));
    setSessionCookie(req, res, sessionModel.create(finalId));
    res.json({ ok: true, userId: finalId, created, next: p.next });
  }

  private static signIn(req: Request, res: Response, id: string, next: string): void {
    if (accountModel.isSuspended(id)) {
      res.redirect('/?error=suspended');
      return;
    }
    sessionModel.destroy(sessionTokenFrom(req.headers.cookie));
    setSessionCookie(req, res, sessionModel.create(id));
    res.redirect(next);
  }
}
