import { el } from './dom';

/** How often an open page asks the server for the current build (the socket also pushes it). */
const CHECK_INTERVAL_MS = 15 * 60_000;

export interface UpdateWatcherOptions {
  /** While true (in a call, typing…), never reload without the user pressing "Update". */
  isBusy?: () => boolean;
  /** Text for the banner while busy. */
  busyText?: string;
}

/**
 * Notices when a newer front end has been deployed and offers to load it.
 *
 * The page knows its own build from `<meta name="app-version">`. The server pushes the
 * current build over the socket on every connect (a deploy restarts the server, so every
 * open app reconnects and hears about it at once) and answers `/api/version` for pages
 * without a socket. When outdated, a banner offers "Update"; if the page isn't on screen
 * and nothing would be lost, it simply reloads.
 */
export class UpdateWatcher {
  private readonly current = document.querySelector<HTMLMetaElement>('meta[name="app-version"]')?.content ?? '';
  private available = false;
  private banner: HTMLElement | null = null;

  constructor(private readonly options: UpdateWatcherOptions = {}) {
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') void this.check();
      else this.reloadIfQuiet();
    });
    setInterval(() => void this.check(), CHECK_INTERVAL_MS);
  }

  /** Reports the server's current build (from the socket or a check). */
  report(version: string): void {
    if (!version || !this.current || version === this.current || this.available) return;
    this.available = true;
    // A newer service worker may come with it (it activates itself, see sw.ts).
    void navigator.serviceWorker?.getRegistration().then((r) => r?.update()).catch(() => {});
    this.showBanner();
    this.reloadIfQuiet();
  }

  /** Call when "busy" may have changed (e.g. a call ended): updates the banner, or reloads if quiet. */
  refresh(): void {
    if (!this.available) return;
    if (this.banner) this.renderBannerText();
    this.reloadIfQuiet();
  }

  async check(): Promise<void> {
    if (this.available || !navigator.onLine) return;
    try {
      const res = await fetch('/api/version', { cache: 'no-store' });
      if (res.ok) this.report(((await res.json()) as { version?: string }).version ?? '');
    } catch {
      /* offline or restarting: try again later */
    }
  }

  private get busy(): boolean {
    return this.options.isBusy?.() ?? false;
  }

  /** Nobody is looking and nothing would be lost: update silently. */
  private reloadIfQuiet(): void {
    if (this.available && document.visibilityState === 'hidden' && !this.busy) window.location.reload();
  }

  private showBanner(): void {
    const update = el('button', { className: 'btn btn-primary btn-small', text: 'Update' });
    update.type = 'button';
    update.addEventListener('click', () => window.location.reload());
    // Dismissed for this page; it still updates by itself the next time it's in the background.
    const later = el('button', { className: 'btn btn-ghost btn-small', text: 'Later' });
    later.type = 'button';
    later.addEventListener('click', () => {
      this.banner?.remove();
      this.banner = null;
    });

    this.banner = el('div', { className: 'update-banner' }, [
      el('span', { className: 'update-banner-text' }),
      el('span', { className: 'update-banner-actions' }, [later, update]),
    ]);
    this.banner.setAttribute('role', 'status');
    document.body.append(this.banner);
    this.renderBannerText();
  }

  private renderBannerText(): void {
    const text = this.banner?.querySelector('.update-banner-text');
    if (!text) return;
    text.textContent = this.busy
      ? (this.options.busyText ?? 'A new version of Call9me is ready.')
      : 'A new version of Call9me is available.';
  }
}
