import type { Presence } from '../../shared/types';
import { avatar, el, toast } from './dom';
import { NOT_CONNECTED, withTimeout, type AppSocket } from './socket';

export interface ShareDialogDeps {
  /** Our friends (IDs as registered). */
  friends(): string[];
  presenceOf(id: string): Presence | 'away';
  /** The invite key of a "link" room we're allowed in, if any. */
  keyOf(roomId: string): string | undefined;
}

/** The link that opens a room's chat (or joins its call); includes the invite key for invite-only rooms. */
export function roomLink(roomId: string, call: boolean, key?: string): string {
  const url = new URL('/app', window.location.origin);
  url.searchParams.set(call ? 'call' : 'room', roomId);
  if (key) url.searchParams.set('key', key);
  return url.toString();
}

/**
 * "Share": pick friends to send the room to (they get an invite in the app and a push),
 * while the link itself is copied to the clipboard right away for anywhere else.
 */
export class ShareDialog {
  private readonly dialog: HTMLDialogElement;
  private readonly title: HTMLElement;
  private readonly list: HTMLUListElement;
  private readonly linkInput: HTMLInputElement;
  private readonly copyStatus: HTMLElement;
  private readonly sendBtn: HTMLButtonElement;
  private roomId = '';
  private call = false;

  constructor(
    private readonly socket: AppSocket,
    private readonly deps: ShareDialogDeps,
  ) {
    this.title = el('h3', { className: 'share-title' });
    this.list = el('ul', { className: 'share-friends' });
    this.linkInput = el('input');
    this.linkInput.type = 'text';
    this.linkInput.readOnly = true;
    this.linkInput.setAttribute('aria-label', 'Invite link');
    this.linkInput.addEventListener('focus', () => this.linkInput.select());
    const copyBtn = el('button', { className: 'btn btn-secondary btn-small', text: 'Copy' });
    copyBtn.type = 'button';
    copyBtn.addEventListener('click', () => void this.copy());
    this.copyStatus = el('p', { className: 'share-copy-status' });
    this.sendBtn = el('button', { className: 'btn btn-primary', text: 'Send' });
    this.sendBtn.type = 'button';
    this.sendBtn.addEventListener('click', () => this.send());
    const closeBtn = el('button', { className: 'btn btn-ghost', text: 'Done' });
    closeBtn.type = 'button';
    closeBtn.addEventListener('click', () => this.dialog.close());

    this.dialog = el('dialog', { className: 'share-dialog' }, [
      this.title,
      el('p', { className: 'share-section', text: 'Send to friends' }),
      this.list,
      el('p', { className: 'share-section', text: 'Or share the link anywhere' }),
      el('div', { className: 'share-link-row' }, [this.linkInput, copyBtn]),
      this.copyStatus,
      el('div', { className: 'dialog-actions' }, [closeBtn, this.sendBtn]),
    ]);
    this.dialog.addEventListener('click', (e) => {
      if (e.target === this.dialog) this.dialog.close(); // backdrop
    });
    this.list.addEventListener('change', () => this.renderSendButton());
    document.body.append(this.dialog);
  }

  /** Call from the click handler: the clipboard copy needs the tap that opened it. */
  open(roomId: string, call: boolean): void {
    this.roomId = roomId;
    this.call = call;
    this.title.textContent = call ? `Invite people to the call in #${roomId}` : `Share #${roomId}`;
    this.linkInput.value = roomLink(roomId, call, this.deps.keyOf(roomId));
    this.renderFriends();
    this.dialog.showModal();
    void this.copy();
  }

  private async copy(): Promise<void> {
    try {
      await navigator.clipboard.writeText(this.linkInput.value);
      this.copyStatus.textContent = '✓ Link copied to the clipboard.';
      this.copyStatus.dataset.state = 'ok';
    } catch {
      this.linkInput.select();
      this.copyStatus.textContent = 'Could not copy automatically. Press Copy, or select the link.';
      this.copyStatus.dataset.state = 'error';
    }
  }

  private renderFriends(): void {
    const order = (id: string) => {
      const p = this.deps.presenceOf(id);
      return p === 'offline' || p === 'away' ? 1 : 0;
    };
    const friends = [...this.deps.friends()].sort((a, b) => order(a) - order(b) || a.localeCompare(b));
    if (friends.length === 0) {
      this.list.replaceChildren(el('li', { className: 'empty-state', text: 'Add friends to send them rooms here.' }));
    } else {
      this.list.replaceChildren(
        ...friends.map((id) => {
          const box = el('input');
          box.type = 'checkbox';
          box.value = id;
          const presence = this.deps.presenceOf(id);
          return el('li', {}, [
            el('label', { className: `share-friend user-item ${presence}` }, [
              box,
              avatar(id, [el('span', { className: 'presence-dot' })]),
              el('span', { className: 'user-name', text: id }),
            ]),
          ]);
        }),
      );
    }
    this.renderSendButton();
  }

  private selected(): string[] {
    return [...this.list.querySelectorAll<HTMLInputElement>('input[type=checkbox]:checked')].map((b) => b.value);
  }

  private renderSendButton(): void {
    const count = this.selected().length;
    this.sendBtn.disabled = count === 0;
    this.sendBtn.textContent = count ? `Send to ${count}` : 'Send';
  }

  private send(): void {
    const to = this.selected();
    if (to.length === 0) return;
    if (!this.socket.connected) {
      toast(NOT_CONNECTED, 'error');
      return;
    }
    this.sendBtn.disabled = true;
    this.socket.emit('rooms:share', { roomId: this.roomId, to, call: this.call }, withTimeout((res) => {
      this.renderSendButton();
      if (!res.ok) {
        toast(res.error, 'error');
        return;
      }
      toast(`Sent to ${res.sent.join(', ')}.`, 'success');
      this.dialog.close();
    }));
  }
}
