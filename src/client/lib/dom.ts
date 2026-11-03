export function $<T extends HTMLElement = HTMLElement>(selector: string, root: ParentNode = document): T {
  const el = root.querySelector<T>(selector);
  if (!el) throw new Error(`Element not found: ${selector}`);
  return el;
}

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: { className?: string; text?: string; title?: string } = {},
  children: Node[] = [],
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (props.className) node.className = props.className;
  if (props.text !== undefined) node.textContent = props.text;
  if (props.title) node.title = props.title;
  node.append(...children);
  return node;
}

/**
 * Focus for convenience when a page or panel opens — but not on touch screens, where
 * focusing a text field pops the keyboard up (and iOS offers saved passwords) on its own.
 */
export function autoFocus(element: HTMLElement): void {
  if (!window.matchMedia('(pointer: coarse)').matches) element.focus();
}

/** A stable hue (0–359) per user ID, so everyone keeps the same avatar color. */
export function hueFor(id: string): number {
  let hash = 0;
  for (const ch of id.toLowerCase()) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  return hash % 360;
}

/** Profile picture URLs by lowercased user ID (kept current by the app from `avatars:update`). */
const avatarUrls = new Map<string, string>();
const avatarListeners: (() => void)[] = [];

export function setAvatarUrls(urls: Record<string, string>): void {
  avatarUrls.clear();
  for (const [key, url] of Object.entries(urls)) avatarUrls.set(key, url);
  avatarListeners.forEach((l) => l());
}

export function avatarUrlOf(id: string): string | undefined {
  return avatarUrls.get(id.toLowerCase());
}

/** Called when anyone's picture changes, to redraw lists. */
export function onAvatarsChange(listener: () => void): void {
  avatarListeners.push(listener);
}

/** Shows a user's picture in `node` (or their initial on a colored circle when they have none). */
export function paintAvatar(node: HTMLElement, id: string): void {
  const url = avatarUrlOf(id);
  node.querySelector(':scope > .avatar-img')?.remove();
  node.classList.toggle('has-img', !!url);
  if (!url) return;
  const img = el('img', { className: 'avatar-img' });
  img.src = url;
  img.alt = '';
  img.decoding = 'async';
  node.prepend(img);
}

export function avatar(id: string, extra: Node[] = []): HTMLSpanElement {
  const node = el('span', { className: 'avatar', text: id.charAt(0).toUpperCase() }, extra);
  node.dataset.hue = '';
  node.style.setProperty('--h', String(hueFor(id)));
  paintAvatar(node, id);
  return node;
}

export type ToastKind = 'info' | 'success' | 'error';

const MAX_TOASTS = 4;
/** Visible toasts by message, so a repeated message refreshes instead of stacking. */
const openToasts = new Map<string, { item: HTMLElement; timer: ReturnType<typeof setTimeout> }>();

export function toast(message: string, kind: ToastKind = 'info', durationMs = 4000): void {
  let container = document.getElementById('toasts');
  if (!container) {
    container = el('div');
    container.id = 'toasts';
    document.body.append(container);
  }
  const key = `${kind}:${message}`;
  const dismiss = (item: HTMLElement) => {
    if (openToasts.get(key)?.item === item) openToasts.delete(key);
    item.classList.add('toast-leave');
    item.addEventListener('transitionend', () => item.remove(), { once: true });
    setTimeout(() => item.remove(), 500);
  };

  const existing = openToasts.get(key);
  if (existing) {
    clearTimeout(existing.timer);
    existing.timer = setTimeout(() => dismiss(existing.item), durationMs);
    return;
  }

  const item = el('div', { className: `toast toast-${kind}`, text: message });
  item.setAttribute('role', kind === 'error' ? 'alert' : 'status');
  item.addEventListener('click', () => dismiss(item));
  container.append(item);
  openToasts.set(key, { item, timer: setTimeout(() => dismiss(item), durationMs) });

  // Drop the oldest ones so a burst of events can't bury the screen.
  const live = [...container.querySelectorAll<HTMLElement>('.toast:not(.toast-leave)')];
  for (const old of live.slice(0, Math.max(0, live.length - MAX_TOASTS))) {
    for (const [k, t] of openToasts) {
      if (t.item !== old) continue;
      clearTimeout(t.timer);
      openToasts.delete(k);
    }
    old.remove();
  }
}

/** "4:07", or "1:02:09" past an hour. */
export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = String(total % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
}

export function formatTime(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}
