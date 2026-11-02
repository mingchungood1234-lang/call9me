import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { config } from '../config';

const scrypt = promisify(scryptCallback) as (password: string, salt: string, keylen: number) => Promise<Buffer>;

interface Account {
  id: string;
  salt: string;
  pinHash: string;
  createdAt: number;
}

interface FailureRecord {
  count: number;
  lockedUntil: number;
}

export type LoginResult = { ok: true; id: string; created: boolean } | { ok: false; error: string };

/**
 * Registered IDs and their 4-digit PINs (salted scrypt hashes), persisted to a JSON file.
 * There is no verification step: the first login with an ID claims it with that PIN.
 */
export class AccountModel {
  private readonly accounts = new Map<string, Account>();
  private readonly failures = new Map<string, FailureRecord>();

  constructor(private readonly file: string) {
    this.load();
  }

  private key(id: string): string {
    return id.toLowerCase();
  }

  exists(id: string): boolean {
    return this.accounts.has(this.key(id));
  }

  /** The ID with the casing it was registered with. */
  canonicalId(id: string): string | undefined {
    return this.accounts.get(this.key(id))?.id;
  }

  /** Verifies the PIN of an existing ID, or registers a new ID with this PIN. */
  async login(id: string, pin: string): Promise<LoginResult> {
    const key = this.key(id);
    const failure = this.failures.get(key);
    if (failure && failure.lockedUntil > Date.now()) {
      const seconds = Math.ceil((failure.lockedUntil - Date.now()) / 1000);
      return { ok: false, error: `Too many wrong PINs. Try again in ${seconds}s.` };
    }

    const existing = this.accounts.get(key);
    if (!existing) {
      const salt = randomBytes(16).toString('hex');
      const pinHash = (await scrypt(pin, salt, 32)).toString('hex');
      // Another request may have registered the same ID while we were hashing.
      if (!this.accounts.has(key)) {
        this.accounts.set(key, { id, salt, pinHash, createdAt: Date.now() });
        this.persist();
        return { ok: true, id, created: true };
      }
      return this.login(id, pin);
    }

    const hash = await scrypt(pin, existing.salt, 32);
    if (!timingSafeEqual(hash, Buffer.from(existing.pinHash, 'hex'))) {
      // A lockout that has expired starts a fresh count.
      const record = failure && failure.lockedUntil === 0 ? failure : { count: 0, lockedUntil: 0 };
      record.count += 1;
      if (record.count >= config.maxPinFailures) record.lockedUntil = Date.now() + config.pinLockoutMs;
      this.failures.set(key, record);
      return { ok: false, error: 'Wrong PIN for this ID.' };
    }

    this.failures.delete(key);
    return { ok: true, id: existing.id, created: false };
  }

  private load(): void {
    try {
      const list: Account[] = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      for (const account of list) this.accounts.set(this.key(account.id), account);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        console.warn(`[accounts] could not read ${this.file}:`, err);
      }
    }
  }

  private persist(): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify([...this.accounts.values()], null, 2));
    fs.renameSync(tmp, this.file);
  }
}

export const accountModel = new AccountModel(path.join(config.dataDir, 'accounts.json'));
