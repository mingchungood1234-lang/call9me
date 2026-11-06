import { createSign } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config';

/**
 * Firebase Cloud Messaging (HTTP v1) for the native Android app: rings the phone for calls
 * (even when the app is closed) and delivers chat notifications. Uses a Firebase service
 * account (Firebase console → Project settings → Service accounts → Generate new private key),
 * from FCM_SERVICE_ACCOUNT (the JSON itself, or base64 of it), FCM_SERVICE_ACCOUNT_FILE (a path),
 * or <DATA_DIR>/fcm-service-account.json. Off when none is set.
 */
interface ServiceAccount {
  project_id: string;
  client_email: string;
  private_key: string;
  token_uri?: string;
}

export interface FcmResult {
  ok: boolean;
  status: number;
  error?: string;
  /** The token is dead (app uninstalled, data cleared…): forget it. */
  unregistered?: boolean;
}

const SCOPE = 'https://www.googleapis.com/auth/firebase.messaging';

function parseAccount(raw: string): ServiceAccount | null {
  const text = raw.trim().startsWith('{') ? raw : Buffer.from(raw.trim(), 'base64').toString('utf8');
  try {
    const account = JSON.parse(text) as ServiceAccount;
    return account.project_id && account.client_email && account.private_key ? account : null;
  } catch {
    return null;
  }
}

function loadAccount(): ServiceAccount | null {
  const inline = process.env.FCM_SERVICE_ACCOUNT?.trim();
  const file = process.env.FCM_SERVICE_ACCOUNT_FILE?.trim() || path.join(config.dataDir, 'fcm-service-account.json');
  let raw = inline ?? '';
  if (!raw) {
    try {
      raw = fs.readFileSync(file, 'utf8');
    } catch {
      return null;
    }
  }
  const account = parseAccount(raw);
  if (!account) console.warn('[fcm] the Firebase service account is not valid JSON with project_id, client_email and private_key');
  return account;
}

export class FcmSender {
  private readonly account = loadAccount();
  private accessToken: { value: string; expires: number } | null = null;

  constructor() {
    if (this.account) console.log(`[fcm] Android push on (Firebase project ${this.account.project_id})`);
  }

  get enabled(): boolean {
    return this.account !== null;
  }

  /** OAuth access token for FCM, from a JWT signed with the service account key (cached ~1 h). */
  private async token(): Promise<string> {
    if (this.accessToken && this.accessToken.expires > Date.now() + 60_000) return this.accessToken.value;
    const account = this.account!;
    const tokenUri = account.token_uri || 'https://oauth2.googleapis.com/token';
    const now = Math.floor(Date.now() / 1000);
    const encode = (obj: unknown) => Buffer.from(JSON.stringify(obj)).toString('base64url');
    const unsigned = `${encode({ alg: 'RS256', typ: 'JWT' })}.${encode({
      iss: account.client_email,
      scope: SCOPE,
      aud: tokenUri,
      iat: now,
      exp: now + 3600,
    })}`;
    const signature = createSign('RSA-SHA256').update(unsigned).sign(account.private_key, 'base64url');
    const res = await fetch(tokenUri, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        assertion: `${unsigned}.${signature}`,
      }),
    });
    const body = (await res.json().catch(() => ({}))) as { access_token?: string; expires_in?: number; error?: string };
    if (!res.ok || !body.access_token) throw new Error(`token request failed: ${res.status} ${body.error ?? ''}`);
    this.accessToken = { value: body.access_token, expires: Date.now() + (body.expires_in ?? 3600) * 1000 };
    return body.access_token;
  }

  /** Sends a data message (the app builds the notification itself, e.g. a full-screen call). */
  async send(deviceToken: string, data: Record<string, string>, opts: { high: boolean; ttlSeconds: number }): Promise<FcmResult> {
    if (!this.account) return { ok: false, status: 0, error: 'FCM is not configured' };
    try {
      const res = await fetch(`https://fcm.googleapis.com/v1/projects/${this.account.project_id}/messages:send`, {
        method: 'POST',
        headers: { authorization: `Bearer ${await this.token()}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          message: {
            token: deviceToken,
            data,
            android: { priority: opts.high ? 'high' : 'normal', ttl: `${opts.ttlSeconds}s` },
          },
        }),
      });
      if (res.ok) return { ok: true, status: res.status };
      const body = (await res.json().catch(() => ({}))) as {
        error?: { message?: string; status?: string; details?: { errorCode?: string }[] };
      };
      const code = body.error?.details?.find((d) => d.errorCode)?.errorCode ?? body.error?.status ?? '';
      const unregistered =
        res.status === 404 || code === 'UNREGISTERED' || (code === 'INVALID_ARGUMENT' && /registration token/i.test(body.error?.message ?? ''));
      return { ok: false, status: res.status, error: `${code} ${body.error?.message ?? ''}`.trim().slice(0, 200), unregistered };
    } catch (err) {
      return { ok: false, status: 0, error: (err as Error).message.slice(0, 200) };
    }
  }
}

export const fcm = new FcmSender();
