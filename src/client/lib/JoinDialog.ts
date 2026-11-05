import type { ChatMessage, RoomSummary } from '../../shared/types';
import { el, formatTime, toast } from './dom';
import { VISIBILITY_LABELS } from './RoomsPanel';
import { withTimeout, type AppSocket } from './socket';

/**
 * Asked before joining a room: who runs it, who's in it and its latest messages, then
 * Join or Cancel. Joining is for good (the room stays in our list until we leave it).
 */
export class JoinDialog {
  private readonly dialog: HTMLDialogElement;
  private readonly title: HTMLElement;
  private readonly meta: HTMLElement;
  private readonly messages: HTMLUListElement;
  private readonly note: HTMLElement;
  private readonly joinBtn: HTMLButtonElement;
  private resolve: ((join: boolean) => void) | null = null;

  constructor(private readonly socket: AppSocket) {
    this.title = el('h3', { className: 'share-title' });
    this.meta = el('p', { className: 'join-meta' });
    this.messages = el('ul', { className: 'join-messages' });
    this.note = el('p', { className: 'join-note' });
    this.joinBtn = el('button', { className: 'btn btn-primary', text: 'Join' });
    this.joinBtn.type = 'button';
    this.joinBtn.addEventListener('click', () => this.dialog.close('join'));
    const cancelBtn = el('button', { className: 'btn btn-ghost', text: 'Cancel' });
    cancelBtn.type = 'button';
    cancelBtn.addEventListener('click', () => this.dialog.close());

    this.dialog = el('dialog', { className: 'share-dialog join-dialog' }, [
      this.title,
      this.meta,
      this.messages,
      this.note,
      el('div', { className: 'dialog-actions' }, [cancelBtn, this.joinBtn]),
    ]);
    this.dialog.addEventListener('click', (e) => {
      if (e.target === this.dialog) this.dialog.close(); // backdrop
    });
    this.dialog.addEventListener('close', () => {
      this.resolve?.(this.dialog.returnValue === 'join');
      this.resolve = null;
    });
    document.body.append(this.dialog);
  }

  /** @returns whether they chose to join. `key`: the invite key from a link. */
  open(roomId: string, key?: string): Promise<boolean> {
    return new Promise((resolve) => {
      this.socket.emit('chat:preview', { roomId, key }, withTimeout((res) => {
        if (!res.ok) {
          toast(res.error, 'error');
          resolve(false);
          return;
        }
        this.resolve?.(false); // an older preview still open
        this.resolve = resolve;
        this.render(roomId.toLowerCase(), res.room, res.recent);
        this.dialog.returnValue = '';
        if (!this.dialog.open) this.dialog.showModal();
        this.joinBtn.focus();
      }));
    });
  }

  private render(roomId: string, room: RoomSummary | null, recent: ChatMessage[]): void {
    if (!room) {
      this.title.textContent = `Create #${roomId}?`;
      this.meta.textContent = 'Nobody uses this room ID yet.';
      this.messages.hidden = true;
      this.note.textContent = "You'll own the room. It starts public; you can change who sees it in People → Rooms.";
      this.joinBtn.textContent = 'Create';
      return;
    }
    this.title.textContent = `Join #${room.id}?`;
    const parts = [VISIBILITY_LABELS[room.visibility], `by ${room.owner}`, `${room.followers} joined`];
    if (room.online.length) parts.push(`${room.online.length} online`);
    if (room.inCall) parts.push(`${room.inCall} in call`);
    this.meta.textContent = parts.join(' · ');

    this.messages.hidden = false;
    this.messages.replaceChildren(
      ...(recent.length
        ? recent.map((m) =>
            el('li', { className: 'join-message' }, [
              el('span', { className: 'msg-author', text: m.from }),
              el('span', { className: 'join-message-text', text: m.sticker ? 'Sticker' : m.text }),
              el('time', { text: formatTime(m.timestamp) }),
            ]),
          )
        : [el('li', { className: 'empty-state', text: 'No messages yet.' })]),
    );
    this.note.textContent = 'It stays in your chat list, with notifications, until you leave it.';
    this.joinBtn.textContent = 'Join';
  }
}
