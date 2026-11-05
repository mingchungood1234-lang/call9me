import { randomBytes, randomInt } from 'node:crypto';
import type { Request, Response } from 'express';
import type { PairInfoResponse, PairStartResponse, PairStatusResponse } from '../../shared/types';
import { config } from '../config';
import { parseCookies, requestUserId, sessionTokenFrom, setSessionCookie } from '../middleware/session';
import { sessionModel } from '../models/SessionModel';
import { allowRequest, clientIp, httpLimits } from '../services/RateLimiter';

const PAIR_COOKIE = 'c9m_pair';
/** No 0/O, 1/I/L: the code may be typed in by hand. 8 characters ≈ 40 bits. */
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 8;
const MAX_PENDING = 1000;

interface Pairing {
  code: string;
  /** Kept in the waiting device's cookie: only that browser can collect the sign-in. */
  secret: string;
  /** "Chrome on Windows", shown on the approving device. */
  device: string;
  createdAt: number;
  expiresAt: number;
  /** Set once a signed-in device approves it. */
  approvedBy?: string;
}

/** code → pairing */
const pairings = new Map<string, Pairing>();

function prune(): void {
  const now = Date.now();
  for (const [code, p] of pairings) if (p.expiresAt <= now) pairings.delete(code);
}

function newCode(): string {
  let code: string;
  do {
    code = Array.from({ length: CODE_LENGTH }, () => CODE_ALPHABET[randomInt(CODE_ALPHABET.length)]).join('');
  } while (pairings.has(code));
  return code;
}

/** Accepts "ABCD-EFGH", "abcd efgh" or a whole sign-in URL with ?pair=… */
function normalizeCode(raw: unknown): string | null {
  if (typeof raw !== 'string' || raw.length > 300) return null;
  let value = raw.trim();
  const fromUrl = /[?&]pair=([A-Za-z0-9-]+)/.exec(value);
  if (fromUrl) value = fromUrl[1];
  value = value.replace(/[\s-]/g, '').toUpperCase();
  return value.length === CODE_LENGTH && [...value].every((c) => CODE_ALPHABET.includes(c)) ? value : null;
}

/** A rough, human name for the requesting browser ("Safari on iPhone"). */
export function describeDevice(userAgent: string | undefined): string {
  const ua = userAgent ?? '';
  const browser = /Edg\//.test(ua)
    ? 'Edge'
    : /SamsungBrowser/.test(ua)
      ? 'Samsung Internet'
      : /Firefox\/|FxiOS/.test(ua)
        ? 'Firefox'
        : /Chrome\/|CriOS/.test(ua)
          ? 'Chrome'
          : /Safari\//.test(ua)
            ? 'Safari'
            : 'A browser';
  const os = /iPhone/.test(ua)
    ? 'iPhone'
    : /iPad/.test(ua)
      ? 'iPad'
      : /Android/.test(ua)
        ? 'Android'
        : /Windows/.test(ua)
          ? 'Windows'
          : /Mac OS X|Macintosh/.test(ua)
            ? 'Mac'
            : /CrOS/.test(ua)
              ? 'ChromeOS'
              : /Linux/.test(ua)
                ? 'Linux'
                : 'an unknown device';
  return `${browser} on ${os}`;
}

function siteOrigin(req: Request): string {
  return config.publicUrl || `${req.protocol}://${req.get('host')}`;
}

/**
 * "Sign in with a QR code": a new device shows a QR code (and the same code as text); a
 * device that's already signed in scans it, sees which browser is asking, and approves.
 * The new device, polling meanwhile, then gets its own session. Codes are single use
 * and expire after a couple of minutes.
 */
export class PairingController {
  /** POST /api/pair/start — from the sign-in page of the new device. */
  static start(req: Request, res: Response<PairStartResponse>): void {
    if (!allowRequest(res, httpLimits.pairStart, clientIp(req))) return;
    prune();
    if (pairings.size >= MAX_PENDING) {
      res.status(503).json({ ok: false, error: 'Too many sign-in requests right now. Try again in a minute.' });
      return;
    }
    // A new code replaces this browser's previous one.
    const previous = parseCookies(req.headers.cookie)[PAIR_COOKIE];
    for (const [code, p] of pairings) if (p.secret === previous) pairings.delete(code);

    const now = Date.now();
    const pairing: Pairing = {
      code: newCode(),
      secret: randomBytes(24).toString('base64url'),
      device: describeDevice(req.get('user-agent')),
      createdAt: now,
      expiresAt: now + config.pairingTtlMs,
    };
    pairings.set(pairing.code, pairing);
    res.cookie(PAIR_COOKIE, pairing.secret, {
      httpOnly: true,
      sameSite: 'lax',
      secure: req.secure,
      maxAge: config.pairingTtlMs,
      path: '/api/pair',
    });
    const url = new URL('/app', siteOrigin(req));
    url.searchParams.set('pair', pairing.code);
    res.json({ ok: true, code: pairing.code, url: url.toString(), expiresAt: pairing.expiresAt });
  }

  /** GET /api/pair/status — the new device waiting; signs it in once approved. */
  static status(req: Request, res: Response<PairStatusResponse>): void {
    if (!allowRequest(res, httpLimits.pairPoll, clientIp(req))) return;
    const secret = parseCookies(req.headers.cookie)[PAIR_COOKIE];
    const pairing = secret ? [...pairings.values()].find((p) => p.secret === secret) : undefined;
    if (!pairing || pairing.expiresAt <= Date.now()) {
      if (pairing) pairings.delete(pairing.code);
      res.json({ ok: true, status: 'expired' });
      return;
    }
    if (!pairing.approvedBy) {
      res.json({ ok: true, status: 'pending' });
      return;
    }
    pairings.delete(pairing.code); // single use
    res.clearCookie(PAIR_COOKIE, { path: '/api/pair' });
    sessionModel.destroy(sessionTokenFrom(req.headers.cookie));
    setSessionCookie(req, res, sessionModel.create(pairing.approvedBy));
    res.json({ ok: true, status: 'approved', userId: pairing.approvedBy });
  }

  /** POST /api/pair/info { code } — the signed-in device, before approving: who's asking? */
  static info(req: Request, res: Response<PairInfoResponse>): void {
    const pairing = PairingController.pending(req, res);
    if (!pairing) return;
    res.json({ ok: true, code: pairing.code, device: pairing.device, ageMs: Date.now() - pairing.createdAt });
  }

  /** POST /api/pair/approve { code } — the signed-in device lets the new one in as the same user. */
  static approve(req: Request, res: Response<PairInfoResponse>): void {
    const pairing = PairingController.pending(req, res);
    if (!pairing) return;
    pairing.approvedBy = requestUserId(req);
    console.log(`[pair] ${pairing.approvedBy} signed in ${pairing.device} with a QR code`);
    res.json({ ok: true, code: pairing.code, device: pairing.device, ageMs: Date.now() - pairing.createdAt });
  }

  /** The signed-in caller's pairing request by code, or an error response (and undefined). */
  private static pending(req: Request, res: Response<PairInfoResponse>): Pairing | undefined {
    const userId = requestUserId(req);
    if (!userId) {
      res.status(401).json({ ok: false, error: 'Sign in on this device first.' });
      return undefined;
    }
    if (!allowRequest(res, httpLimits.pairApprove, userId.toLowerCase())) return undefined;
    const code = normalizeCode((req.body as { code?: unknown } | undefined)?.code);
    const pairing = code ? pairings.get(code) : undefined;
    if (!pairing || pairing.expiresAt <= Date.now() || pairing.approvedBy) {
      res.status(404).json({ ok: false, error: 'That code is wrong or has expired. Get a new one on the other device.' });
      return undefined;
    }
    return pairing;
  }
}
