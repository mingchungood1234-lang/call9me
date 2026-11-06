import { inNativeApp } from './nativeApp';
import { isStandalone } from './push';

const IN_APP_KEY = 'call9me:inAndroidApp';

// The Android app (a Trusted Web Activity) opens the site with an android-app:// referrer.
// Remember it for the session, as later navigations lose that referrer.
try {
  if (document.referrer.startsWith('android-app://')) sessionStorage.setItem(IN_APP_KEY, '1');
} catch {
  /* storage blocked: inAndroidApp() still sees the referrer on the first page */
}

export function isAndroid(): boolean {
  return /android/i.test(navigator.userAgent);
}

/** True inside the installed Android app (not the PWA, which shares the browser's storage). */
export function inAndroidApp(): boolean {
  if (inNativeApp() || document.referrer.startsWith('android-app://')) return true;
  try {
    return sessionStorage.getItem(IN_APP_KEY) === '1';
  } catch {
    return false;
  }
}

/** The home-screen PWA on Android: these users are asked to switch to the real app. */
export function inAndroidPwa(): boolean {
  return isAndroid() && isStandalone() && !inAndroidApp();
}

/**
 * Where to download the Android app: on Android (browser tab or the PWA, never the app itself)
 * when the server has an APK to offer (`<meta name="android-app">`, views/partials/head.ejs).
 */
export function androidDownloadUrl(): string | null {
  if (!isAndroid() || inAndroidApp()) return null;
  return document.querySelector<HTMLMetaElement>('meta[name="android-app"]')?.content || null;
}
