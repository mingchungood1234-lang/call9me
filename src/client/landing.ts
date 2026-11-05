import type { AvailabilityResponse, LoginResponse, PairStartResponse, PairStatusResponse } from '../shared/types';
import { isValidPin, isValidUserId, PIN_RULES, USER_ID_RULES } from '../shared/validation';
import { $, autoFocus } from './lib/dom';
import { registerServiceWorker } from './lib/push';
import { formatPairCode, renderQr } from './lib/qr';
import { bindThemeToggle } from './lib/theme';
import { UpdateWatcher } from './lib/updates';
import { lockZoomInStandalone } from './lib/zoom';

lockZoomInStandalone();
bindThemeToggle($<HTMLButtonElement>('#theme-btn'));

const LAST_ID_KEY = 'call9me:lastUserId';

/** The ID + PIN form (absent while finishing a first Google sign-in). */
function setupIdForm(): void {
  const form = $<HTMLFormElement>('#id-form');
  const idInput = $<HTMLInputElement>('#user-id');
  const pinInput = $<HTMLInputElement>('#user-pin');
  const idHint = $<HTMLParagraphElement>('#id-hint');
  const pinHint = $<HTMLParagraphElement>('#pin-hint');
  const button = $<HTMLButtonElement>('#enter-btn');

  type HintState = 'neutral' | 'ok' | 'error';

  function setHint(el: HTMLElement, text: string, state: HintState): void {
    el.textContent = text;
    el.dataset.state = state;
  }

  function validateId(): boolean {
    const value = idInput.value.trim();
    if (!value) {
      setHint(idHint, USER_ID_RULES, 'neutral');
      return false;
    }
    if (/[^\x00-\x7F]/.test(value)) {
      setHint(idHint, 'English characters only, please.', 'error');
      return false;
    }
    if (!isValidUserId(value)) {
      setHint(idHint, USER_ID_RULES, 'error');
      return false;
    }
    return true;
  }

  // Debounced lookup: tells the user whether they are registering or signing in.
  let lookupTimer: ReturnType<typeof setTimeout> | undefined;
  let lookupSeq = 0;
  function lookupId(): void {
    clearTimeout(lookupTimer);
    if (!validateId()) return;
    setHint(idHint, 'Checking…', 'neutral');
    const id = idInput.value.trim();
    const seq = ++lookupSeq;
    lookupTimer = setTimeout(async () => {
      try {
        const data: AvailabilityResponse = await (await fetch(`/api/users/${encodeURIComponent(id)}/availability`)).json();
        if (seq !== lookupSeq) return;
        setHint(idHint, data.registered ? `Welcome back, ${id}!` : 'This ID is free — it will be created for you.', 'ok');
        setHint(pinHint, data.message, 'neutral');
      } catch {
        if (seq === lookupSeq) setHint(idHint, 'Looks good!', 'ok');
      }
    }, 300);
  }

  // PIN field: digits only.
  pinInput.addEventListener('input', () => {
    const digits = pinInput.value.replace(/\D/g, '').slice(0, 4);
    if (digits !== pinInput.value) pinInput.value = digits;
    if (digits.length === 4 && validateId()) button.focus();
  });

  try {
    const last = localStorage.getItem(LAST_ID_KEY);
    if (last && !idInput.value) idInput.value = last;
  } catch {
    // Storage may be unavailable (private mode); prefill is only a convenience.
  }
  if (idInput.value) {
    lookupId();
    autoFocus(pinInput); // no keyboard pop-up on phones (see autoFocus)
  } else {
    autoFocus(idInput);
  }
  idInput.addEventListener('input', lookupId);

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const id = idInput.value.trim();
    const pin = pinInput.value;
    if (!validateId()) {
      idInput.focus();
      return;
    }
    if (!isValidPin(pin)) {
      setHint(pinHint, PIN_RULES, 'error');
      pinInput.focus();
      return;
    }

    button.disabled = true;
    button.textContent = 'Signing in…';
    try {
      const res = await fetch('/api/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, pin }),
      });
      const data: LoginResponse = await res.json();
      if (!data.ok) {
        setHint(pinHint, data.error, 'error');
        pinInput.value = '';
        pinInput.focus();
        return;
      }
      try {
        localStorage.setItem(LAST_ID_KEY, data.userId);
      } catch {
        /* ignore */
      }
      // Return to an invite link (e.g. /app?call=team) if that's how we got here.
      const next = new URLSearchParams(window.location.search).get('next') ?? '';
      window.location.href = /^\/app(\?[\w\-=&%.]*)?$/.test(next) ? next : '/app';
    } catch {
      setHint(pinHint, 'Could not reach the server. Please try again.', 'error');
    } finally {
      button.disabled = false;
      button.textContent = 'Continue';
    }
  });
}
if (document.querySelector('#id-form')) setupIdForm();

/** Same rule as the server: only app URLs (e.g. an invite link) are allowed after sign-in. */
function safeNext(value: string | null | undefined): string {
  return value && /^\/app(\?[\w\-=&%.]*)?$/.test(value) ? value : '/app';
}

// "Continue with Google" keeps an invite link (?next=/app?call=…) to come back to.
const googleBtn = document.querySelector<HTMLAnchorElement>('#google-btn');
const nextParam = new URLSearchParams(window.location.search).get('next');
if (googleBtn && nextParam) googleBtn.href = `/auth/google?next=${encodeURIComponent(safeNext(nextParam))}`;

/** First Google sign-in: pick an ID, or link an existing ID (with its PIN). */
function setupGoogleForm(form: HTMLFormElement): void {
  const idInput = $<HTMLInputElement>('#google-id');
  const pinInput = $<HTMLInputElement>('#google-pin');
  const linkBox = $<HTMLDetailsElement>('#google-link');
  const hint = $<HTMLParagraphElement>('#google-hint');
  const button = $<HTMLButtonElement>('#google-continue');
  const setHint = (text: string, state: 'neutral' | 'error') => {
    hint.textContent = text;
    hint.dataset.state = state;
  };
  linkBox.addEventListener('toggle', () => {
    button.textContent = linkBox.open ? 'Link and continue' : 'Continue';
    if (linkBox.open) pinInput.focus();
    else pinInput.value = '';
  });
  pinInput.addEventListener('input', () => {
    pinInput.value = pinInput.value.replace(/\D/g, '').slice(0, 4);
  });
  autoFocus(idInput);
  if (document.activeElement === idInput) idInput.select();

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const id = idInput.value.trim();
    const pin = linkBox.open ? pinInput.value : '';
    if (!isValidUserId(id)) {
      setHint(USER_ID_RULES, 'error');
      idInput.focus();
      return;
    }
    if (linkBox.open && !isValidPin(pin)) {
      setHint(PIN_RULES, 'error');
      pinInput.focus();
      return;
    }
    button.disabled = true;
    try {
      const res = await fetch('/api/google/complete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(pin ? { id, pin } : { id }),
      });
      const data = (await res.json()) as LoginResponse & { next?: string };
      if (!data.ok) {
        setHint(data.error, 'error');
        return;
      }
      try {
        localStorage.setItem(LAST_ID_KEY, data.userId);
      } catch {
        /* ignore */
      }
      window.location.href = safeNext(data.next);
    } catch {
      setHint('Could not reach the server. Please try again.', 'error');
    } finally {
      button.disabled = false;
    }
  });
}
const googleForm = document.querySelector<HTMLFormElement>('#google-form');
if (googleForm) setupGoogleForm(googleForm);

const PAIR_POLL_MS = 2000;

/** "Sign in with a QR code": show a code, wait for a signed-in device to approve it, then go in. */
function setupQrSignIn(): void {
  const startBtn = $<HTMLButtonElement>('#qr-btn');
  const panel = $<HTMLElement>('#qr-panel');
  const codeEl = $<HTMLElement>('#qr-code');
  const codeText = $<HTMLElement>('#qr-code-text');
  const hint = $<HTMLElement>('#qr-hint');
  const hideWhileOpen = ['#id-form', '#google-btn', '.or-divider'].map((s) => document.querySelector<HTMLElement>(s));
  const defaultHint = hint.innerHTML; // static markup from the page
  let pollTimer: ReturnType<typeof setTimeout> | undefined;
  let expiresAt = 0;

  function show(open: boolean): void {
    panel.hidden = !open;
    startBtn.hidden = open;
    for (const node of hideWhileOpen) if (node) node.hidden = open;
    if (!open) clearTimeout(pollTimer);
  }

  function setHint(text: string, state: 'neutral' | 'error'): void {
    hint.textContent = text;
    hint.dataset.state = state;
  }

  async function start(): Promise<void> {
    clearTimeout(pollTimer);
    show(true);
    codeEl.classList.remove('is-expired');
    hint.innerHTML = defaultHint;
    hint.dataset.state = 'neutral';
    try {
      const data: PairStartResponse = await (await fetch('/api/pair/start', { method: 'POST' })).json();
      if (!data.ok) {
        setHint(data.error, 'error');
        return;
      }
      renderQr(codeEl, data.url);
      codeText.textContent = formatPairCode(data.code);
      expiresAt = data.expiresAt;
      pollTimer = setTimeout(poll, PAIR_POLL_MS);
    } catch {
      setHint('Could not reach the server. Please try again.', 'error');
    }
  }

  async function poll(): Promise<void> {
    if (panel.hidden) return;
    try {
      const data: PairStatusResponse = await (await fetch('/api/pair/status', { cache: 'no-store' })).json();
      if (data.ok && data.status === 'approved') {
        try {
          localStorage.setItem(LAST_ID_KEY, data.userId);
        } catch {
          /* ignore */
        }
        setHint(`Approved. Signing you in as ${data.userId}…`, 'neutral');
        window.location.href = safeNext(new URLSearchParams(window.location.search).get('next'));
        return;
      }
      if ((data.ok && data.status === 'expired') || Date.now() > expiresAt) {
        codeEl.classList.add('is-expired');
        setHint('This code has expired.', 'error');
        startBtn.hidden = false;
        startBtn.textContent = 'Get a new code';
        return;
      }
    } catch {
      // Offline for a moment: keep trying until the code expires.
    }
    pollTimer = setTimeout(poll, PAIR_POLL_MS);
  }

  startBtn.addEventListener('click', () => void start());
  $<HTMLButtonElement>('#qr-cancel').addEventListener('click', () => {
    show(false);
    startBtn.textContent = 'Sign in with a QR code';
  });
}
if (document.querySelector('#qr-btn')) setupQrSignIn();

void registerServiceWorker();

// Website/PWA start page: pick up new deploys, but never wipe what the user is typing.
new UpdateWatcher({
  isBusy: () => [...document.querySelectorAll<HTMLInputElement>('main input')].some((i) => i.value && i.type !== 'hidden'),
});
