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

/** A stable hue (0–359) per user ID, so everyone keeps the same avatar color. */
export function hueFor(id: string): number {
  let hash = 0;
  for (const ch of id.toLowerCase()) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  return hash % 360;
}

export function avatar(id: string, extra: Node[] = []): HTMLSpanElement {
  const node = el('span', { className: 'avatar', text: id.charAt(0).toUpperCase() }, extra);
  node.dataset.hue = '';
  node.style.setProperty('--h', String(hueFor(id)));
  return node;
}

export type ToastKind = 'info' | 'success' | 'error';

export function toast(message: string, kind: ToastKind = 'info', durationMs = 4000): void {
  let container = document.getElementById('toasts');
  if (!container) {
    container = el('div');
    container.id = 'toasts';
    document.body.append(container);
  }
  const item = el('div', { className: `toast toast-${kind}`, text: message });
  item.setAttribute('role', kind === 'error' ? 'alert' : 'status');
  container.append(item);
  setTimeout(() => {
    item.classList.add('toast-leave');
    item.addEventListener('transitionend', () => item.remove(), { once: true });
    setTimeout(() => item.remove(), 500);
  }, durationMs);
}

export function formatTime(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}
