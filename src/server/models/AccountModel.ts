import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { config } from '../config';

const scrypt = promisify(scryptCallback) as (password: string, salt: string, keylen: number) => Promise<Buffer>;

interface Account {
  id: string;
  /** Unset for accounts created with Google (they have no PIN). */
  salt?: string;
  pinHash?: string;
  createdAt: number;
  /** Google account ("sub") linked to this ID, and its email (for display). */
  googleSub?: string;
  googleEmail?: string;
  /** Set by an admin: can't sign in or stay connected until unsuspended. */
  suspended?: boolean;
}

/** An account as the admin dashboard lists it (never the PIN hash). */
export interface AccountInfo {
  id: string;
  createdAt: number;
  hasPin: boolean;
  googleEmail?: string;
  suspended: boolean;
  /** Locked out after wrong PINs until then (0: not locked). */
  lockedUntil: number;
}

interface FailureRecord {
  /** Wrong PINs since the last lockout. */
  count: number;
  lockedUntil: number;
  /** Lockouts in a row: each one lasts longer (see config.pinLockoutStepsMs). */
  lockouts: number;
  lastFailureAt: number;
}

export type LoginResult = { ok: true; id: string; created: boolean } | { ok: false; error: string };

/**
 * Registered IDs and their 4-digit PINs (salted scrypt hashes), persisted to a JSON file.
 * There is no verification step: the first login with an ID claims it with that PIN.
 */
export class AccountModel {
  private readonly accounts = new Map<string, Account>();
  private readonly failures = new Map<string, FailureRecord>();

  private readonly failuresFile: string;

  constructor(private readonly file: string) {
    this.failuresFile = path.join(path.dirname(file), 'pin-failures.json');
    this.load();
    this.loadFailures();
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

  // ---- Google sign-in ----

  /** The ID linked to this Google account, if any. */
  idForGoogle(sub: string): string | undefined {
    for (const account of this.accounts.values()) if (account.googleSub === sub) return account.id;
    return undefined;
  }

  googleEmailOf(id: string): string | undefined {
    return this.accounts.get(this.key(id))?.googleEmail;
  }

  /** Links a Google account to an existing ID (moving it off any other ID). */
  linkGoogle(id: string, sub: string, email: string): void {
    const account = this.accounts.get(this.key(id));
    if (!account) return;
    for (const other of this.accounts.values()) {
      if (other.googleSub === sub && other !== account) {
        delete other.googleSub;
        delete other.googleEmail;
      }
    }
    account.googleSub = sub;
    account.googleEmail = email;
    this.persist();
  }

  /** Registers a new ID that signs in with Google only. @returns false if the ID is taken. */
  createWithGoogle(id: string, sub: string, email: string): boolean {
    if (this.accounts.has(this.key(id))) return false;
    this.accounts.set(this.key(id), { id, createdAt: Date.now(), googleSub: sub, googleEmail: email });
    this.persist();
    return true;
  }

  /** Verifies the PIN of an existing ID, or registers a new ID with this PIN. */
  async login(id: string, pin: string): Promise<LoginResult> {
    const key = this.key(id);
    const failure = this.failures.get(key);
    if (failure && failure.lockedUntil > Date.now()) {
      const seconds = Math.ceil((failure.lockedUntil - Date.now()) / 1000);
      const wait = seconds < 120 ? `${seconds}s` : `${Math.ceil(seconds / 60)} min`;
      return { ok: false, error: `Too many wrong PINs for this ID. Try again in ${wait}.` };
    }

    const existing = this.accounts.get(key);
    if (existing?.suspended) return { ok: false, error: 'This ID has been suspended by an admin.' };
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

    if (!existing.salt || !existing.pinHash) {
      return { ok: false, error: 'This ID signs in with Google. Use "Continue with Google".' };
    }
    const hash = await scrypt(pin, existing.salt, 32);
    if (!timingSafeEqual(hash, Buffer.from(existing.pinHash, 'hex'))) {
      this.recordFailure(key);
      return { ok: false, error: 'Wrong PIN for this ID.' };
    }

    if (this.failures.delete(key)) this.persistFailures();
    return { ok: true, id: existing.id, created: false };
  }

  // ---- Admin ----

  list(): AccountInfo[] {
    const now = Date.now();
    return [...this.accounts.entries()]
      .map(([key, a]) => {
        const lockedUntil = this.failures.get(key)?.lockedUntil ?? 0;
        return {
          id: a.id,
          createdAt: a.createdAt,
          hasPin: !!a.pinHash,
          googleEmail: a.googleEmail,
          suspended: !!a.suspended,
          lockedUntil: lockedUntil > now ? lockedUntil : 0,
        };
      })
      .sort((a, b) => a.id.localeCompare(b.id));
  }

  isSuspended(id: string): boolean {
    return this.accounts.get(this.key(id))?.suspended ?? false;
  }

  /** @returns whether the account exists. */
  setSuspended(id: string, suspended: boolean): boolean {
    const account = this.accounts.get(this.key(id));
    if (!account) return false;
    if (suspended) account.suspended = true;
    else delete account.suspended;
    this.persist();
    return true;
  }

  /** A new PIN chosen by an admin (e.g. the user forgot theirs); also lifts any lockout. */
  async setPin(id: string, pin: string): Promise<boolean> {
    const account = this.accounts.get(this.key(id));
    if (!account) return false;
    account.salt = randomBytes(16).toString('hex');
    account.pinHash = (await scrypt(pin, account.salt, 32)).toString('hex');
    this.persist();
    this.unlock(id);
    return true;
  }

  /** Clears wrong-PIN lockouts. @returns whether there was one. */
  unlock(id: string): boolean {
    const removed = this.failures.delete(this.key(id));
    if (removed) this.persistFailures();
    return removed;
  }

  delete(id: string): boolean {
    const key = this.key(id);
    if (!this.accounts.delete(key)) return false;
    this.failures.delete(key);
    this.persist();
    this.persistFailures();
    return true;
  }

  /**
   * Every `maxPinFailures` wrong PINs lock the ID for longer than the last time: guessing
   * all 10,000 PINs takes months instead of hours. A quiet day resets the escalation.
   */
  private recordFailure(key: string): void {
    const now = Date.now();
    let record = this.failures.get(key);
    if (!record || now - record.lastFailureAt > config.pinFailureResetMs) {
      record = { count: 0, lockedUntil: 0, lockouts: 0, lastFailureAt: now };
    }
    record.count += 1;
    record.lastFailureAt = now;
    if (record.count >= config.maxPinFailures) {
      const steps = config.pinLockoutStepsMs;
      record.lockedUntil = now + steps[Math.min(record.lockouts, steps.length - 1)];
      record.lockouts += 1;
      record.count = 0;
    }
    this.failures.set(key, record);
    this.persistFailures();
  }

  /** Lockouts survive restarts, so restarting the server doesn't reset them. */
  private loadFailures(): void {
    try {
      const data: Record<string, FailureRecord> = JSON.parse(fs.readFileSync(this.failuresFile, 'utf8'));
      const cutoff = Date.now() - config.pinFailureResetMs;
      for (const [key, record] of Object.entries(data)) {
        if (record.lastFailureAt > cutoff || record.lockedUntil > Date.now()) this.failures.set(key, record);
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') console.warn(`[accounts] could not read ${this.failuresFile}:`, err);
    }
  }

  private persistFailures(): void {
    try {
      fs.mkdirSync(path.dirname(this.failuresFile), { recursive: true });
      const tmp = `${this.failuresFile}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(Object.fromEntries(this.failures)));
      fs.renameSync(tmp, this.failuresFile);
    } catch (err) {
      console.warn('[accounts] could not save PIN failures:', err);
    }
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
