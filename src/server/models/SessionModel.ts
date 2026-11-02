import { randomBytes } from 'node:crypto';
import { config } from '../config';

interface Session {
  userId: string;
  expiresAt: number;
}

/** In-memory login sessions, keyed by an opaque random token stored in a cookie. */
export class SessionModel {
  private readonly sessions = new Map<string, Session>();

  create(userId: string): string {
    this.prune();
    const token = randomBytes(24).toString('base64url');
    this.sessions.set(token, { userId, expiresAt: Date.now() + config.sessionTtlMs });
    return token;
  }

  userIdFor(token: string | undefined): string | undefined {
    if (!token) return undefined;
    const session = this.sessions.get(token);
    if (!session) return undefined;
    if (session.expiresAt <= Date.now()) {
      this.sessions.delete(token);
      return undefined;
    }
    return session.userId;
  }

  destroy(token: string | undefined): void {
    if (token) this.sessions.delete(token);
  }

  private prune(): void {
    const now = Date.now();
    for (const [token, session] of this.sessions) {
      if (session.expiresAt <= now) this.sessions.delete(token);
    }
  }
}

export const sessionModel = new SessionModel();
