export type Tab = 'users' | 'call' | 'chat';

/** Must match the phone breakpoint in styles.css. */
export const PHONE_QUERY = '(max-width: 720px), (max-height: 520px) and (orientation: landscape)';

/** Bottom tab bar on phones: only one panel (users / call / chat) is visible at a time. */
export class MobileTabs {
  private readonly mq = window.matchMedia(PHONE_QUERY);
  private readonly buttons = [...document.querySelectorAll<HTMLButtonElement>('[data-tab-target]')];
  private current: Tab;
  private readonly listeners: ((tab: Tab) => void)[] = [];

  constructor(initial: Tab = 'call') {
    this.current = initial;
    for (const button of this.buttons) {
      button.addEventListener('click', () => this.show(button.dataset.tabTarget as Tab));
    }
    this.show(initial);
  }

  get isPhone(): boolean {
    return this.mq.matches;
  }

  get active(): Tab {
    return this.current;
  }

  onChange(listener: (tab: Tab) => void): void {
    this.listeners.push(listener);
  }

  show(tab: Tab): void {
    this.current = tab;
    document.body.dataset.tab = tab;
    for (const button of this.buttons) {
      const selected = button.dataset.tabTarget === tab;
      button.setAttribute('aria-selected', String(selected));
      button.classList.toggle('active', selected);
    }
    this.listeners.forEach((l) => l(tab));
  }

  /** On desktop every panel is visible at once. */
  isVisible(tab: Tab): boolean {
    return !this.isPhone || this.current === tab;
  }

  setBadge(tab: Tab, value: string | number | null): void {
    const badge = document.querySelector<HTMLElement>(`[data-tab-badge="${tab}"]`);
    if (!badge) return;
    const empty = value === null || value === 0 || value === '';
    badge.hidden = empty;
    badge.textContent = empty ? '' : String(value);
  }
}
