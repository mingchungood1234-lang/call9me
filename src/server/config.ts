import fs from 'node:fs';
import path from 'node:path';
import type { IceServerConfig } from '../shared/types';

// Resolves to the project root from both src/server (tsx) and dist/server (compiled).
const ROOT_DIR = path.join(__dirname, '..', '..');

// Settings can live in a `.env` file at the project root (see .env.example).
// Variables already set in the real environment take precedence over the file.
const ENV_FILE = path.join(ROOT_DIR, '.env');
if (fs.existsSync(ENV_FILE)) {
  if (typeof process.loadEnvFile === 'function') process.loadEnvFile(ENV_FILE);
  else console.warn('[config] .env found but this Node version cannot load it; use Node 20.12+ or set variables directly');
}

const DEFAULT_STUN_URLS = ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'];

function list(raw: string | undefined): string[] {
  return (raw ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * ICE servers handed to browsers for WebRTC:
 * - ICE_SERVERS: full JSON array of RTCIceServer objects (advanced, overrides the rest), or
 * - STUN_URLS + TURN_URLS / TURN_USERNAME / TURN_PASSWORD (e.g. your own coturn server).
 */
function buildIceServers(): IceServerConfig[] {
  const raw = process.env.ICE_SERVERS;
  if (raw) {
    try {
      const parsed: unknown = JSON.parse(raw);
      if (Array.isArray(parsed) && parsed.length > 0) return parsed as IceServerConfig[];
    } catch {
      /* fall through */
    }
    console.warn('[config] ICE_SERVERS is not a valid JSON array; using STUN/TURN settings instead');
  }

  const stunUrls = list(process.env.STUN_URLS);
  const servers: IceServerConfig[] = [{ urls: stunUrls.length ? stunUrls : DEFAULT_STUN_URLS }];

  const turnUrls = list(process.env.TURN_URLS);
  const username = process.env.TURN_USERNAME ?? '';
  const credential = process.env.TURN_PASSWORD ?? '';
  if (turnUrls.length) {
    if (!username || !credential) {
      console.warn('[config] TURN_URLS is set but TURN_USERNAME / TURN_PASSWORD are missing; TURN disabled');
    } else {
      servers.push({ urls: turnUrls, username, credential });
    }
  }
  return servers;
}

/** One-line summary for the startup log (never prints credentials). */
export function describeIceServers(servers: IceServerConfig[]): string {
  return servers
    .map((s) => {
      const urls = Array.isArray(s.urls) ? s.urls : [s.urls];
      return urls.join(', ') + (s.username ? ` (user "${s.username}")` : '');
    })
    .join(' | ');
}

/**
 * TRUST_PROXY: set when running behind a reverse proxy (nginx, Caddy, Docker) so
 * Express reads X-Forwarded-Proto/For — e.g. "1" (one proxy hop), "loopback", "true".
 */
function parseTrustProxy(raw: string | undefined): boolean | number | string {
  if (!raw || raw === 'false') return false;
  if (raw === 'true') return true;
  return /^\d+$/.test(raw) ? Number(raw) : raw;
}

export const config = {
  port: Number(process.env.PORT ?? 3000),
  host: process.env.HOST ?? '0.0.0.0',
  trustProxy: parseTrustProxy(process.env.TRUST_PROXY),
  iceServers: buildIceServers(),
  chatHistoryLimit: 100,
  /**
   * Group calls are a full mesh (each participant uploads to every other), which
   * stays smooth up to roughly 6–8 people. Beyond that, use an SFU.
   */
  maxCallParticipants: Number(process.env.MAX_CALL_PARTICIPANTS ?? 8),
  ringTimeoutMs: 30_000,
  /** Longer ring when the callee is offline and rung via push (they need time to open the app). */
  offlineRingTimeoutMs: 45_000,
  rootDir: ROOT_DIR,
  /** Where registered accounts (ID + hashed PIN) are stored. */
  dataDir: process.env.DATA_DIR ?? path.join(ROOT_DIR, 'data'),
  /** Sign-in lasts 30 days and renews with use, so installed PWAs stay signed in to answer calls. */
  sessionTtlMs: 30 * 24 * 60 * 60 * 1000,
  /** Failed PIN attempts allowed per ID before a temporary lockout. */
  maxPinFailures: 5,
  pinLockoutMs: 60 * 1000,
  /** Contact for push services (VAPID "sub"); must be a mailto: or https: URL. */
  // Stray quotes/spaces (e.g. VAPID_SUBJECT="mailto:x" kept literally by some tools) make Apple reject every push.
  vapidSubject: (process.env.VAPID_SUBJECT ?? 'mailto:admin@call9me.local').trim().replace(/^["']|["']$/g, '').trim(),
};
