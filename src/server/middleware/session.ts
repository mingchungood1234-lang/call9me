import type { Request, Response } from 'express';
import { config } from '../config';
import { accountModel } from '../models/AccountModel';
import { sessionModel } from '../models/SessionModel';

export const SESSION_COOKIE = 'c9m_sid';

export function parseCookies(header: string | undefined): Record<string, string> {
  const cookies: Record<string, string> = {};
  for (const part of (header ?? '').split(';')) {
    const index = part.indexOf('=');
    if (index < 0) continue;
    const name = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    try {
      cookies[name] = decodeURIComponent(value);
    } catch {
      cookies[name] = value;
    }
  }
  return cookies;
}

export function sessionTokenFrom(cookieHeader: string | undefined): string | undefined {
  return parseCookies(cookieHeader)[SESSION_COOKIE];
}

/** The signed-in user ID for an HTTP request or socket handshake, if any. */
export function sessionUserId(cookieHeader: string | undefined): string | undefined {
  const userId = sessionModel.userIdFor(sessionTokenFrom(cookieHeader));
  return userId && !accountModel.isSuspended(userId) ? userId : undefined;
}

export function requestUserId(req: Request): string | undefined {
  return sessionUserId(req.headers.cookie);
}

export function setSessionCookie(req: Request, res: Response, token: string): void {
  res.cookie(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: req.secure,
    maxAge: config.sessionTtlMs,
    path: '/',
  });
}

/** Re-issues the cookie so its browser-side expiry slides along with the server session. */
export function refreshSessionCookie(req: Request, res: Response): void {
  const token = sessionTokenFrom(req.headers.cookie);
  if (token) setSessionCookie(req, res, token);
}
