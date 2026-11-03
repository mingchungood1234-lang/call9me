import type { AvailabilityResponse, LoginResponse } from '../shared/types';
import { isValidPin, isValidUserId, PIN_RULES, USER_ID_RULES } from '../shared/validation';
import { $ } from './lib/dom';
import { registerServiceWorker } from './lib/push';
import { bindThemeToggle } from './lib/theme';
import { UpdateWatcher } from './lib/updates';
import { lockZoomInStandalone } from './lib/zoom';

lockZoomInStandalone();
bindThemeToggle($<HTMLButtonElement>('#theme-btn'));

const LAST_ID_KEY = 'call9me:lastUserId';

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
      setHint(pinHint, data.message, data.online ? 'error' : 'neutral');
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
  pinInput.focus();
} else {
  idInput.focus();
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

void registerServiceWorker();

// Website/PWA start page: pick up new deploys, but never wipe what the user is typing.
new UpdateWatcher({ isBusy: () => !!(idInput.value || pinInput.value) });
