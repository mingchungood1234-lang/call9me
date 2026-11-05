import { createHash, randomBytes } from 'node:crypto';
import type { Request, Response } from 'express';
import type { LoginResponse } from '../../shared/types';
import { isValidPin, isValidUserId, PIN_RULES, USER_ID_RULES } from '../../shared/validation';
import { config } from '../config';
import { parseCookies, requestUserId, sessionTokenFrom, setSessionCookie } from '../middleware/session';
import { accountModel } from '../models/AccountModel';
import { sessionModel } from '../models/SessionModel';
import { allowRequest, clientIp, httpLimits } from '../services/RateLimiter';
import { safeNext } from './PageController';

const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const STATE_COOKIE = 'g_state';
const PENDING_COOKIE = 'g_pending';
const FLOW_TTL_MS = 10 * 60 * 1000;

interface Flow {
  verifier: string;
  next: string;
  /** Signed in already: link Google to this ID instead of signing in. */
  linkTo: string | null;
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

function prune(): void {
  const now = Date.now();
  for (const [k, v] of flows) if (v.expires < now) flows.delete(k);
  for (const [k, v] of pending) if (v.expires < now) pending.delete(k);
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
    flows.set(state, {
      verifier,
      next: safeNext(req.query.next),
      linkTo: requestUserId(req) ?? null,
      expires: Date.now() + FLOW_TTL_MS,
    });
    // Ties the attempt to this browser (stops someone sending you their sign-in link).
    shortCookie(req, res, STATE_COOKIE, state);
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
    res.redirect(`${AUTH_URL}?${params}`);
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
      res.redirect('/app?google=linked');
      return;
    }

    const id = accountModel.idForGoogle(sub);
    if (id) {
      GoogleAuthController.signIn(req, res, id, flow.next);
      return;
    }

    // New here: pick an ID (or link an existing one) on the landing page.
    const token = randomBytes(24).toString('base64url');
    pending.set(token, {
      sub,
      email,
      name: typeof claims.name === 'string' ? claims.name : '',
      next: flow.next,
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
