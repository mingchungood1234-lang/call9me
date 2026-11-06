import { createHash, randomBytes } from 'node:crypto';
import { config } from '../config';

interface ResetRequest {
  /** Lowercased user ID. */
  key: string;
  expiresAt: number;
}

const hash = (token: string) => createHash('sha256').update(token).digest('hex');

/**
 * Single-use "reset your PIN" tokens. Only their hashes are kept (in memory: a restart
 * simply voids pending links), each new request replaces the ID's previous one.
 */
class PinResetStore {
  private readonly byHash = new Map<string, ResetRequest>();

  /** A new token for this ID (any older link for it stops working). */
  create(userId: string): string {
    const key = userId.toLowerCase();
    this.sweep();
    for (const [h, r] of this.byHash) if (r.key === key) this.byHash.delete(h);
    const token = randomBytes(32).toString('base64url');
    this.byHash.set(hash(token), { key, expiresAt: Date.now() + config.pinResetTtlMs });
    return token;
  }

  /** The (lowercased) ID a live token belongs to, without using it up. */
  peek(token: unknown): string | undefined {
    if (typeof token !== 'string' || token.length > 100) return undefined;
    const request = this.byHash.get(hash(token));
    return request && request.expiresAt > Date.now() ? request.key : undefined;
  }

  /** Uses the token up. @returns its (lowercased) ID if it was still valid. */
  consume(token: unknown): string | undefined {
    const key = this.peek(token);
    if (key) this.byHash.delete(hash(token as string));
    return key;
  }

  private sweep(): void {
    const now = Date.now();
    for (const [h, r] of this.byHash) if (r.expiresAt <= now) this.byHash.delete(h);
  }
}

export const pinResets = new PinResetStore();
