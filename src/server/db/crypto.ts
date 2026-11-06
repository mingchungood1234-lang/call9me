import { createCipheriv, createDecipheriv, createHmac, hkdfSync, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Field-level encryption for data stored in PostgreSQL.
 *
 * - One master key (DATA_ENCRYPTION_KEY: 32 random bytes, base64) is stretched with HKDF into
 *   an encryption key and a separate key for blind indexes, so neither can be used as the other.
 * - Values are sealed with AES-256-GCM (confidential + tamper-evident). Every value is bound
 *   to where it lives ("accounts.pin:alice") as associated data: a ciphertext copied into
 *   another row or column fails to decrypt instead of silently showing up there.
 * - Blind indexes (HMAC-SHA256) let the app look rows up by an encrypted value (an email, a
 *   Google account) without storing it in the clear.
 *
 * Stored format: version (1 byte) | IV (12) | auth tag (16) | ciphertext.
 */
const VERSION = 1;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const HEADER = 1 + IV_BYTES + TAG_BYTES;

export class FieldCipher {
  private readonly encKey: Buffer;
  private readonly indexKey: Buffer;

  constructor(masterKey: Buffer) {
    if (masterKey.length !== 32) throw new Error('DATA_ENCRYPTION_KEY must be 32 bytes (base64 of 32 random bytes)');
    const derive = (info: string) => Buffer.from(hkdfSync('sha256', masterKey, Buffer.alloc(0), info, 32));
    this.encKey = derive('call9me/field-encryption/v1');
    this.indexKey = derive('call9me/blind-index/v1');
  }

  /** From DATA_ENCRYPTION_KEY (base64 or hex). */
  static fromEnv(value = process.env.DATA_ENCRYPTION_KEY): FieldCipher {
    const raw = (value ?? '').trim();
    if (!raw) throw new Error('DATA_ENCRYPTION_KEY is not set. Generate one with: npm run db:migrate -- --generate-key');
    const key = /^[0-9a-f]{64}$/i.test(raw) ? Buffer.from(raw, 'hex') : Buffer.from(raw, 'base64');
    return new FieldCipher(key);
  }

  /** A new random master key, base64. */
  static generateKey(): string {
    return randomBytes(32).toString('base64');
  }

  /** `where`: the value's place, e.g. "accounts.pin:alice" (must be the same to decrypt). */
  encrypt(plaintext: Buffer | string, where: string): Buffer {
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv('aes-256-gcm', this.encKey, iv);
    cipher.setAAD(Buffer.from(where, 'utf8'));
    const body = Buffer.concat([cipher.update(typeof plaintext === 'string' ? Buffer.from(plaintext, 'utf8') : plaintext), cipher.final()]);
    return Buffer.concat([Buffer.from([VERSION]), iv, cipher.getAuthTag(), body]);
  }

  /** Throws if the key is wrong, the data was changed, or it belongs somewhere else. */
  decrypt(sealed: Buffer, where: string): Buffer {
    if (sealed.length < HEADER || sealed[0] !== VERSION) throw new Error(`Unknown ciphertext format for ${where}`);
    const decipher = createDecipheriv('aes-256-gcm', this.encKey, sealed.subarray(1, 1 + IV_BYTES));
    decipher.setAAD(Buffer.from(where, 'utf8'));
    decipher.setAuthTag(sealed.subarray(1 + IV_BYTES, HEADER));
    return Buffer.concat([decipher.update(sealed.subarray(HEADER)), decipher.final()]);
  }

  encryptJson(value: unknown, where: string): Buffer {
    return this.encrypt(JSON.stringify(value), where);
  }

  decryptJson<T>(sealed: Buffer, where: string): T {
    return JSON.parse(this.decrypt(sealed, where).toString('utf8')) as T;
  }

  /** Deterministic lookup key for an encrypted value (`purpose` keeps indexes of different fields apart). */
  blindIndex(value: string, purpose: string): Buffer {
    return createHmac('sha256', this.indexKey).update(`${purpose}\0${value}`).digest();
  }

  /** Identifies the key without revealing it (stored in the database to catch a wrong key). */
  fingerprint(): string {
    return this.blindIndex('fingerprint', 'meta').subarray(0, 8).toString('hex');
  }

  static sameBytes(a: Buffer, b: Buffer): boolean {
    return a.length === b.length && timingSafeEqual(a, b);
  }
}
