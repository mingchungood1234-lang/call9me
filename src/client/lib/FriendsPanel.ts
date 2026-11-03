import type { FriendsState, Presence } from '../../shared/types';
import { isValidUserId, USER_ID_RULES } from '../../shared/validation';
import { $, avatar, el, toast } from './dom';
import { NOT_CONNECTED, withTimeout, type AppSocket } from './socket';

const PRESENCE_LABELS: Record<Presence | 'away', string> = {
  available: 'Online',
  busy: 'In a call',
  idle: 'Idle',
  dnd: 'Do not disturb',
  offline: 'Offline · rings their phone',
  away: 'Offline',
};

export interface FriendsPanelEvents {
  /** Current presence of a user (from the online list); "away" if they can't be reached. */
  presenceOf(id: string): Presence | 'away';
  onCall(id: string): void;
  /** Friends or requests changed (badges, the online list's "Add friend" buttons). */
  onChange(state: FriendsState): void;
}

/** Friends: send requests (the other person must accept), answer them, call or remove friends. */
export class FriendsPanel {
  private state: FriendsState = { friends: [], incoming: [], outgoing: [] };

  private readonly form = $<HTMLFormElement>('#friend-form');
  private readonly input = $<HTMLInputElement>('#friend-id');
  private readonly listEl = $<HTMLUListElement>('#friends-list');

  constructor(
    private readonly socket: AppSocket,
    private readonly selfId: string,
    private readonly events: FriendsPanelEvents,
  ) {
    socket.on('friends:update', (state) => {
      this.state = state;
      this.render();
      this.events.onChange(state);
    });
    socket.on('friends:requested', ({ from }) => toast(`${from} sent you a friend request.`, 'info', 6000));
    this.form.addEventListener('submit', (e) => {
      e.preventDefault();
      this.request(this.input.value.trim());
    });
    this.render();
  }

  get current(): FriendsState {
    return this.state;
  }

  isFriend(id: string): boolean {
    return this.state.friends.some((f) => f.toLowerCase() === id.toLowerCase());
  }

  /** We asked them, or they asked us. */
  isPending(id: string): boolean {
    const key = id.toLowerCase();
    return [...this.state.incoming, ...this.state.outgoing].some((f) => f.toLowerCase() === key);
  }

  request(id: string): void {
    if (!isValidUserId(id)) {
      toast(`Enter a valid user ID. ${USER_ID_RULES}`, 'error');
      this.input.focus();
      return;
    }
    if (id.toLowerCase() === this.selfId.toLowerCase()) {
      toast('You cannot add yourself.', 'error');
      return;
    }
    if (!this.emitChecked()) return;
    this.socket.emit('friends:request', { to: id }, withTimeout((res) => {
      if (!res.ok) {
        toast(res.error, 'error');
        return;
      }
      this.input.value = '';
      toast(res.accepted ? `You and ${res.to} are now friends.` : `Friend request sent to ${res.to}.`, 'success');
    }));
  }

  /** Re-renders presence (call when the online list changes). */
  render(): void {
    const { friends, incoming, outgoing } = this.state;
    const items: HTMLElement[] = [];

    if (incoming.length) items.push(this.heading(`Requests (${incoming.length})`));
    for (const id of incoming) {
      items.push(
        this.row(id, 'Wants to be your friend', [
          this.button('Accept', 'btn-primary', `Accept ${id}`, () => this.respond(id, true)),
          this.button('Decline', 'btn-ghost', `Decline ${id}`, () => this.respond(id, false)),
        ], 'friend-request'),
      );
    }

    // Online friends first; within each group, alphabetical (as the server sends them).
    const online = friends.filter((id) => this.isOnline(this.events.presenceOf(id)));
    const offline = friends.filter((id) => !online.includes(id));
    if (friends.length) items.push(this.heading(`Friends · ${online.length} online`));
    for (const id of [...online, ...offline]) {
      const presence = this.events.presenceOf(id);
      const call = this.button('Call', 'btn-primary', `Call ${id}`, () => this.events.onCall(id));
      call.disabled = presence === 'busy' || presence === 'dnd' || presence === 'away';
      const remove = this.button('✕', 'btn-ghost icon-only', `Remove ${id} from friends`, () => this.remove(id));
      items.push(this.row(id, PRESENCE_LABELS[presence], [call, remove], presence));
    }

    if (outgoing.length) items.push(this.heading('Sent'));
    for (const id of outgoing) {
      items.push(
        this.row(id, 'Waiting for them to accept', [
          this.button('Cancel', 'btn-ghost', `Cancel the request to ${id}`, () => this.cancel(id)),
        ], 'friend-pending'),
      );
    }

    if (items.length === 0) {
      items.push(el('li', { className: 'empty-state', text: 'No friends yet. Add someone by their ID — they need to accept.' }));
    }
    this.listEl.replaceChildren(...items);
  }

  private respond(from: string, accept: boolean): void {
    if (!this.emitChecked()) return;
    this.socket.emit('friends:respond', { from, accept }, withTimeout((res) => {
      if (!res.ok) toast(res.error, 'error');
      else if (accept) toast(`You and ${from} are now friends.`, 'success');
    }));
  }

  private cancel(to: string): void {
    if (!this.emitChecked()) return;
    this.socket.emit('friends:cancel', { to }, withTimeout((res) => {
      if (!res.ok) toast(res.error, 'error');
    }));
  }

  private remove(id: string): void {
    if (!window.confirm(`Remove ${id} from your friends?`)) return;
    if (!this.emitChecked()) return;
    this.socket.emit('friends:remove', { id }, withTimeout((res) => {
      if (!res.ok) toast(res.error, 'error');
    }));
  }

  private isOnline(presence: Presence | 'away'): boolean {
    return presence !== 'offline' && presence !== 'away';
  }

  private emitChecked(): boolean {
    if (this.socket.connected) return true;
    toast(NOT_CONNECTED, 'error');
    return false;
  }

  private heading(text: string): HTMLLIElement {
    return el('li', { className: 'list-heading', text });
  }

  private row(id: string, detail: string, actions: HTMLElement[], modifier: string): HTMLLIElement {
    return el('li', { className: `user-item person-row ${modifier}` }, [
      avatar(id, [el('span', { className: 'presence-dot' })]),
      el('span', { className: 'user-meta' }, [
        el('span', { className: 'user-name', text: id }),
        el('span', { className: 'user-presence', text: detail }),
      ]),
      el('span', { className: 'row-actions' }, actions),
    ]);
  }

  private button(text: string, variant: string, title: string, onClick: () => void): HTMLButtonElement {
    const button = el('button', { className: `btn btn-small ${variant}`, text, title });
    button.type = 'button';
    button.setAttribute('aria-label', title);
    button.addEventListener('click', onClick);
    return button;
  }
}
