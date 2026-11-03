import type { RoomSummary, RoomVisibility } from '../../shared/types';
import { isValidRoomId, ROOM_ID_RULES } from '../../shared/validation';
import { $, el, hueFor, toast } from './dom';
import { NOT_CONNECTED, withTimeout, type AppSocket } from './socket';

const LOCK_SVG =
  '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M18 8h-1V6A5 5 0 0 0 7 6v2H6a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V10a2 2 0 0 0-2-2Zm-6 9a2 2 0 1 1 0-4 2 2 0 0 1 0 4Zm3.1-9H8.9V6a3.1 3.1 0 0 1 6.2 0v2Z"/></svg>';

const LINK_SVG =
  '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M10.6 13.4a1 1 0 0 1 0-1.4l3.5-3.5a1 1 0 1 1 1.4 1.4L12 13.4a1 1 0 0 1-1.4 0Zm-2.1 6.4a4.5 4.5 0 0 1-3.2-7.7l2.5-2.5a1 1 0 1 1 1.4 1.4l-2.5 2.5a2.5 2.5 0 0 0 3.5 3.5l2.5-2.5a1 1 0 0 1 1.4 1.4l-2.5 2.5a4.5 4.5 0 0 1-3.1 1.4Zm7.4-5.2a1 1 0 0 1-.7-1.7l2.5-2.5a2.5 2.5 0 0 0-3.5-3.5l-2.5 2.5a1 1 0 0 1-1.4-1.4l2.5-2.5a4.5 4.5 0 0 1 6.3 6.3l-2.5 2.5a1 1 0 0 1-.7.3Z"/></svg>';

const VISIBILITY_LABELS: Record<RoomVisibility, string> = { public: 'Public', private: 'Private', link: 'Link only' };
const VISIBILITY_TITLES: Record<RoomVisibility, string> = {
  public: 'Public: everyone can see and join it',
  private: 'Private: only your friends can see and join it',
  link: 'Link only: a permanent room (chat is kept) that people join through its invite link',
};
const NEXT_VISIBILITY: Record<RoomVisibility, RoomVisibility> = { public: 'private', private: 'link', link: 'public' };

export interface RoomsPanelEvents {
  onOpenChat(roomId: string): void;
  onJoinCall(roomId: string): void;
  onShare(roomId: string): void;
}

/** The Rooms directory: public rooms, friends' private rooms and our own; create rooms and set who sees them. */
export class RoomsPanel {
  private rooms: RoomSummary[] = [];
  private createVisibility: RoomVisibility = 'public';

  private readonly listEl = $<HTMLUListElement>('#rooms-list');
  private readonly form = $<HTMLFormElement>('#room-create-form');
  private readonly input = $<HTMLInputElement>('#room-create-id');
  private readonly visibilityBtn = $<HTMLButtonElement>('#room-create-visibility');

  constructor(
    private readonly socket: AppSocket,
    private readonly selfId: string,
    private readonly events: RoomsPanelEvents,
  ) {
    socket.on('rooms:update', (rooms) => {
      this.rooms = rooms;
      this.render();
    });
    this.visibilityBtn.addEventListener('click', () => {
      this.createVisibility = NEXT_VISIBILITY[this.createVisibility];
      this.renderCreateVisibility();
    });
    this.form.addEventListener('submit', (e) => {
      e.preventDefault();
      this.create();
    });
    this.renderCreateVisibility();
    this.render();
  }

  /** The listed room with this ID (for the chat header's lock), if we can see it. */
  find(roomId: string): RoomSummary | undefined {
    return this.rooms.find((r) => r.id === roomId.toLowerCase());
  }

  private isMine(room: RoomSummary): boolean {
    return room.owner.toLowerCase() === this.selfId.toLowerCase();
  }

  private renderCreateVisibility(): void {
    const v = this.createVisibility;
    this.visibilityBtn.dataset.visibility = v;
    this.visibilityBtn.textContent = VISIBILITY_LABELS[v];
    this.visibilityBtn.title = `${VISIBILITY_TITLES[v]}. Tap to change.`;
    this.visibilityBtn.setAttribute('aria-label', `Visibility: ${VISIBILITY_TITLES[v]}. Tap to change.`);
  }

  private create(): void {
    const roomId = this.input.value.trim();
    if (!isValidRoomId(roomId)) {
      toast(`Enter a valid room ID (${ROOM_ID_RULES})`, 'error');
      this.input.focus();
      return;
    }
    if (!this.socket.connected) {
      toast(NOT_CONNECTED, 'error');
      return;
    }
    this.socket.emit('rooms:create', { roomId, visibility: this.createVisibility }, withTimeout((res) => {
      if (!res.ok) {
        toast(res.error, 'error');
        return;
      }
      this.input.value = '';
      // The list arrives a moment later; keep the key now so Share works straight away.
      this.rooms = [res.room, ...this.rooms.filter((r) => r.id !== res.room.id)];
      toast(`#${res.room.id} is ready (${VISIBILITY_LABELS[res.room.visibility].toLowerCase()}).`, 'success');
      this.events.onOpenChat(res.room.id);
    }));
  }

  private setVisibility(room: RoomSummary, visibility: RoomVisibility): void {
    if (!this.socket.connected) {
      toast(NOT_CONNECTED, 'error');
      return;
    }
    this.socket.emit('rooms:set-visibility', { roomId: room.id, visibility }, withTimeout((res) => {
      if (!res.ok) toast(res.error, 'error');
      else toast(`#${room.id} is now ${VISIBILITY_LABELS[visibility].toLowerCase()}.`, 'success');
    }));
  }

  private render(): void {
    if (this.rooms.length === 0) {
      this.listEl.replaceChildren(
        el('li', { className: 'empty-state', text: 'No rooms to show yet. Create one, or join a room by its ID in Chat.' }),
      );
      return;
    }
    this.listEl.replaceChildren(...this.rooms.map((room) => this.renderRoom(room)));
  }

  private renderRoom(room: RoomSummary): HTMLLIElement {
    const mine = this.isMine(room);
    const parts: string[] = [];
    parts.push(room.online.length ? `${room.online.length} online` : 'Nobody here now');
    if (room.inCall) parts.push(`${room.inCall} in call`);
    parts.push(mine ? 'yours' : `by ${room.owner}`);

    const icon = el('span', { className: 'avatar room-avatar', text: '#' });
    icon.style.setProperty('--h', String(hueFor(room.id)));

    const name = el('span', { className: 'user-name room-name', text: `#${room.id}` });
    if (room.visibility !== 'public') {
      const badge = el('span', { className: `room-lock ${room.visibility}`, title: VISIBILITY_LABELS[room.visibility] });
      badge.innerHTML = room.visibility === 'link' ? LINK_SVG : LOCK_SVG; // static markup
      name.append(badge);
    }

    const chat = this.button('Chat', 'btn-secondary', `Open the chat of #${room.id}`, () => this.events.onOpenChat(room.id));
    const call = this.button(room.inCall ? 'Join call' : 'Call', 'btn-primary', `Join the call in #${room.id}`, () =>
      this.events.onJoinCall(room.id),
    );
    const share = this.button('Share', 'btn-ghost', `Share #${room.id} with friends or copy its link`, () =>
      this.events.onShare(room.id),
    );
    const actions: HTMLElement[] = [share, chat, call];
    if (mine) {
      const next = NEXT_VISIBILITY[room.visibility];
      const toggle = this.button(
        VISIBILITY_LABELS[room.visibility],
        'btn-ghost visibility-toggle',
        `${VISIBILITY_TITLES[room.visibility]}. Tap to make it ${VISIBILITY_LABELS[next].toLowerCase()}.`,
        () => this.setVisibility(room, next),
      );
      toggle.dataset.visibility = room.visibility;
      actions.unshift(toggle);
    }

    const item = el('li', { className: `user-item person-row room-row ${room.visibility}` }, [
      icon,
      el('span', { className: 'user-meta' }, [name, el('span', { className: 'user-presence', text: parts.join(' · ') })]),
      el('span', { className: 'row-actions' }, actions),
    ]);
    if (room.online.length) item.title = `In #${room.id}: ${room.online.join(', ')}`;
    return item;
  }

  private button(text: string, variant: string, title: string, onClick: () => void): HTMLButtonElement {
    const button = el('button', { className: `btn btn-small ${variant}`, text, title });
    button.type = 'button';
    button.addEventListener('click', onClick);
    return button;
  }
}
