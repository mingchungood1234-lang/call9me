import { isValidEmail, isValidPin, MAX_EMAIL_LENGTH } from '../../shared/validation';
import { el, toast } from './dom';

interface RecoveryInfo {
  ok: true;
  email: string | null;
  googleEmail: string | null;
  hasPin: boolean;
  mailEnabled: boolean;
}

/**
 * Settings → Recovery email: where "Forgot PIN?" sends the reset link. Changing it asks for
 * the current PIN, so someone holding an unlocked phone can't take over the account's resets.
 */
export class RecoveryEmailDialog {
  private readonly dialog: HTMLDialogElement;
  private readonly note = el('p', { className: 'settings-hint' });
  private readonly email = el('input');
  private readonly pin = el('input');
  private readonly pinField: HTMLElement;
  private readonly error = el('p', { className: 'hint' });
  private readonly save = el('button', { className: 'btn btn-primary', text: 'Save' });
  private readonly remove = el('button', { className: 'btn btn-ghost btn-delete', text: 'Remove' });

  constructor() {
    this.email.type = 'email';
    this.email.maxLength = MAX_EMAIL_LENGTH;
    this.email.autocomplete = 'email';
    this.email.placeholder = 'you@example.com';
    this.email.id = 'recovery-email';
    this.pin.type = 'password';
    this.pin.inputMode = 'numeric';
    this.pin.maxLength = 4;
    this.pin.autocomplete = 'current-password';
    this.pin.placeholder = '••••';
    this.pin.className = 'pin-input';
    this.pin.id = 'recovery-pin';
    this.pin.addEventListener('input', () => (this.pin.value = this.pin.value.replace(/\D/g, '').slice(0, 4)));
    this.error.dataset.state = 'neutral';
    this.error.setAttribute('aria-live', 'polite');

    const label = (forId: string, text: string) => {
      const l = el('label', { text });
      l.htmlFor = forId;
      return l;
    };
    this.pinField = el('div', { className: 'recovery-field' }, [label('recovery-pin', 'Your current PIN'), this.pin]);
    const cancel = el('button', { className: 'btn btn-ghost', text: 'Cancel' });
    for (const b of [cancel, this.save, this.remove]) b.type = 'button';
    cancel.addEventListener('click', () => this.dialog.close());
    this.save.addEventListener('click', () => void this.submit(this.email.value.trim()));
    this.remove.addEventListener('click', () => {
      if (window.confirm('Remove your recovery email? You will not be able to reset a forgotten PIN by email.')) void this.submit('');
    });

    const form = el('form', { className: 'recovery-form' }, [
      el('h3', { className: 'share-title', text: 'Recovery email' }),
      this.note,
      el('div', { className: 'recovery-field' }, [label('recovery-email', 'Email'), this.email]),
      this.pinField,
      this.error,
      el('div', { className: 'dialog-actions' }, [this.remove, cancel, this.save]),
    ]);
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      void this.submit(this.email.value.trim());
    });
    this.dialog = el('dialog', { className: 'share-dialog recovery-dialog' }, [form]);
    this.dialog.addEventListener('click', (e) => {
      if (e.target === this.dialog) this.dialog.close();
    });
    document.body.append(this.dialog);
  }

  async open(): Promise<void> {
    this.error.textContent = '';
    this.pin.value = '';
    let info: RecoveryInfo;
    try {
      const res = await fetch('/api/account/recovery-email', { cache: 'no-store' });
      const data = (await res.json()) as RecoveryInfo | { ok: false; error: string };
      if (!data.ok) throw new Error(data.error);
      info = data;
    } catch (err) {
      toast(err instanceof Error && err.message ? err.message : 'Could not load your recovery email.', 'error');
      return;
    }
    this.email.value = info.email ?? '';
    this.remove.hidden = !info.email;
    this.pinField.hidden = !info.hasPin;
    const fallback = !info.email && info.googleEmail ? ` Until you set one, reset links go to your Google email (${info.googleEmail}).` : '';
    this.note.textContent = info.mailEnabled
      ? `If you forget your PIN, "Forgot your PIN?" on the sign-in page emails a reset link here. Nobody else can see it.${fallback}`
      : 'Saved for later: this server has not set up email yet, so ask an admin if you forget your PIN.';
    this.dialog.showModal();
    this.email.focus();
  }

  private async submit(email: string): Promise<void> {
    const setError = (text: string) => {
      this.error.textContent = text;
      this.error.dataset.state = 'error';
    };
    if (email && !isValidEmail(email)) return setError('That does not look like an email address.');
    if (!this.pinField.hidden && !isValidPin(this.pin.value)) {
      this.pin.focus();
      return setError('Enter your current 4-digit PIN to confirm.');
    }
    this.save.disabled = this.remove.disabled = true;
    try {
      const res = await fetch('/api/account/recovery-email', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, pin: this.pin.value }),
      });
      const data = (await res.json()) as { ok: boolean; error?: string };
      if (!data.ok) {
        this.pin.value = '';
        return setError(data.error ?? 'Could not save it.');
      }
      this.dialog.close();
      toast(email ? 'Recovery email saved.' : 'Recovery email removed.', 'success');
    } catch {
      setError('Could not reach the server. Please try again.');
    } finally {
      this.save.disabled = this.remove.disabled = false;
    }
  }
}
