/**
 * Copies Call9me's JSON data (data/*.json, chat history, pictures) into PostgreSQL, encrypting
 * everything sensitive with DATA_ENCRYPTION_KEY (see src/server/db/crypto.ts).
 *
 *   npm run db:migrate -- --generate-key   print a new key to put in .env (do this once)
 *   npm run db:migrate -- --dry-run        read and encrypt everything, write nothing
 *   npm run db:migrate                     migrate (one transaction: all or nothing)
 *   npm run db:migrate -- --verify         migrate, then read it all back, decrypt and compare
 *   npm run db:migrate -- --fresh          empty the tables first (re-import from scratch)
 *   --data-dir <path>                      somewhere other than DATA_DIR / ./data
 *
 * Needs DATABASE_URL (e.g. postgres://call9me:pw@db.example.com:5432/call9me?sslmode=require)
 * and DATA_ENCRYPTION_KEY, from the environment or .env. Running it again updates rows in
 * place (upserts). The JSON files are only read, never changed or deleted.
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import pg from 'pg';
import { FieldCipher } from '../src/server/db/crypto';

// Run from the project root (npm scripts, and /app inside the Docker image).
const ROOT = process.cwd();
/** Next to this file (source: scripts/, compiled: dist/scripts/), else the project's scripts/. */
const SCHEMA_FILE = [path.join(__dirname, 'postgres-schema.sql'), path.join(ROOT, 'scripts', 'postgres-schema.sql')].find((f) =>
  fs.existsSync(f),
);
const args = process.argv.slice(2);
const flag = (name: string) => args.includes(`--${name}`);
const option = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};

if (flag('generate-key')) {
  console.log(`DATA_ENCRYPTION_KEY=${FieldCipher.generateKey()}`);
  console.log('\nPut this in .env and keep a copy somewhere safe (a password manager).');
  console.log('Without it, the encrypted data can never be read again.');
  process.exit(0);
}

const envFile = path.join(ROOT, '.env');
if (fs.existsSync(envFile) && typeof process.loadEnvFile === 'function') process.loadEnvFile(envFile);

const DRY_RUN = flag('dry-run');
const VERIFY = flag('verify');
const FRESH = flag('fresh');
const DATA_DIR = path.resolve(option('data-dir') ?? process.env.DATA_DIR ?? path.join(ROOT, 'data'));

const TABLES = [
  'app_secrets', 'accounts', 'pin_failures', 'sessions', 'push_subscriptions', 'rooms',
  'room_followers', 'room_messages', 'admin_log', 'media', 'app_documents',
] as const;
type Table = (typeof TABLES)[number];

const CONTENT_TYPES: Record<string, string> = {
  '.png': 'image/png', '.webp': 'image/webp', '.gif': 'image/gif',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.svg': 'image/svg+xml',
};

// ---- Source data ----

type Json = unknown;
interface Account {
  id: string; salt?: string; pinHash?: string; createdAt: number; googleSub?: string;
  googleEmail?: string; suspended?: boolean; recoveryEmail?: string;
}
interface StoredSession { hash: string; userId: string; expiresAt: number }
interface StoredSubscription { userId: string; subscription: { endpoint: string }; createdAt: number }
interface RoomSettings { id: string; owner: string; visibility: string; createdAt: number; key?: string; members?: string[]; banned?: string[] }
interface ChatMessage { id: string; roomId: string; from: string; text: string; timestamp: number; system?: boolean; sticker?: string }
interface AdminLogEntry { at: number; admin: string; action: string; target: string; detail?: string }

/** Every file under the data directory, as paths relative to it (forward slashes). */
function listFiles(dir: string, base = dir): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return listFiles(full, base);
    return entry.isFile() ? [path.relative(base, full).split(path.sep).join('/')] : [];
  });
}

function readJson(rel: string): Json {
  const text = fs.readFileSync(path.join(DATA_DIR, rel), 'utf8');
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new Error(`${rel} is not valid JSON: ${(err as Error).message}`);
  }
}

// ---- Rows to write ----

interface Row {
  table: Table;
  /** Primary key columns → values (for the upsert and the verify step). */
  key: Record<string, unknown>;
  values: Record<string, unknown>;
}

const rows: Row[] = [];
/** Encrypted cells and what they must decrypt to (for --verify). */
const expected: { table: Table; key: Record<string, unknown>; column: string; where: string; plain: Buffer }[] = [];
const notes: string[] = [];

function main(cipher: FieldCipher): void {
  const seal = (table: Table, key: Record<string, unknown>, column: string, where: string, value: Buffer | string) => {
    const plain = typeof value === 'string' ? Buffer.from(value, 'utf8') : value;
    expected.push({ table, key, column, where, plain });
    return cipher.encrypt(plain, where);
  };
  const sealJson = (table: Table, key: Record<string, unknown>, column: string, where: string, value: unknown) =>
    seal(table, key, column, where, JSON.stringify(value));
  const add = (table: Table, key: Record<string, unknown>, values: Record<string, unknown>) => rows.push({ table, key, values });

  const files = listFiles(DATA_DIR).filter((f) => !f.endsWith('.tmp'));
  const handled = new Set<string>();
  const take = (rel: string): Json | undefined => {
    if (!files.includes(rel)) return undefined;
    handled.add(rel);
    return readJson(rel);
  };

  // Server secrets
  const vapid = take('vapid.json');
  if (vapid !== undefined) {
    const key = { name: 'vapid' };
    add('app_secrets', key, { value_enc: sealJson('app_secrets', key, 'value_enc', 'app_secrets.value:vapid', vapid) });
  }

  // Accounts: PIN hashes, Google identity and emails encrypted; lookups through blind indexes.
  for (const a of (take('accounts.json') as Account[] | undefined) ?? []) {
    const idKey = a.id.toLowerCase();
    const key = { id_key: idKey };
    const enc = (column: string, field: string, value: unknown) =>
      value === undefined ? null : sealJson('accounts', key, column, `accounts.${field}:${idKey}`, value);
    add('accounts', key, {
      id: a.id,
      created_at: a.createdAt,
      suspended: !!a.suspended,
      pin_enc: a.pinHash ? enc('pin_enc', 'pin', { salt: a.salt, pinHash: a.pinHash }) : null,
      google_sub_idx: a.googleSub ? cipher.blindIndex(a.googleSub, 'google-sub') : null,
      google_sub_enc: enc('google_sub_enc', 'google_sub', a.googleSub),
      google_email_enc: enc('google_email_enc', 'google_email', a.googleEmail),
      recovery_email_idx: a.recoveryEmail ? cipher.blindIndex(a.recoveryEmail.toLowerCase(), 'recovery-email') : null,
      recovery_email_enc: enc('recovery_email_enc', 'recovery_email', a.recoveryEmail),
    });
  }

  for (const [idKey, record] of Object.entries((take('pin-failures.json') as Record<string, Json> | undefined) ?? {})) {
    add('pin_failures', { id_key: idKey }, { record: JSON.stringify(record) });
  }

  // Sessions: already hashed; expired ones are left behind.
  let expired = 0;
  for (const s of (take('sessions.json') as StoredSession[] | undefined) ?? []) {
    if (s.expiresAt <= Date.now()) {
      expired++;
      continue;
    }
    add('sessions', { token_hash: s.hash }, { user_id: s.userId, expires_at: s.expiresAt });
  }
  if (expired) notes.push(`skipped ${expired} expired session(s)`);

  // Push subscriptions: the endpoint + keys let anyone push to that device, so encrypted.
  for (const s of (take('push-subscriptions.json') as StoredSubscription[] | undefined) ?? []) {
    const idx = cipher.blindIndex(s.subscription.endpoint, 'push-endpoint');
    const key = { endpoint_idx: idx };
    add('push_subscriptions', key, {
      user_id: s.userId,
      created_at: s.createdAt,
      subscription_enc: sealJson('push_subscriptions', key, 'subscription_enc', `push_subscriptions.subscription:${idx.toString('hex')}`, s.subscription),
    });
  }

  // Rooms: the invite-link secret is encrypted.
  for (const r of (take('rooms.json') as RoomSettings[] | undefined) ?? []) {
    const key = { id: r.id };
    add('rooms', key, {
      owner: r.owner,
      visibility: r.visibility,
      created_at: r.createdAt,
      invite_key_enc: r.key ? seal('rooms', key, 'invite_key_enc', `rooms.invite_key:${r.id}`, r.key) : null,
      members: JSON.stringify(r.members ?? []),
      banned: JSON.stringify(r.banned ?? []),
    });
  }

  for (const [roomId, followers] of Object.entries((take('room-followers.json') as Record<string, string[]> | undefined) ?? {})) {
    for (const userId of followers) add('room_followers', { room_id: roomId, user_id: userId }, {});
  }

  // Chat history: one file per room; message bodies encrypted.
  for (const rel of files.filter((f) => f.startsWith('room-history/') && f.endsWith('.json'))) {
    const roomId = path.basename(rel, '.json');
    const messages = (take(rel) as ChatMessage[]) ?? [];
    messages.forEach((m, seq) => {
      const key = { room_id: roomId, id: m.id };
      add('room_messages', key, {
        seq,
        from_user: m.from,
        ts: m.timestamp,
        system: !!m.system,
        body_enc: sealJson('room_messages', key, 'body_enc', `room_messages.body:${roomId}/${m.id}`, { text: m.text, sticker: m.sticker }),
      });
    });
  }

  // Audit log stays readable (it's for accountability, and holds no secrets).
  ((take('admin-log.json') as AdminLogEntry[] | undefined) ?? []).forEach((e, seq) => {
    add('admin_log', { seq }, { at: e.at, admin: e.admin, action: e.action, target: e.target, detail: e.detail ?? null });
  });

  // Every other JSON file, one encrypted row per top-level entry (nothing is dropped).
  for (const rel of files.filter((f) => f.endsWith('.json') && !handled.has(f))) {
    const data = readJson(rel);
    handled.add(rel);
    const entries: [string, Json][] =
      Array.isArray(data) ? data.map((v, i) => [String(i), v])
      : data && typeof data === 'object' ? Object.entries(data as Record<string, Json>)
      : [['*', data]];
    for (const [k, v] of entries) {
      const key = { name: rel, key: k };
      add('app_documents', key, { data_enc: sealJson('app_documents', key, 'data_enc', `app_documents:${rel}#${k}`, v) });
    }
  }

  // Pictures and any other files.
  for (const rel of files.filter((f) => !handled.has(f))) {
    const data = fs.readFileSync(path.join(DATA_DIR, rel));
    const key = { path: rel };
    add('media', key, {
      content_type: CONTENT_TYPES[path.extname(rel).toLowerCase()] ?? 'application/octet-stream',
      sha256: createHash('sha256').update(data).digest('hex'),
      size: data.length,
      data_enc: seal('media', key, 'data_enc', `media:${rel}`, data),
    });
  }
}

// ---- Writing ----

async function upsert(client: pg.PoolClient, row: Row): Promise<void> {
  const cols = [...Object.keys(row.key), ...Object.keys(row.values)];
  const vals = [...Object.values(row.key), ...Object.values(row.values)];
  const keyCols = Object.keys(row.key);
  const updates = Object.keys(row.values).map((c) => `${c} = EXCLUDED.${c}`);
  const sql =
    `INSERT INTO ${row.table} (${cols.join(', ')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')}) ` +
    `ON CONFLICT (${keyCols.join(', ')}) DO ${updates.length ? `UPDATE SET ${updates.join(', ')}` : 'NOTHING'}`;
  await client.query(sql, vals);
}

function whereClause(key: Record<string, unknown>): [string, unknown[]] {
  const cols = Object.keys(key);
  return [cols.map((c, i) => `${c} = $${i + 1}`).join(' AND '), Object.values(key)];
}

async function verify(client: pg.PoolClient, cipher: FieldCipher): Promise<void> {
  let checked = 0;
  for (const table of TABLES) {
    const want = rows.filter((r) => r.table === table).length;
    const { rows: [{ count }] } = await client.query(`SELECT count(*)::int AS count FROM ${table}`);
    if (!FRESH && count > want) notes.push(`${table}: ${count - want} row(s) in the database that aren't in the JSON (from an earlier import?)`);
    if (count < want) throw new Error(`verify: ${table} has ${count} rows, expected ${want}`);
  }
  for (const e of expected) {
    const [where, params] = whereClause(e.key);
    const res = await client.query(`SELECT ${e.column} AS v FROM ${e.table} WHERE ${where}`, params);
    const sealed = res.rows[0]?.v as Buffer | undefined;
    if (!sealed) throw new Error(`verify: missing ${e.where}`);
    if (!FieldCipher.sameBytes(cipher.decrypt(sealed, e.where), e.plain)) throw new Error(`verify: ${e.where} decrypts to something else`);
    checked++;
  }
  console.log(`✔ verified: row counts match and all ${checked} encrypted value(s) decrypt back to the original`);
}

function warnAboutTls(url: string): void {
  try {
    const u = new URL(url);
    const local = ['localhost', '127.0.0.1', '::1', '[::1]'].includes(u.hostname);
    const ssl = u.searchParams.get('sslmode') ?? process.env.PGSSLMODE;
    if (!local && (!ssl || ssl === 'disable' || ssl === 'allow' || ssl === 'prefer')) {
      console.warn('⚠ The database is not on this machine and the connection may not be encrypted.');
      console.warn('  Add ?sslmode=verify-full (or at least sslmode=require) to DATABASE_URL.\n');
    }
  } catch {
    throw new Error('DATABASE_URL is not a valid URL (postgres://user:password@host:5432/dbname)');
  }
}

async function run(): Promise<void> {
  if (!fs.existsSync(DATA_DIR)) throw new Error(`No data directory at ${DATA_DIR}`);
  const cipher = FieldCipher.fromEnv();
  console.log(`Reading ${DATA_DIR}`);
  main(cipher);

  const counts = new Map<Table, number>();
  for (const r of rows) counts.set(r.table, (counts.get(r.table) ?? 0) + 1);
  for (const t of TABLES) console.log(`  ${t.padEnd(20)} ${counts.get(t) ?? 0}`);
  console.log(`  ${expected.length} value(s) encrypted with key ${cipher.fingerprint()}`);

  if (DRY_RUN) {
    for (const e of expected) if (!FieldCipher.sameBytes(cipher.decrypt(cipher.encrypt(e.plain, e.where), e.where), e.plain)) throw new Error(`round-trip failed for ${e.where}`);
    console.log('\nDry run: everything was read and encrypted fine; nothing was written.');
    return;
  }

  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is not set (postgres://user:password@host:5432/dbname?sslmode=require)');
  warnAboutTls(url);

  const pool = new pg.Pool({ connectionString: url, max: 1 });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    if (!SCHEMA_FILE) throw new Error('postgres-schema.sql not found next to the script');
    await client.query(fs.readFileSync(SCHEMA_FILE, 'utf8'));

    // Never mix data encrypted with two different keys in one database.
    const fp = cipher.fingerprint();
    const existing = await client.query(`SELECT value FROM schema_meta WHERE key = 'key_fingerprint'`);
    const stored = existing.rows[0]?.value as string | undefined;
    if (stored && stored !== fp) {
      throw new Error(`This database was filled with a different DATA_ENCRYPTION_KEY (fingerprint ${stored}, yours is ${fp}). Use that key.`);
    }
    await client.query(
      `INSERT INTO schema_meta (key, value) VALUES ('key_fingerprint', $1), ('schema_version', '1'), ('migrated_at', $2)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
      [fp, new Date().toISOString()],
    );

    if (FRESH) await client.query(`TRUNCATE ${TABLES.join(', ')}`);
    let done = 0;
    for (const row of rows) {
      await upsert(client, row);
      if (++done % 500 === 0) console.log(`  … ${done}/${rows.length}`);
    }
    if (VERIFY) await verify(client, cipher);
    await client.query('COMMIT');
    console.log(`\n✔ Migrated ${rows.length} row(s) into PostgreSQL.`);
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

run()
  .then(() => {
    for (const n of notes) console.log(`note: ${n}`);
    if (!DRY_RUN) {
      console.log('\nThe JSON files were not changed. Once the app reads from PostgreSQL, move data/ into an');
      console.log('encrypted backup and delete it from the server: it still holds everything unencrypted.');
    }
  })
  .catch((err: unknown) => {
    console.error(`\n✖ ${err instanceof Error ? err.message : String(err)}`);
    console.error('Nothing was written (the transaction was rolled back).');
    process.exit(1);
  });
