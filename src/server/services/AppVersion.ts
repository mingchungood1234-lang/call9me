import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config';

/** The built front end; a change to any of these is a new version for open pages. */
const ASSET_FILES = ['js/app.js', 'js/landing.js', 'js/sw.js', 'css/styles.css'].map((f) =>
  path.join(config.rootDir, 'public', f),
);

let cached: { stamp: string; version: string } | null = null;

/**
 * A short fingerprint of the front-end build (or APP_VERSION when set). Pages compare
 * it with the one they were loaded with to know a newer version has been deployed.
 * Recomputed only when an asset file changes (cheap to call per request).
 */
export function appVersion(): string {
  if (process.env.APP_VERSION) return process.env.APP_VERSION;
  const stamp = ASSET_FILES.map((file) => {
    try {
      const stat = fs.statSync(file);
      return `${stat.size}:${stat.mtimeMs}`;
    } catch {
      return '-';
    }
  }).join('|');
  if (cached?.stamp === stamp) return cached.version;

  const hash = createHash('sha1');
  for (const file of ASSET_FILES) {
    try {
      hash.update(fs.readFileSync(file));
    } catch {
      hash.update('-');
    }
  }
  cached = { stamp, version: hash.digest('hex').slice(0, 12) };
  return cached.version;
}
