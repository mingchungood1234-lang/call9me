import { EMOJI_NAME_RULES, isValidEmojiName, MAX_EMOJI_BYTES } from '../../shared/validation';
import { el, toast } from './dom';
import { STANDARD_EMOJI, withEmojiStyle, type CustomEmojiStore } from './emoji';
import { NOT_CONNECTED, withTimeout, type AppSocket } from './socket';

/** Custom emoji pictures are shrunk to fit this square before upload. */
const EMOJI_SIZE = 96;

/** Reads a picture and shrinks it to a small square PNG (small GIFs keep their animation). */
async function prepareImage(file: File): Promise<string> {
  if (file.type === 'image/gif' && file.size <= MAX_EMOJI_BYTES) return readAsDataUrl(file);

  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    const scale = Math.min(1, EMOJI_SIZE / Math.max(img.naturalWidth, img.naturalHeight));
    const w = Math.max(1, Math.round(img.naturalWidth * scale));
    const h = Math.max(1, Math.round(img.naturalHeight * scale));
    const canvas = el('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('No canvas');
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(img, 0, 0, w, h);
    const png = canvas.toDataURL('image/png');
    // Photos can still be large as PNG; WebP is much smaller where supported.
    if (png.length * 0.75 <= MAX_EMOJI_BYTES) return png;
    const webp = canvas.toDataURL('image/webp', 0.9);
    if (webp.startsWith('data:image/webp')) return webp;
    throw new Error('Too large');
  } finally {
    URL.revokeObjectURL(url);
  }
}

function readAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

/** Suggests a name from the file name ("Party Cat!.png" → "party_cat"). */
function nameFromFile(file: File): string {
  return file.name
    .replace(/\.[^.]+$/, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 24);
}

/**
 * Emoji button for the chat box: standard emoji, plus custom picture emoji that anyone
 * can add (pick a picture, name it) and use as `:name:`.
 */
export class EmojiPicker {
  private readonly root: HTMLElement;
  private readonly standardView: HTMLElement;
  private readonly customView: HTMLElement;
  private readonly customGrid: HTMLElement;
  private readonly tabs: HTMLButtonElement[];
  private readonly fileInput: HTMLInputElement;
  private readonly nameInput: HTMLInputElement;
  private readonly preview: HTMLImageElement;
  private readonly addForm: HTMLFormElement;
  private pendingImage: string | null = null;

  constructor(
    private readonly socket: AppSocket,
    private readonly selfId: string,
    private readonly store: CustomEmojiStore,
    private readonly input: HTMLInputElement,
    private readonly toggle: HTMLButtonElement,
    container: HTMLElement,
  ) {
    // Standard emoji, grouped.
    this.standardView = el('div', { className: 'emoji-view' });
    for (const group of STANDARD_EMOJI) {
      const grid = el('div', { className: 'emoji-grid' });
      for (const char of group.emoji) {
        const value = withEmojiStyle(char);
        grid.append(this.emojiButton(value, value, () => this.insert(value)));
      }
      this.standardView.append(el('p', { className: 'emoji-group', text: group.label }), grid);
    }

    // Custom emoji + "add from a picture".
    this.customGrid = el('div', { className: 'emoji-grid emoji-grid-custom' });
    this.fileInput = el('input');
    this.fileInput.type = 'file';
    this.fileInput.accept = 'image/png,image/jpeg,image/webp,image/gif';
    this.fileInput.hidden = true;
    const chooseBtn = el('button', { className: 'btn btn-secondary btn-small', text: 'Choose picture' });
    chooseBtn.type = 'button';
    chooseBtn.addEventListener('click', () => this.fileInput.click());
    this.preview = el('img', { className: 'emoji-preview' });
    this.preview.alt = '';
    this.preview.hidden = true;
    this.nameInput = el('input');
    this.nameInput.type = 'text';
    this.nameInput.placeholder = 'name, e.g. party_cat';
    this.nameInput.maxLength = 24;
    this.nameInput.autocapitalize = 'off';
    this.nameInput.spellcheck = false;
    this.nameInput.setAttribute('aria-label', 'Emoji name');
    const saveBtn = el('button', { className: 'btn btn-primary btn-small', text: 'Add' });
    saveBtn.type = 'submit';
    this.addForm = el('form', { className: 'emoji-add' }, [
      el('p', { className: 'emoji-group', text: 'Add your own from a picture' }),
      el('div', { className: 'emoji-add-row' }, [chooseBtn, this.preview, this.fileInput]),
      el('div', { className: 'emoji-add-row' }, [this.nameInput, saveBtn]),
    ]);
    this.customView = el('div', { className: 'emoji-view', title: '' }, [this.customGrid, this.addForm]);
    this.customView.hidden = true;

    this.tabs = (['Emoji', 'Custom'] as const).map((label, i) => {
      const tab = el('button', { className: i === 0 ? 'active' : '', text: label });
      tab.type = 'button';
      tab.setAttribute('role', 'tab');
      tab.addEventListener('click', () => this.showTab(i === 1));
      return tab;
    });

    this.root = el('div', { className: 'emoji-picker' }, [
      el('div', { className: 'mode-switch emoji-tabs' }, this.tabs),
      this.standardView,
      this.customView,
    ]);
    this.root.hidden = true;
    this.root.setAttribute('role', 'dialog');
    this.root.setAttribute('aria-label', 'Emoji');
    container.append(this.root);

    this.toggle.addEventListener('click', () => this.setOpen(this.root.hidden));
    document.addEventListener('pointerdown', (e) => {
      const target = e.target as Node;
      if (!this.root.hidden && !this.root.contains(target) && !this.toggle.contains(target)) this.setOpen(false);
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !this.root.hidden) {
        this.setOpen(false);
        this.toggle.focus();
      }
    });
    this.fileInput.addEventListener('change', () => void this.onFileChosen());
    this.addForm.addEventListener('submit', (e) => {
      e.preventDefault();
      this.upload();
    });
    this.store.onChange(() => this.renderCustom());
    this.renderCustom();
  }

  private setOpen(open: boolean): void {
    this.root.hidden = !open;
    this.toggle.setAttribute('aria-expanded', String(open));
    this.toggle.classList.toggle('active', open);
  }

  private showTab(custom: boolean): void {
    this.standardView.hidden = custom;
    this.customView.hidden = !custom;
    this.tabs.forEach((t, i) => t.classList.toggle('active', (i === 1) === custom));
  }

  /** Inserts at the cursor, keeping custom codes apart from surrounding words. */
  private insert(text: string): void {
    if (this.input.disabled) {
      toast('Join a room to chat first.', 'error');
      return;
    }
    const start = this.input.selectionStart ?? this.input.value.length;
    const end = this.input.selectionEnd ?? start;
    let value = text;
    if (text.startsWith(':')) {
      if (start > 0 && !/\s$/.test(this.input.value.slice(0, start))) value = ` ${value}`;
      value += ' ';
    }
    if (this.input.value.length - (end - start) + value.length > this.input.maxLength && this.input.maxLength > 0) {
      toast('The message is too long for that.', 'error');
      return;
    }
    this.input.setRangeText(value, start, end, 'end');
    this.input.dispatchEvent(new Event('input', { bubbles: true }));
    // Keep the picker open on desktop for picking several; refocusing would pop the phone keyboard up.
    if (!window.matchMedia('(pointer: coarse)').matches) this.input.focus();
  }

  private renderCustom(): void {
    const all = this.store.all;
    if (all.length === 0) {
      this.customGrid.replaceChildren(el('p', { className: 'emoji-empty', text: 'No custom emoji yet. Add the first one below.' }));
      return;
    }
    this.customGrid.replaceChildren(
      ...all.map((emoji) => {
        const img = el('img');
        img.src = emoji.url;
        img.alt = `:${emoji.name}:`;
        img.loading = 'lazy';
        const button = this.emojiButton('', `:${emoji.name}: by ${emoji.owner}`, () => this.insert(`:${emoji.name}:`));
        button.append(img);
        if (emoji.owner.toLowerCase() !== this.selfId.toLowerCase()) return button;

        const remove = el('button', { className: 'emoji-remove', text: '×', title: `Remove :${emoji.name}:` });
        remove.type = 'button';
        remove.setAttribute('aria-label', `Remove :${emoji.name}:`);
        remove.addEventListener('click', (e) => {
          e.stopPropagation();
          this.remove(emoji.name);
        });
        return el('span', { className: 'emoji-own' }, [button, remove]);
      }),
    );
  }

  private emojiButton(text: string, title: string, onClick: () => void): HTMLButtonElement {
    const button = el('button', { className: 'emoji-btn', text, title });
    button.type = 'button';
    button.setAttribute('aria-label', title);
    button.addEventListener('click', onClick);
    return button;
  }

  private async onFileChosen(): Promise<void> {
    const file = this.fileInput.files?.[0];
    this.fileInput.value = '';
    if (!file) return;
    if (!file.type.startsWith('image/')) {
      toast('Choose a picture file.', 'error');
      return;
    }
    try {
      this.pendingImage = await prepareImage(file);
    } catch {
      this.pendingImage = null;
      toast('That picture could not be used. Try a PNG or JPEG.', 'error');
      return;
    }
    this.preview.src = this.pendingImage;
    this.preview.hidden = false;
    if (!this.nameInput.value) this.nameInput.value = nameFromFile(file);
    this.nameInput.focus();
  }

  private upload(): void {
    const name = this.nameInput.value.trim().toLowerCase();
    if (!this.pendingImage) {
      toast('Choose a picture first.', 'error');
      return;
    }
    if (!isValidEmojiName(name)) {
      toast(`Invalid name. ${EMOJI_NAME_RULES}`, 'error');
      this.nameInput.focus();
      return;
    }
    if (!this.socket.connected) {
      toast(NOT_CONNECTED, 'error');
      return;
    }
    this.socket.emit('emoji:add', { name, image: this.pendingImage }, withTimeout((res) => {
      if (!res.ok) {
        toast(res.error, 'error');
        return;
      }
      this.pendingImage = null;
      this.preview.hidden = true;
      this.preview.removeAttribute('src');
      this.nameInput.value = '';
      toast(`Added :${res.emoji.name}: — everyone can use it now.`, 'success');
    }));
  }

  private remove(name: string): void {
    if (!window.confirm(`Remove :${name}: for everyone?`)) return;
    if (!this.socket.connected) {
      toast(NOT_CONNECTED, 'error');
      return;
    }
    this.socket.emit('emoji:remove', { name }, withTimeout((res) => {
      if (!res.ok) toast(res.error, 'error');
    }));
  }
}
