import type { PairInfoResponse } from '../../shared/types';
import { el, toast } from './dom';
import { formatPairCode } from './qr';

/** The browser's own QR reader (Chrome on Android, among others); not in TypeScript's DOM types yet. */
interface BarcodeDetectorLike {
  detect(source: HTMLVideoElement): Promise<{ rawValue: string }[]>;
}
interface BarcodeDetectorClass {
  new (options: { formats: string[] }): BarcodeDetectorLike;
  getSupportedFormats?(): Promise<string[]>;
}
declare global {
  interface Window {
    BarcodeDetector?: BarcodeDetectorClass;
  }
}

const SCAN_INTERVAL_MS = 150;
/** Frames are shrunk to at most this size for the JS decoder (plenty for a QR code on a screen). */
const DECODE_SIZE = 720;
type Reader = () => Promise<string | null>;

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
  private readonly retryBtn: HTMLButtonElement;
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
    this.cameraNote = el('p', { className: 'join-note link-camera-note' });
    this.retryBtn = el('button', { className: 'btn btn-secondary btn-small', text: 'Try the camera again' });
    this.retryBtn.type = 'button';
    this.retryBtn.hidden = true;
    this.retryBtn.addEventListener('click', () => void this.startCamera());
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
      // The frame shows where to hold the code; the decoder also looks there first.
      el('div', { className: 'link-camera' }, [this.video, el('span', { className: 'link-viewfinder' })]),
      this.cameraNote,
      this.retryBtn,
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
    // Phones may take the camera away in the background: start it again on return.
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible' && this.dialog.open && !this.scanView.hidden && !this.cameraLive()) {
        void this.startCamera();
      }
    });
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

  private cameraLive(): boolean {
    return this.stream?.getVideoTracks().some((t) => t.readyState === 'live') ?? false;
  }

  private async startCamera(): Promise<void> {
    this.stopCamera();
    this.retryBtn.hidden = true;
    if (!navigator.mediaDevices?.getUserMedia) {
      this.cameraFailed("This browser can't use the camera here (it needs HTTPS). Type the code instead.");
      return;
    }
    this.cameraNote.textContent = 'Starting the camera…';
    let stream: MediaStream;
    try {
      // The back camera at a good resolution; any camera if that's all there is (laptops).
      stream = await navigator.mediaDevices
        .getUserMedia({ video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false })
        .catch(() => navigator.mediaDevices.getUserMedia({ video: true, audio: false }));
    } catch (err) {
      const blocked = (err as DOMException).name === 'NotAllowedError';
      this.cameraFailed(
        blocked
          ? 'Camera access is blocked. Allow it for this site in your browser settings, or type the code instead.'
          : 'The camera is unavailable (another app may be using it). Type the code instead.',
      );
      return;
    }
    if (!this.dialog.open || this.scanView.hidden) {
      stream.getTracks().forEach((t) => t.stop()); // closed while the permission prompt was up
      return;
    }
    this.stream = stream;
    for (const track of stream.getVideoTracks()) {
      track.addEventListener('ended', () => {
        if (this.stream === stream) this.cameraFailed('The camera stopped.');
      });
    }
    this.video.srcObject = stream;
    await this.video.play().catch(() => {});
    if (!this.video.videoWidth) {
      await new Promise((resolve) => this.video.addEventListener('loadedmetadata', resolve, { once: true }));
    }
    if (this.stream !== stream) return; // closed or restarted meanwhile
    this.cameraNote.textContent = 'Hold the code inside the frame.';
    this.scheduleScan(await this.reader());
  }

  private cameraFailed(message: string): void {
    this.stopCamera();
    this.cameraNote.textContent = message;
    this.retryBtn.hidden = false;
  }

  /**
   * The browser's QR reader when it really reads QR codes (some browsers have the API
   * without QR support), else the bundled JS decoder, loaded only now. A reader that
   * fails at runtime falls back to the JS decoder too.
   */
  private async reader(): Promise<Reader> {
    const Detector = window.BarcodeDetector;
    const formats = Detector ? await Detector.getSupportedFormats?.().catch(() => [] as string[]) : [];
    if (Detector && (formats ?? ['qr_code']).includes('qr_code')) {
      try {
        const detector = new Detector({ formats: ['qr_code'] });
        let fallback: Reader | null = null;
        return async () => {
          if (fallback) return fallback();
          try {
            return (await detector.detect(this.video))[0]?.rawValue ?? null;
          } catch {
            fallback = await this.jsReader();
            return fallback();
          }
        };
      } catch {
        // Unsupported after all: use the JS decoder.
      }
    }
    return this.jsReader();
  }

  /** jsQR on video frames: alternately the framed middle of the picture (sharper) and the whole picture. */
  private async jsReader(): Promise<Reader> {
    const { default: jsQR } = await import('jsqr');
    const canvas = el('canvas');
    const context = canvas.getContext('2d', { willReadFrequently: true });
    let frame = 0;
    return async () => {
      const { videoWidth: w, videoHeight: h } = this.video;
      if (!context || !w || !h) return null;
      const crop = frame++ % 2 === 0;
      const side = Math.min(w, h) * 0.75;
      const [sx, sy, sw, sh] = crop ? [(w - side) / 2, (h - side) / 2, side, side] : [0, 0, w, h];
      const scale = Math.min(1, DECODE_SIZE / Math.max(sw, sh));
      canvas.width = Math.round(sw * scale);
      canvas.height = Math.round(sh * scale);
      context.drawImage(this.video, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);
      const image = context.getImageData(0, 0, canvas.width, canvas.height);
      return jsQR(image.data, image.width, image.height, { inversionAttempts: 'attemptBoth' })?.data ?? null;
    };
  }

  private scheduleScan(read: Reader): void {
    this.scanTimer = setTimeout(async () => {
      if (!this.stream) return;
      // Nothing to read while the app is in the background (and the frames are frozen).
      const value = document.visibilityState === 'visible' ? await read().catch(() => null) : null;
      if (!this.stream) return;
      const code = value ? codeFrom(value) : null;
      if (code) {
        navigator.vibrate?.(60);
        void this.confirm(code);
        return;
      }
      if (value) this.cameraNote.textContent = "That QR code isn't a Call9me sign-in code.";
      this.scheduleScan(read);
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
