import { avatar, el } from './dom';

const MAX_SUGGESTIONS = 6;
/** The `@partial` word right before the cursor. */
const TRIGGER = /(^|[^\w@])@([A-Za-z0-9_]{0,20})$/;

/**
 * Suggests people while typing `@…` in the chat box (↑/↓ to move, Enter or Tab to pick,
 * Esc to close; tapping works too). Picking replaces the partial name with `@Id `.
 */
export class MentionAutocomplete {
  private readonly list: HTMLUListElement;
  private matches: string[] = [];
  private active = 0;
  /** Where the `@` of the word being completed is in the input. */
  private start = -1;

  constructor(
    private readonly input: HTMLInputElement,
    container: HTMLElement,
    /** Everyone worth suggesting (in the room first); our own ID is left out. */
    private readonly candidates: () => string[],
    private readonly selfId: string,
  ) {
    this.list = el('ul', { className: 'mention-list' });
    this.list.setAttribute('role', 'listbox');
    this.list.hidden = true;
    container.append(this.list);

    input.addEventListener('input', () => this.update());
    input.addEventListener('click', () => this.update());
    input.addEventListener('blur', () => setTimeout(() => this.close(), 150));
    // Any tap elsewhere (e.g. the emoji button) closes it too, even if the input never had focus.
    document.addEventListener('pointerdown', (e) => {
      const target = e.target as Node;
      if (!this.list.hidden && !this.list.contains(target) && target !== input) this.close();
    });
    // Capture phase, so Enter picks a name instead of sending the message.
    input.addEventListener(
      'keydown',
      (e) => {
        if (this.list.hidden) return;
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
          e.preventDefault();
          this.active = (this.active + (e.key === 'ArrowDown' ? 1 : -1) + this.matches.length) % this.matches.length;
          this.render();
        } else if (e.key === 'Enter' || e.key === 'Tab') {
          e.preventDefault();
          e.stopPropagation();
          this.pick(this.matches[this.active]);
        } else if (e.key === 'Escape') {
          e.preventDefault();
          this.close();
        }
      },
      true,
    );
  }

  private update(): void {
    const cursor = this.input.selectionStart ?? this.input.value.length;
    const match = TRIGGER.exec(this.input.value.slice(0, cursor));
    if (!match) return this.close();
    const typed = match[2].toLowerCase();
    this.start = cursor - match[2].length - 1;
    const self = this.selfId.toLowerCase();
    const seen = new Set<string>();
    this.matches = this.candidates().filter((id) => {
      const key = id.toLowerCase();
      if (key === self || seen.has(key) || !key.startsWith(typed)) return false;
      seen.add(key);
      return true;
    }).slice(0, MAX_SUGGESTIONS);
    if (this.matches.length === 0) return this.close();
    this.active = 0;
    this.render();
  }

  private render(): void {
    this.list.hidden = false;
    this.list.replaceChildren(
      ...this.matches.map((id, i) => {
        const item = el('li', { className: i === this.active ? 'active' : '' }, [avatar(id), el('span', { text: id })]);
        item.setAttribute('role', 'option');
        item.setAttribute('aria-selected', String(i === this.active));
        // pointerdown + preventDefault keeps the keyboard (and focus) in the input.
        item.addEventListener('pointerdown', (e) => {
          e.preventDefault();
          this.pick(id);
        });
        return item;
      }),
    );
  }

  private pick(id: string | undefined): void {
    if (!id || this.start < 0) return this.close();
    const cursor = this.input.selectionStart ?? this.input.value.length;
    this.input.setRangeText(`@${id} `, this.start, cursor, 'end');
    this.close();
  }

  private close(): void {
    this.list.hidden = true;
    this.matches = [];
    this.start = -1;
  }
}
