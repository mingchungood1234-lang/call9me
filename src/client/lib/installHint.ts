import { androidDownloadUrl, inAndroidPwa } from './androidApp';
import { el } from './dom';
import { isStandalone } from './push';

/** Chrome/Edge/Samsung Internet's install event (not in the TS DOM lib yet). */
interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

const DISMISSED_KEY = 'call9me:installHintDismissedAt';
/** After "Not now", ask again only after this long. */
const SNOOZE_MS = 7 * 24 * 60 * 60_000;

// The browser fires this once, early: catch it at import time so the hint can offer a real "Install" button.
let deferredPrompt: BeforeInstallPromptEvent | null = null;
const promptListeners: (() => void)[] = [];
window.addEventListener('beforeinstallprompt', (event) => {
  event.preventDefault(); // we show our own, nicer hint instead of the mini-infobar
  deferredPrompt = event as BeforeInstallPromptEvent;
  for (const fn of promptListeners) fn();
});
window.addEventListener('appinstalled', () => {
  deferredPrompt = null;
  document.querySelector('.install-hint')?.remove();
});

function isIos(): boolean {
  return /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
}

function isMobile(): boolean {
  return isIos() || /android|mobile/i.test(navigator.userAgent);
}

function snoozed(): boolean {
  try {
    const at = Number(localStorage.getItem(DISMISSED_KEY));
    return !!at && Date.now() - at < SNOOZE_MS;
  } catch {
    return false;
  }
}

function snooze(): void {
  try {
    localStorage.setItem(DISMISSED_KEY, String(Date.now()));
  } catch {
    /* hidden for this visit only */
  }
}

/** The iOS Share glyph, so the instructions match what the user sees in Safari. */
function shareIcon(): SVGSVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  svg.classList.add('install-hint-glyph');
  svg.innerHTML =
    '<path d="M12 3v12M8 7l4-4 4 4" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>' +
    '<path d="M6 11H5a1 1 0 0 0-1 1v8a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-8a1 1 0 0 0-1-1h-1" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>';
  return svg;
}

function steps(): HTMLElement {
  const list = el('ol', { className: 'install-hint-steps' });
  if (isIos()) {
    const first = el('li', { text: 'Tap ' });
    first.append(shareIcon(), document.createTextNode(' Share in the browser bar'));
    const second = el('li', { text: 'Choose ' });
    second.append(el('strong', { text: 'Add to Home Screen' }));
    list.append(first, second);
  } else {
    const first = el('li', { text: 'Open your browser menu ' });
    first.append(el('strong', { text: '⋮' }));
    const second = el('li', { text: 'Choose ' });
    second.append(el('strong', { text: 'Add to Home screen' }), document.createTextNode(' or '), el('strong', { text: 'Install app' }));
    list.append(first, second);
  }
  return list;
}

export interface InstallHintOptions {
  /** Wait this long before sliding in, so it doesn't compete with the page's first moments. */
  delayMs?: number;
}

/**
 * Invites the user to add Call9me to their home screen. Shown when the site runs in a normal
 * browser tab on a phone (with step-by-step instructions), or anywhere the browser offers a
 * real install prompt (one-tap "Install"), and "Not now" keeps it away for a week.
 *
 * On Android, when the server has the Android app (`npm run android:build`), it offers that
 * download instead, never the PWA: on every visit in the browser, and inside an installed PWA
 * (to switch over). There "Not now" lasts one visit. Never shown inside the Android app.
 */
export function showInstallHint(options: InstallHintOptions = {}): void {
  // Android, when the server offers the app: always the real app, never the PWA. Offered on
  // every visit (in a browser tab, or in the PWA to switch over); "Not now" lasts one visit.
  const apkUrl = androidDownloadUrl();
  if (apkUrl) {
    if (!androidDismissed()) {
      setTimeout(() => {
        if (!document.querySelector('.install-hint')) renderAndroid(apkUrl);
      }, options.delayMs ?? 2500);
    }
    return;
  }

  if (isStandalone() || snoozed()) return;

  let shown = false;
  const show = () => {
    if (shown || isStandalone() || document.querySelector('.install-hint')) return;
    // Desktop: only when the browser can actually install it. Phones: always (manual steps as fallback).
    if (!deferredPrompt && !isMobile()) return;
    shown = true;
    render();
  };

  setTimeout(() => {
    show();
    if (!shown) promptListeners.push(show); // install prompt may still arrive
  }, options.delayMs ?? 2500);
}

const ANDROID_DISMISSED_KEY = 'call9me:androidHintDismissed';

/** "Not now" on the Android card hides it for this visit (browser session) only. */
function androidDismissed(): boolean {
  try {
    return sessionStorage.getItem(ANDROID_DISMISSED_KEY) === '1';
  } catch {
    return false;
  }
}

function dismissAndroid(): void {
  try {
    sessionStorage.setItem(ANDROID_DISMISSED_KEY, '1');
  } catch {
    /* hidden for this page only */
  }
}

/** How to install the downloaded APK (Android asks once to allow installs from the browser). */
function androidSteps(): HTMLElement {
  const list = el('ol', { className: 'install-hint-steps' });
  const first = el('li', { text: 'Open ' });
  first.append(el('strong', { text: 'Call9me.apk' }), document.createTextNode(' when the download finishes'));
  const second = el('li', { text: 'If asked, allow your browser to ' });
  second.append(el('strong', { text: 'install unknown apps' }));
  const third = el('li', { text: 'Tap ' });
  third.append(el('strong', { text: 'Install' }), document.createTextNode(', then open Call9me'));
  list.append(first, second, third);
  if (inAndroidPwa()) {
    // Two Call9me icons would be confusing (and both would ring): retire the home-screen version.
    const fourth = el('li', { text: 'Remove this old home-screen version: long-press its icon → ' });
    fourth.append(el('strong', { text: 'Uninstall' }));
    list.append(fourth);
  }
  return list;
}

/** Android variant: a one-tap download of the Android app (android/, built into the site). */
function renderAndroid(apkUrl: string): void {
  const card = el('aside', { className: 'install-hint' });
  card.setAttribute('role', 'dialog');
  card.setAttribute('aria-labelledby', 'install-hint-title');

  const close = () => {
    card.classList.add('is-leaving');
    setTimeout(() => card.remove(), 250);
  };

  const later = el('button', { className: 'btn btn-ghost btn-small', text: 'Not now' });
  later.type = 'button';
  later.addEventListener('click', () => {
    dismissAndroid();
    close();
  });

  const download = el('a', { className: 'btn btn-primary btn-small install-hint-go', text: 'Download app' });
  download.href = apkUrl;
  download.download = 'Call9me.apk';

  const body = el('div', { className: 'install-hint-body' });
  const pwa = inAndroidPwa();
  const title = el('h2', {
    className: 'install-hint-title',
    text: pwa ? '📱 Switch to the Call9me Android app' : '📱 Get the Call9me app for Android',
  });
  title.id = 'install-hint-title';
  const text = el('p', {
    className: 'install-hint-text',
    text: pwa
      ? 'This home-screen version is being replaced by a real Android app: install it for the best calls and notifications.'
      : 'Use the real Android app instead of the browser: one-tap calls that ring even when it is closed, instant notifications and a full-screen experience.',
  });
  body.append(title, text);
  const actions = el('div', { className: 'install-hint-actions' }, [later, download]);

  download.addEventListener('click', () => {
    // The download has started: show how to install it, and don't offer it again this visit.
    dismissAndroid();
    text.textContent = 'Downloading… then:';
    body.append(androidSteps());
    const gotIt = el('button', { className: 'btn btn-primary btn-small install-hint-ok', text: 'Got it' });
    gotIt.type = 'button';
    gotIt.addEventListener('click', close);
    actions.replaceChildren(gotIt);
  });

  const icon = el('div', { className: 'brand-mark install-hint-icon', text: '9' });
  icon.setAttribute('aria-hidden', 'true');
  card.append(el('div', { className: 'install-hint-head' }, [icon, body]), actions);
  document.body.append(card);
}

function render(): void {
  const card = el('aside', { className: 'install-hint' });
  card.setAttribute('role', 'dialog');
  card.setAttribute('aria-labelledby', 'install-hint-title');

  const close = () => {
    card.classList.add('is-leaving');
    setTimeout(() => card.remove(), 250);
  };

  const later = el('button', { className: 'btn btn-ghost btn-small', text: 'Not now' });
  later.type = 'button';
  later.addEventListener('click', () => {
    snooze();
    close();
  });

  const actions = el('div', { className: 'install-hint-actions' }, [later]);
  const body = el('div', { className: 'install-hint-body' });
  const title = el('h2', { className: 'install-hint-title', text: '✨ Unlock the full potential of Call9me' });
  title.id = 'install-hint-title';
  body.append(
    title,
    el('p', {
      className: 'install-hint-text',
      text: 'Add it to your home screen for one-tap calls, instant notifications and a sleek full-screen experience — just like a native app.',
    }),
  );

  const renderInstallButton = () => {
    if (!deferredPrompt || actions.querySelector('.install-hint-go')) return;
    body.querySelector('.install-hint-steps')?.remove();
    actions.querySelector('.install-hint-ok')?.remove();
    const install = el('button', { className: 'btn btn-primary btn-small install-hint-go', text: 'Install now' });
    install.type = 'button';
    install.addEventListener('click', async () => {
      const prompt = deferredPrompt;
      if (!prompt) return;
      deferredPrompt = null;
      await prompt.prompt();
      const { outcome } = await prompt.userChoice.catch(() => ({ outcome: 'dismissed' as const }));
      if (outcome === 'dismissed') snooze();
      close();
    });
    actions.append(install);
  };

  if (deferredPrompt) renderInstallButton();
  else {
    body.append(steps());
    promptListeners.push(renderInstallButton); // upgrade to a one-tap button if the browser allows it
    const gotIt = el('button', { className: 'btn btn-primary btn-small install-hint-ok', text: 'Got it' });
    gotIt.type = 'button';
    gotIt.addEventListener('click', () => {
      snooze();
      close();
    });
    actions.append(gotIt);
  }

  const icon = el('div', { className: 'brand-mark install-hint-icon', text: '9' });
  icon.setAttribute('aria-hidden', 'true');
  card.append(el('div', { className: 'install-hint-head' }, [icon, body]), actions);
  document.body.append(card);
}
