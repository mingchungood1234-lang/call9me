import type { Request } from 'express';
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
  return sessionModel.userIdFor(sessionTokenFrom(cookieHeader));
}

export function requestUserId(req: Request): string | undefined {
  return sessionUserId(req.headers.cookie);
}
