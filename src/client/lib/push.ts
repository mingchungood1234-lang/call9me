export type PushStatus = 'unsupported' | 'needs-install' | 'denied' | 'off' | 'on';

function isIos(): boolean {
  return /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
}

export function isStandalone(): boolean {
  return (
    window.matchMedia('(display-mode: standalone)').matches ||
    (navigator as Navigator & { standalone?: boolean }).standalone === true
  );
}

export async function registerServiceWorker(): Promise<ServiceWorkerRegistration | null> {
  if (!('serviceWorker' in navigator)) return null;
  try {
    return await navigator.serviceWorker.register('/sw.js', { scope: '/' });
  } catch (err) {
    console.warn('Service worker registration failed', err);
    return null;
  }
}

function base64UrlToBytes(base64Url: string): Uint8Array<ArrayBuffer> {
  const base64 = (base64Url + '='.repeat((4 - (base64Url.length % 4)) % 4)).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(base64);
  const bytes = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  return bytes;
}

function bytesToBase64Url(bytes: Uint8Array): string {
  let raw = '';
  for (const b of bytes) raw += String.fromCharCode(b);
  return btoa(raw).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function postJson(url: string, body: unknown): Promise<Response> {
  return fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
}

/**
 * Web Push for the signed-in user. iOS only allows push for PWAs added to the
 * home screen (iOS 16.4+), which is reported as "needs-install".
 */
export class PushNotifications {
  private registration: ServiceWorkerRegistration | null = null;

  async init(): Promise<PushStatus> {
    this.registration = await registerServiceWorker();
    if ((await this.status()) !== 'on') return this.status();

    let sub = await this.registration!.pushManager.getSubscription();
    if (sub && !(await this.matchesServerKey(sub))) {
      // Made with an older server key (e.g. keys regenerated on redeploy): every push
      // would be rejected (Apple: "BadJwtToken"). Replace it with one for the current key.
      await postJson('/api/push/unsubscribe', { endpoint: sub.endpoint }).catch(() => {});
      await sub.unsubscribe().catch(() => {});
      sub = await this.subscribe().catch(() => null); // iOS may insist on a tap: then the bell shows "off"
    }
    // Re-link this device to the current user (it may have been another user before).
    if (sub) await postJson('/api/push/subscribe', { subscription: sub.toJSON() }).catch(() => {});
    return this.status();
  }

  /**
   * Replaces this device's subscription if it was made with an outdated server key.
   * Call from a tap (iOS may require it). @returns whether it was replaced.
   */
  async repair(): Promise<boolean> {
    const sub = await this.registration?.pushManager.getSubscription();
    if (!sub || (await this.matchesServerKey(sub))) return false;
    await postJson('/api/push/unsubscribe', { endpoint: sub.endpoint }).catch(() => {});
    await sub.unsubscribe().catch(() => {});
    const fresh = await this.subscribe();
    await postJson('/api/push/subscribe', { subscription: fresh.toJSON() });
    return true;
  }

  private async serverKey(): Promise<string> {
    const { publicKey } = (await (await fetch('/api/push/key')).json()) as { publicKey: string };
    return publicKey;
  }

  private async matchesServerKey(sub: PushSubscription): Promise<boolean> {
    const key = sub.options.applicationServerKey;
    if (!key) return true; // browser doesn't expose it; can't tell
    try {
      return bytesToBase64Url(new Uint8Array(key)) === (await this.serverKey()).replace(/=+$/, '');
    } catch {
      return true; // offline: keep it
    }
  }

  private async subscribe(): Promise<PushSubscription> {
    return this.registration!.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: base64UrlToBytes(await this.serverKey()),
    });
  }

  async status(): Promise<PushStatus> {
    if (!this.registration || !('PushManager' in window) || !('Notification' in window)) {
      return isIos() && !isStandalone() ? 'needs-install' : 'unsupported';
    }
    if (Notification.permission === 'denied') return 'denied';
    if (Notification.permission !== 'granted') return 'off';
    return (await this.registration.pushManager.getSubscription()) ? 'on' : 'off';
  }

  /** Must be called from a user gesture (button click), required by iOS. */
  async enable(): Promise<PushStatus> {
    if (!this.registration) return this.status();
    const permission = await Notification.requestPermission();
    if (permission !== 'granted') return this.status();

    let subscription = await this.registration.pushManager.getSubscription();
    if (subscription && !(await this.matchesServerKey(subscription))) {
      await subscription.unsubscribe().catch(() => {});
      subscription = null;
    }
    subscription ??= await this.subscribe();
    const res = await postJson('/api/push/subscribe', { subscription: subscription.toJSON() });
    if (!res.ok) throw new Error('Server rejected the subscription');
    return 'on';
  }

  async disable(): Promise<PushStatus> {
    const sub = await this.registration?.pushManager.getSubscription();
    if (sub) {
      await postJson('/api/push/unsubscribe', { endpoint: sub.endpoint }).catch(() => {});
      await sub.unsubscribe().catch(() => {});
    }
    return this.status();
  }

  /** On sign-out: stop pushes for this user to this device, but keep the browser permission. */
  async detach(): Promise<void> {
    const sub = await this.registration?.pushManager.getSubscription();
    if (sub) await postJson('/api/push/unsubscribe', { endpoint: sub.endpoint }).catch(() => {});
  }
}
