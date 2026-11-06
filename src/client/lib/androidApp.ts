import { isStandalone } from './push';

const IN_APP_KEY = 'call9me:inAndroidApp';

// The Android app (a Trusted Web Activity) opens the site with an android-app:// referrer.
// Remember it for the session, as later navigations lose that referrer.
try {
  if (document.referrer.startsWith('android-app://')) sessionStorage.setItem(IN_APP_KEY, '1');
} catch {
  /* storage blocked: the standalone check below still covers the app */
}

export function isAndroid(): boolean {
  return /android/i.test(navigator.userAgent);
}

/** True inside the installed Android app (or the installed PWA, which needs no download either). */
export function inInstalledApp(): boolean {
  if (isStandalone()) return true;
  try {
    return sessionStorage.getItem(IN_APP_KEY) === '1';
  } catch {
    return false;
  }
}

/**
 * Where to download the Android app, when this is an Android browser tab and the server has an
 * APK to offer (`<meta name="android-app">`, see views/partials/head.ejs); otherwise null.
 */
export function androidDownloadUrl(): string | null {
  if (!isAndroid() || inInstalledApp()) return null;
  return document.querySelector<HTMLMetaElement>('meta[name="android-app"]')?.content || null;
}
