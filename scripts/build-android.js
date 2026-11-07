// Builds the Android app (android/, a Trusted Web Activity) into public/downloads/call9me.apk,
// which the site offers to Android visitors at /download/android. Needs only Docker.
//
// Usage: npm run android:build                      (uses PUBLIC_URL from .env)
//        npm run android:build -- --host call.example.com
//
// The first build creates the signing key in android/keystore/: back it up. Updates must be
// signed with the same key, and /.well-known/assetlinks.json publishes its fingerprint.
const { spawnSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const ANDROID = path.join(ROOT, 'android');
const OUT_DIR = path.join(ROOT, 'public', 'downloads');
const IMAGE = 'call9me-android-builder';
const APP_ID = process.env.ANDROID_PACKAGE || 'com.call9me.app';

function fail(message) {
  console.error(`\n✖ ${message}`);
  process.exit(1);
}

/** PUBLIC_URL from the environment or .env (same rules as the server: real env wins). */
function publicUrl() {
  if (process.env.PUBLIC_URL) return process.env.PUBLIC_URL;
  try {
    const env = fs.readFileSync(path.join(ROOT, '.env'), 'utf8');
    const match = env.match(/^\s*PUBLIC_URL\s*=\s*["']?([^"'\s#]+)/m);
    return match ? match[1] : '';
  } catch {
    return '';
  }
}

function hostArg() {
  const i = process.argv.indexOf('--host');
  const raw = i >= 0 ? process.argv[i + 1] : publicUrl();
  if (!raw) {
    fail('Which site should the app open? Set PUBLIC_URL in .env or run: npm run android:build -- --host call.example.com');
  }
  const host = raw.replace(/^https?:\/\//, '').replace(/\/.*$/, '').toLowerCase();
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(host)) {
    fail(`"${raw}" is not a valid hostname. Use the HTTPS domain users open, e.g. call.example.com (no port).`);
  }
  return host;
}

function run(cmd, args) {
  const result = spawnSync(cmd, args, { stdio: 'inherit' });
  if (result.error) fail(`Could not run ${cmd}: ${result.error.message}`);
  if (result.status !== 0) fail(`${cmd} ${args[0]} failed (exit ${result.status}).`);
}

/**
 * Puts the site's front end (CSS and JavaScript) inside the APK, so the app shows its UI from the
 * phone instead of a blank screen while the network loads it (android/…/LocalUi.kt). version.txt
 * is the same fingerprint the server puts in "?v=" (src/server/services/AppVersion.ts): the app
 * only uses these copies while they match the deployed build, and fetches a newer one otherwise.
 */
function bundleFrontEnd() {
  console.log('Building the front end to ship inside the app...');
  const result = spawnSync('npm run build:client', { stdio: 'inherit', cwd: ROOT, shell: true });
  if (result.status !== 0) fail('npm run build:client failed.');

  const pub = path.join(ROOT, 'public');
  const out = path.join(ANDROID, 'app', 'src', 'main', 'assets', 'web');
  fs.rmSync(out, { recursive: true, force: true });
  const copy = (rel) => {
    const target = path.join(out, rel);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(path.join(pub, rel), target);
  };

  copy('css/styles.css');
  // The entry points, and every chunk they import (not stale chunks from older builds).
  const pending = ['js/app.js', 'js/landing.js', 'js/admin.js'];
  const seen = new Set();
  while (pending.length) {
    const rel = pending.pop();
    if (seen.has(rel)) continue;
    seen.add(rel);
    copy(rel);
    const source = fs.readFileSync(path.join(pub, rel), 'utf8');
    for (const match of source.matchAll(/["'](\.\.?\/[\w./-]+\.js)["']/g)) {
      const next = path.posix.normalize(path.posix.join(path.posix.dirname(rel), match[1]));
      if (next.startsWith('js/') && fs.existsSync(path.join(pub, next))) pending.push(next);
    }
  }

  const hash = crypto.createHash('sha1');
  for (const rel of ['js/app.js', 'js/landing.js', 'js/sw.js', 'css/styles.css']) {
    try {
      hash.update(fs.readFileSync(path.join(pub, rel)));
    } catch {
      hash.update('-');
    }
  }
  const version = process.env.APP_VERSION || hash.digest('hex').slice(0, 12);
  fs.writeFileSync(path.join(out, 'version.txt'), `${version}\n`);
  console.log(`  ${seen.size + 1} files, front-end build ${version}`);
}

const host = hostArg();
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const now = new Date();
// Always increasing, so every new APK installs as an update of the previous one.
const versionCode = Math.floor(now.getTime() / 60_000) - 27_000_000;
const versionName = `${pkg.version} (${now.toISOString().slice(0, 10)})`;

if (spawnSync('docker', ['info'], { stdio: 'ignore' }).status !== 0) {
  fail('Docker is not running. Start Docker Desktop (or the Docker service) and try again.');
}

console.log(`Building the Call9me Android app for https://${host}/ (version ${versionName}, code ${versionCode})`);
bundleFrontEnd();
console.log('Preparing the build image (slow the first time: it downloads the Android SDK)...');
run('docker', ['build', '-t', IMAGE, path.join(ANDROID, 'builder')]);

console.log('Building the APK...');
run('docker', [
  'run', '--rm',
  '-v', `${ANDROID}:/project`,
  '-v', 'call9me-gradle-cache:/root/.gradle',
  '-e', `TWA_HOST=${host}`,
  '-e', `APP_ID=${APP_ID}`,
  '-e', `VERSION_CODE=${versionCode}`,
  '-e', `VERSION_NAME=${versionName}`,
  IMAGE,
  'sh', '/project/builder/build.sh',
]);

const apk = path.join(ANDROID, 'build', 'out', 'call9me.apk');
const sha256 = fs.readFileSync(path.join(ANDROID, 'build', 'out', 'sha256.txt'), 'utf8').trim();
if (!/^([0-9A-F]{2}:){31}[0-9A-F]{2}$/.test(sha256)) fail(`Unexpected certificate fingerprint: "${sha256}"`);

fs.mkdirSync(OUT_DIR, { recursive: true });
fs.copyFileSync(apk, path.join(OUT_DIR, 'call9me.apk'));
const info = { packageName: APP_ID, host, versionName, versionCode, sha256: [sha256], builtAt: now.toISOString() };
fs.writeFileSync(path.join(OUT_DIR, 'android.json'), `${JSON.stringify(info, null, 2)}\n`);

const size = (fs.statSync(apk).size / 1024 / 1024).toFixed(1);
console.log(`
✔ public/downloads/call9me.apk (${size} MB) and public/downloads/android.json

  Deploy the site as usual (commit public/downloads/, then rebuild on the server).
  Android visitors then get a "Get the Android app" button, served from /download/android,
  and https://${host}/.well-known/assetlinks.json proves the app belongs to the site.

  Back up android/keystore/ somewhere private: every update must be signed with it.
`);
