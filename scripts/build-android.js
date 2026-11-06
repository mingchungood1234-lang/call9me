// Builds the Android app (android/, a Trusted Web Activity) into public/downloads/call9me.apk,
// which the site offers to Android visitors at /download/android. Needs only Docker.
//
// Usage: npm run android:build                      (uses PUBLIC_URL from .env)
//        npm run android:build -- --host call.example.com
//
// The first build creates the signing key in android/keystore/: back it up. Updates must be
// signed with the same key, and /.well-known/assetlinks.json publishes its fingerprint.
const { spawnSync } = require('node:child_process');
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
