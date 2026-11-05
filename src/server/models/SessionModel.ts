import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config';

interface Session {
  userId: string;
  expiresAt: number;
}

interface StoredSession extends Session {
  /** SHA-256 of the cookie token; the token itself is never written to disk. */
  hash: string;
}

const hashToken = (token: string) => createHash('sha256').update(token).digest('hex');

/** A stable, non-secret key for a session token (its hash), e.g. to remember an admin unlock. */
export const sessionKey = hashToken;

/**
 * Login sessions keyed by an opaque random token stored in a cookie. Persisted to JSON
 * so restarts/redeploys don't sign everyone out (important for installed PWAs answering
 * calls from notifications). Sessions slide: using one extends it.
 */
export class SessionModel {
  /** token hash → session */
  private readonly sessions = new Map<string, Session>();
  private persistTimer: NodeJS.Timeout | null = null;

  constructor(private readonly file: string) {
    this.load();
  }

  create(userId: string): string {
    this.prune();
    const token = randomBytes(24).toString('base64url');
    this.sessions.set(hashToken(token), { userId, expiresAt: Date.now() + config.sessionTtlMs });
    this.schedulePersist();
    return token;
  }

  userIdFor(token: string | undefined): string | undefined {
    if (!token) return undefined;
    const hash = hashToken(token);
    const session = this.sessions.get(hash);
    if (!session) return undefined;
    const now = Date.now();
    if (session.expiresAt <= now) {
      this.sessions.delete(hash);
      this.schedulePersist();
      return undefined;
    }
    // Sliding expiry: renew once less than half the lifetime is left.
    if (session.expiresAt - now < config.sessionTtlMs / 2) {
      session.expiresAt = now + config.sessionTtlMs;
      this.schedulePersist();
    }
    return session.userId;
  }

  destroy(token: string | undefined): void {
    if (token && this.sessions.delete(hashToken(token))) this.schedulePersist();
  }

  /** Signs the user out on every device. @returns how many sessions ended. */
  destroyAllFor(userId: string): number {
    const key = userId.toLowerCase();
    let count = 0;
    for (const [hash, session] of this.sessions) {
      if (session.userId.toLowerCase() === key) {
        this.sessions.delete(hash);
        count++;
      }
    }
    if (count) this.schedulePersist();
    return count;
  }

  /** How many devices are signed in as this user (sessions still valid). */
  countFor(userId: string): number {
    const key = userId.toLowerCase();
    const now = Date.now();
    return [...this.sessions.values()].filter((s) => s.expiresAt > now && s.userId.toLowerCase() === key).length;
  }

  private prune(): void {
    const now = Date.now();
    for (const [hash, session] of this.sessions) {
      if (session.expiresAt <= now) this.sessions.delete(hash);
    }
  }

  private load(): void {
    try {
      const list: StoredSession[] = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      const now = Date.now();
      for (const { hash, userId, expiresAt } of list) {
        if (expiresAt > now) this.sessions.set(hash, { userId, expiresAt });
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') console.warn(`[sessions] could not read ${this.file}:`, err);
    }
  }

  /** Batches writes; sessions change on every login and on sliding renewals. */
  private schedulePersist(): void {
    if (this.persistTimer) return;
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      const list: StoredSession[] = [...this.sessions].map(([hash, s]) => ({ hash, ...s }));
      try {
        fs.mkdirSync(path.dirname(this.file), { recursive: true });
        const tmp = `${this.file}.tmp`;
        fs.writeFileSync(tmp, JSON.stringify(list));
        fs.renameSync(tmp, this.file);
      } catch (err) {
        console.warn('[sessions] could not save sessions:', err);
      }
    }, 1000);
  }
}

export const sessionModel = new SessionModel(path.join(config.dataDir, 'sessions.json'));
