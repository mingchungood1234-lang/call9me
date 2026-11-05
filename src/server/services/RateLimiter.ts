import type { Request, Response } from 'express';

/**
 * Counts attempts per key (an IP address, a user ID…) in fixed time windows. In memory:
 * a restart forgets the counts, which is fine for slowing down floods and guessing.
 */
export class RateLimiter {
  private readonly hits = new Map<string, { count: number; resetAt: number }>();

  constructor(
    readonly limit: number,
    readonly windowMs: number,
  ) {
    setInterval(() => this.prune(), Math.max(windowMs, 60_000)).unref();
  }

  /** Counts one attempt. @returns 0 if it's allowed, else the milliseconds until it would be. */
  take(key: string): number {
    const now = Date.now();
    const entry = this.hits.get(key);
    if (!entry || entry.resetAt <= now) {
      this.hits.set(key, { count: 1, resetAt: now + this.windowMs });
      return 0;
    }
    if (entry.count >= this.limit) return entry.resetAt - now;
    entry.count++;
    return 0;
  }

  private prune(): void {
    const now = Date.now();
    for (const [key, entry] of this.hits) if (entry.resetAt <= now) this.hits.delete(key);
  }
}

/** "Try again in 40s" / "in 3 min". */
export function retryText(ms: number): string {
  const seconds = Math.ceil(ms / 1000);
  return seconds < 120 ? `${seconds}s` : `${Math.ceil(seconds / 60)} min`;
}

/**
 * Counts one request against `limiter` for `key`; if it's over the limit, answers 429
 * (with Retry-After) and @returns false.
 */
export function allowRequest(res: Response, limiter: RateLimiter, key: string): boolean {
  const wait = limiter.take(key);
  if (wait === 0) return true;
  res.set('Retry-After', String(Math.ceil(wait / 1000)));
  res.status(429).json({ ok: false, error: `Too many attempts. Try again in ${retryText(wait)}.` });
  return false;
}

/** The client's address (needs TRUST_PROXY behind a reverse proxy, else it's the proxy's). */
export function clientIp(req: Request): string {
  return req.ip ?? req.socket.remoteAddress ?? 'unknown';
}

/** Limits on the HTTP sign-in endpoints, per IP address. */
export const httpLimits = {
  /** PIN sign-ins (and linking an ID to Google with its PIN). */
  login: new RateLimiter(10, 60_000),
  /** New IDs created. */
  signup: new RateLimiter(5, 60 * 60_000),
  /** "Is this ID free?" lookups while typing. */
  lookup: new RateLimiter(60, 60_000),
  /** New "sign in with QR code" requests. */
  pairStart: new RateLimiter(10, 60_000),
  /** Waiting for a QR request to be approved (polled every couple of seconds). */
  pairPoll: new RateLimiter(120, 60_000),
  /** Looking up / approving a QR request from a signed-in device (per user, not IP). */
  pairApprove: new RateLimiter(20, 60_000),
};
