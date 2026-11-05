import type { PairInfoResponse } from '../../shared/types';
import { el, toast } from './dom';
import { formatPairCode } from './qr';

/** The browser's own QR reader (Chrome on Android, among others); not in TypeScript's DOM types yet. */
interface BarcodeDetectorLike {
  detect(source: HTMLVideoElement): Promise<{ rawValue: string }[]>;
}
declare global {
  interface Window {
    BarcodeDetector?: new (options: { formats: string[] }) => BarcodeDetectorLike;
  }
}

const SCAN_INTERVAL_MS = 250;
/** Frames are shrunk to this width for the JS decoder (plenty for a QR code on a screen). */
const DECODE_WIDTH = 640;

/** The pairing code in a scanned QR code (a sign-in URL) or a typed code; null if it isn't one. */
function codeFrom(value: string): string | null {
  const fromUrl = /[?&]pair=([A-Za-z0-9-]+)/.exec(value);
  const code = (fromUrl ? fromUrl[1] : value).replace(/[\s-]/g, '').toUpperCase();
  return /^[A-Z0-9]{8}$/.test(code) ? code : null;
}

function ago(ms: number): string {
  const seconds = Math.max(1, Math.round(ms / 1000));
  return seconds < 60 ? `${seconds} s ago` : `${Math.round(seconds / 60)} min ago`;
}

/**
 * "Sign in another device": scan the QR code (or type the code) shown on the other
 * device's sign-in page, check which browser is asking, and approve it. The camera runs
 * inside the app on purpose: an installed iPhone app doesn't share its sign-in with Safari,
 * so scanning with the Camera app would open a browser that isn't signed in.
 */
export class LinkDeviceDialog {
  private readonly dialog: HTMLDialogElement;
  private readonly scanView: HTMLElement;
  private readonly confirmView: HTMLElement;
  private readonly video: HTMLVideoElement;
  private readonly cameraNote: HTMLElement;
  private readonly codeInput: HTMLInputElement;
  private readonly confirmText: HTMLElement;
  private readonly approveBtn: HTMLButtonElement;
  private stream: MediaStream | null = null;
  private scanTimer: ReturnType<typeof setTimeout> | null = null;
  private code = '';

  constructor(private readonly userId: string) {
    this.video = el('video', { className: 'link-video' });
    this.video.muted = true;
    this.video.playsInline = true;
    this.video.setAttribute('playsinline', ''); // older iOS
    this.cameraNote = el('p', { className: 'join-note' });
    this.codeInput = el('input');
    this.codeInput.type = 'text';
    this.codeInput.placeholder = 'ABCD-2345';
    this.codeInput.maxLength = 9;
    this.codeInput.autocapitalize = 'characters';
    this.codeInput.autocomplete = 'off';
    this.codeInput.spellcheck = false;
    this.codeInput.setAttribute('aria-label', 'Code shown on the other device');
    const nextBtn = el('button', { className: 'btn btn-secondary btn-small', text: 'Next' });
    nextBtn.type = 'submit';
    const codeForm = el('form', { className: 'share-link-row' }, [this.codeInput, nextBtn]);
    codeForm.addEventListener('submit', (e) => {
      e.preventDefault();
      const code = codeFrom(this.codeInput.value);
      if (code) void this.confirm(code);
      else toast('Enter the 8-character code shown on the other device.', 'error');
    });
    this.scanView = el('div', { className: 'link-step' }, [
      el('p', { className: 'join-note', text: 'On the other device, choose "Sign in with a QR code", then point this camera at the code.' }),
      el('div', { className: 'link-camera' }, [this.video]),
      this.cameraNote,
      el('p', { className: 'share-section', text: 'Or type the code' }),
      codeForm,
    ]);

    this.confirmText = el('p', { className: 'link-confirm' });
    this.approveBtn = el('button', { className: 'btn btn-primary', text: 'Sign it in' });
    this.approveBtn.type = 'button';
    this.approveBtn.addEventListener('click', () => void this.approve());
    this.confirmView = el('div', { className: 'link-step' }, [
      this.confirmText,
      el('p', {
        className: 'join-note link-warning',
        text: "Only approve a device you're holding or sitting at right now. Never approve a code someone else sent you.",
      }),
    ]);

    const cancelBtn = el('button', { className: 'btn btn-ghost', text: 'Cancel' });
    cancelBtn.type = 'button';
    cancelBtn.addEventListener('click', () => this.dialog.close());
    this.dialog = el('dialog', { className: 'share-dialog link-dialog' }, [
      el('h3', { className: 'share-title', text: 'Sign in another device' }),
      this.scanView,
      this.confirmView,
      el('div', { className: 'dialog-actions' }, [cancelBtn, this.approveBtn]),
    ]);
    this.dialog.addEventListener('click', (e) => {
      if (e.target === this.dialog) this.dialog.close(); // backdrop
    });
    this.dialog.addEventListener('close', () => this.stopCamera());
    document.body.append(this.dialog);
  }

  /** `code`: already known (the app was opened from the QR code's link), so skip scanning. */
  open(code?: string): void {
    if (!this.dialog.open) this.dialog.showModal();
    const known = code ? codeFrom(code) : null;
    if (known) {
      void this.confirm(known);
      return;
    }
    this.showStep('scan');
    this.codeInput.value = '';
    void this.startCamera();
  }

  private showStep(step: 'scan' | 'confirm'): void {
    this.scanView.hidden = step !== 'scan';
    this.confirmView.hidden = step !== 'confirm';
    this.approveBtn.hidden = step !== 'confirm';
  }

  // ---- Scanning ----

  private async startCamera(): Promise<void> {
    this.cameraNote.textContent = 'Starting the camera…';
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' } }, audio: false });
    } catch {
      this.cameraNote.textContent = 'The camera is unavailable or blocked. Type the code instead.';
      return;
    }
    if (!this.dialog.open || this.scanView.hidden) {
      this.stopCamera(); // closed while the permission prompt was up
      return;
    }
    this.video.srcObject = this.stream;
    await this.video.play().catch(() => {});
    this.cameraNote.textContent = '';
    this.scheduleScan(await this.decoder());
  }

  /** The browser's QR reader if it has one, else the bundled JS decoder (loaded only now). */
  private async decoder(): Promise<() => Promise<string | null>> {
    if (window.BarcodeDetector) {
      const detector = new window.BarcodeDetector({ formats: ['qr_code'] });
      return async () => (await detector.detect(this.video).catch(() => []))[0]?.rawValue ?? null;
    }
    const { default: jsQR } = await import('jsqr');
    const canvas = el('canvas');
    const context = canvas.getContext('2d', { willReadFrequently: true });
    return async () => {
      const { videoWidth, videoHeight } = this.video;
      if (!context || !videoWidth) return null;
      const scale = Math.min(1, DECODE_WIDTH / videoWidth);
      canvas.width = Math.round(videoWidth * scale);
      canvas.height = Math.round(videoHeight * scale);
      context.drawImage(this.video, 0, 0, canvas.width, canvas.height);
      const image = context.getImageData(0, 0, canvas.width, canvas.height);
      return jsQR(image.data, image.width, image.height, { inversionAttempts: 'dontInvert' })?.data ?? null;
    };
  }

  private scheduleScan(read: () => Promise<string | null>): void {
    this.scanTimer = setTimeout(async () => {
      if (!this.stream) return;
      const value = await read();
      const code = value ? codeFrom(value) : null;
      if (code) void this.confirm(code);
      else if (value) {
        this.cameraNote.textContent = "That QR code isn't a Call9me sign-in code.";
        this.scheduleScan(read);
      } else this.scheduleScan(read);
    }, SCAN_INTERVAL_MS);
  }

  private stopCamera(): void {
    if (this.scanTimer) clearTimeout(this.scanTimer);
    this.scanTimer = null;
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    this.video.srcObject = null;
  }

  // ---- Approving ----

  private async confirm(code: string): Promise<void> {
    this.stopCamera();
    const info = await this.post('/api/pair/info', code);
    if (!info) {
      if (this.scanView.hidden) this.dialog.close(); // opened from a link: nothing to scan
      else void this.startCamera();
      return;
    }
    this.code = info.code;
    this.confirmText.replaceChildren(
      document.createTextNode('Sign in '),
      el('strong', { text: info.device }),
      document.createTextNode(` (code ${formatPairCode(info.code)}, requested ${ago(info.ageMs)}) as `),
      el('strong', { text: this.userId }),
      document.createTextNode('? It gets full access to your account until you sign out there.'),
    );
    this.showStep('confirm');
    this.approveBtn.focus();
  }

  private async approve(): Promise<void> {
    this.approveBtn.disabled = true;
    const result = await this.post('/api/pair/approve', this.code);
    this.approveBtn.disabled = false;
    if (!result) return;
    this.dialog.close();
    toast(`${result.device} is signing in as ${this.userId}.`, 'success', 6000);
  }

  private async post(url: string, code: string): Promise<Extract<PairInfoResponse, { ok: true }> | null> {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code }),
      });
      const data: PairInfoResponse = await res.json();
      if (data.ok) return data;
      toast(data.error, 'error');
    } catch {
      toast('Could not reach the server. Please try again.', 'error');
    }
    return null;
  }
}
