-- Call9me PostgreSQL schema. Columns ending in _enc are AES-256-GCM ciphertexts (see
-- src/server/db/crypto.ts); columns ending in _idx are HMAC blind indexes for lookups.
-- Safe to run again: everything is CREATE ... IF NOT EXISTS.

CREATE TABLE IF NOT EXISTS schema_meta (
  key   text PRIMARY KEY,
  value text NOT NULL
);

-- Server secrets (the VAPID push key pair).
CREATE TABLE IF NOT EXISTS app_secrets (
  name      text PRIMARY KEY,
  value_enc bytea NOT NULL
);

CREATE TABLE IF NOT EXISTS accounts (
  id_key             text PRIMARY KEY,          -- lowercased ID
  id                 text NOT NULL,             -- as registered
  created_at         bigint NOT NULL,
  suspended          boolean NOT NULL DEFAULT false,
  -- {salt, pinHash}: encrypted because a 4-digit PIN hash can be brute-forced offline.
  pin_enc            bytea,
  google_sub_idx     bytea UNIQUE,
  google_sub_enc     bytea,
  google_email_enc   bytea,
  recovery_email_idx bytea,
  recovery_email_enc bytea
);
CREATE INDEX IF NOT EXISTS accounts_recovery_email_idx ON accounts (recovery_email_idx);

CREATE TABLE IF NOT EXISTS pin_failures (
  id_key text PRIMARY KEY,
  record jsonb NOT NULL
);

-- Only SHA-256 hashes of session tokens are stored (as in sessions.json).
CREATE TABLE IF NOT EXISTS sessions (
  token_hash text PRIMARY KEY,
  user_id    text NOT NULL,
  expires_at bigint NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_user_idx ON sessions (lower(user_id));

CREATE TABLE IF NOT EXISTS push_subscriptions (
  endpoint_idx     bytea PRIMARY KEY,
  user_id          text NOT NULL,
  created_at       bigint NOT NULL,
  subscription_enc bytea NOT NULL                -- {endpoint, keys}
);
CREATE INDEX IF NOT EXISTS push_subscriptions_user_idx ON push_subscriptions (lower(user_id));

CREATE TABLE IF NOT EXISTS rooms (
  id             text PRIMARY KEY,
  owner          text NOT NULL,
  visibility     text NOT NULL CHECK (visibility IN ('public', 'private', 'link')),
  created_at     bigint NOT NULL,
  invite_key_enc bytea,
  members        jsonb NOT NULL DEFAULT '[]',
  banned         jsonb NOT NULL DEFAULT '[]'
);

CREATE TABLE IF NOT EXISTS room_followers (
  room_id text NOT NULL,
  user_id text NOT NULL,
  PRIMARY KEY (room_id, user_id)
);

CREATE TABLE IF NOT EXISTS room_messages (
  room_id   text NOT NULL,
  id        text NOT NULL,
  seq       integer NOT NULL,                    -- order within the room
  from_user text NOT NULL,
  ts        bigint NOT NULL,
  system    boolean NOT NULL DEFAULT false,
  body_enc  bytea NOT NULL,                      -- {text, sticker}
  PRIMARY KEY (room_id, id)
);
CREATE INDEX IF NOT EXISTS room_messages_order_idx ON room_messages (room_id, seq);

CREATE TABLE IF NOT EXISTS admin_log (
  seq    integer PRIMARY KEY,
  at     bigint NOT NULL,
  admin  text NOT NULL,
  action text NOT NULL,
  target text NOT NULL,
  detail text
);

-- Pictures (profile pictures, stickers, custom emoji), encrypted.
CREATE TABLE IF NOT EXISTS media (
  path         text PRIMARY KEY,                 -- e.g. "avatars/alice.png"
  content_type text NOT NULL,
  sha256       text NOT NULL,                    -- of the plaintext, to verify
  size         integer NOT NULL,
  data_enc     bytea NOT NULL
);

-- Everything else (friends, statuses, call history, room prefs/reads, picture indexes, and
-- any file this script doesn't know), one row per top-level entry, encrypted.
CREATE TABLE IF NOT EXISTS app_documents (
  name     text NOT NULL,                        -- source file, e.g. "friends.json"
  key      text NOT NULL,                        -- top-level key / array index, or "*" for the whole file
  data_enc bytea NOT NULL,
  PRIMARY KEY (name, key)
);
