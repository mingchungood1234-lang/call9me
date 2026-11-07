import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config';

/**
 * The Android app (android/, a Trusted Web Activity), built by `npm run android:build` into
 * public/downloads: call9me.apk plus android.json (package name and signing certificate).
 */
export interface AndroidAppInfo {
  apkPath: string;
  size: number;
  packageName: string;
  versionName: string;
  /** Android's version number: the app updates itself when the site offers a higher one. */
  versionCode: number;
  /** SHA-256 fingerprints of the signing certificate(s), as AA:BB:… */
  sha256: string[];
}

const DIR = path.join(config.rootDir, 'public', 'downloads');
const APK = path.join(DIR, 'call9me.apk');
const META = path.join(DIR, 'android.json');
const FINGERPRINT = /^([0-9A-F]{2}:){31}[0-9A-F]{2}$/;

let cached: { stamp: string; info: AndroidAppInfo | null } | null = null;

/** Comma-separated fingerprints from the environment (e.g. a Google Play app signing key). */
function envFingerprints(): string[] {
  return (process.env.ANDROID_CERT_SHA256 ?? '')
    .split(',')
    .map((s) => s.trim().toUpperCase())
    .filter((s) => FINGERPRINT.test(s));
}

/** The built app, or null when there's no APK to offer. Cheap to call per request (stat only). */
export function androidApp(): AndroidAppInfo | null {
  let stamp = '-';
  try {
    const apk = fs.statSync(APK);
    const meta = fs.statSync(META);
    stamp = `${apk.size}:${apk.mtimeMs}|${meta.mtimeMs}`;
  } catch {
    /* not built */
  }
  if (cached?.stamp === stamp) return cached.info;

  let info: AndroidAppInfo | null = null;
  if (stamp !== '-') {
    try {
      const meta = JSON.parse(fs.readFileSync(META, 'utf8')) as Partial<{
        packageName: string;
        versionName: string;
        versionCode: number;
        sha256: string[];
      }>;
      const sha256 = [...new Set([...(meta.sha256 ?? []), ...envFingerprints()])].filter((s) => FINGERPRINT.test(s));
      info = {
        apkPath: APK,
        size: fs.statSync(APK).size,
        packageName: process.env.ANDROID_PACKAGE?.trim() || meta.packageName || 'com.call9me.app',
        versionName: meta.versionName ?? '',
        versionCode: Number(meta.versionCode) || 0,
        sha256,
      };
    } catch (err) {
      console.warn('[android] public/downloads/android.json is unreadable:', (err as Error).message);
    }
  }
  cached = { stamp, info };
  return info;
}

/**
 * Digital Asset Links for /.well-known/assetlinks.json: tells Chrome the Android app belongs to
 * this site, so it opens full screen without a browser bar (and its links open in the app).
 */
export function assetLinks(): unknown[] {
  const app = androidApp();
  const packageName = app?.packageName ?? process.env.ANDROID_PACKAGE?.trim() ?? 'com.call9me.app';
  const sha256 = app?.sha256 ?? envFingerprints();
  if (sha256.length === 0) return [];
  return [
    {
      relation: ['delegate_permission/common.handle_all_urls'],
      target: { namespace: 'android_app', package_name: packageName, sha256_cert_fingerprints: sha256 },
    },
  ];
}
