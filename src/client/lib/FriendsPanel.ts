import type { FriendRequest, FriendsState, Presence } from '../../shared/types';
import { isValidUserId, MAX_REQUEST_MESSAGE_LENGTH, USER_ID_RULES } from '../../shared/validation';
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
  /** Open the direct-message chat with a friend. */
  onMessage(id: string): void;
  /** Friends or requests changed (badges, the online list's "Add friend" buttons). */
  onChange(state: FriendsState): void;
}

/**
 * Friends: send requests (with a message the other person reads before accepting), answer
 * them, message, call or remove friends, and optionally auto-block incoming requests.
 */
export class FriendsPanel {
  private state: FriendsState = { friends: [], incoming: [], outgoing: [], blockRequests: false };

  private readonly form = $<HTMLFormElement>('#friend-form');
  private readonly input = $<HTMLInputElement>('#friend-id');
  private readonly listEl = $<HTMLUListElement>('#friends-list');
  private readonly blockToggle = $<HTMLInputElement>('#block-requests');
  /** "Add friend": write the message that goes with the request. */
  private readonly requestDialog: HTMLDialogElement;
  private readonly requestTitle = el('h3', { className: 'share-title' });
  private readonly requestText = el('textarea', { className: 'request-message' });
  private readonly requestCount = el('small', { className: 'request-count' });
  private readonly requestSend = el('button', { className: 'btn btn-primary', text: 'Send request' });
  private requestTo = '';

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
    socket.on('friends:requested', ({ from, message }) => {
      const note = message.length > 80 ? `${message.slice(0, 77)}…` : message;
      toast(`${from} sent you a friend request: “${note}”`, 'info', 8000);
    });
    this.form.addEventListener('submit', (e) => {
      e.preventDefault();
      this.request(this.input.value.trim());
    });
    this.blockToggle.addEventListener('change', () => this.setBlock(this.blockToggle.checked));

    // The request dialog
    this.requestText.maxLength = MAX_REQUEST_MESSAGE_LENGTH;
    this.requestText.rows = 4;
    this.requestText.required = true;
    this.requestText.setAttribute('aria-label', 'Message to go with your friend request');
    const updateCount = () => {
      this.requestCount.textContent = `${MAX_REQUEST_MESSAGE_LENGTH - this.requestText.value.length} characters left`;
      this.requestSend.disabled = !this.requestText.value.trim();
    };
    this.requestText.addEventListener('input', updateCount);
    const cancel = el('button', { className: 'btn btn-ghost', text: 'Cancel' });
    cancel.type = 'button';
    cancel.addEventListener('click', () => this.requestDialog.close());
    this.requestSend.type = 'submit';
    const form = el('form', { className: 'request-form' }, [
      this.requestTitle,
      el('p', {
        className: 'settings-hint',
        text: 'Say who you are or why you want to connect. They read it before deciding, and once they accept, it opens your chat.',
      }),
      this.requestText,
      this.requestCount,
      el('div', { className: 'dialog-actions' }, [cancel, this.requestSend]),
    ]);
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      this.sendRequest();
    });
    this.requestDialog = el('dialog', { className: 'share-dialog request-dialog' }, [form]);
    this.requestDialog.addEventListener('click', (e) => {
      if (e.target === this.requestDialog) this.requestDialog.close();
    });
    this.requestDialog.addEventListener('close', updateCount);
    document.body.append(this.requestDialog);
    updateCount();
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
    return [...this.state.incoming, ...this.state.outgoing].some((r) => r.id.toLowerCase() === key);
  }

  /** "Add friend": asks for the message to send with the request first. */
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
    if (this.isFriend(id)) {
      toast(`${id} is already your friend.`);
      return;
    }
    const theirs = this.state.incoming.find((r) => r.id.toLowerCase() === id.toLowerCase());
    this.requestTo = id;
    this.requestTitle.textContent = theirs ? `${theirs.id} already asked you: reply to accept` : `Friend request to ${id}`;
    this.requestText.placeholder = theirs ? `Hi ${theirs.id}!` : `Hi ${id}, this is ${this.selfId} from…`;
    this.requestDialog.showModal();
    this.requestText.focus();
  }

  /** Re-renders presence (call when the online list changes). */
  render(): void {
    const { friends, incoming, outgoing } = this.state;
    this.blockToggle.checked = this.state.blockRequests;
    const items: HTMLElement[] = [];

    if (incoming.length) items.push(this.heading(`Requests (${incoming.length})`));
    for (const r of incoming) {
      items.push(
        this.row(r.id, 'Wants to be your friend', [
          this.button('Accept', 'btn-primary', `Accept ${r.id}`, () => this.respond(r.id, true)),
          this.button('Decline', 'btn-ghost', `Decline ${r.id}`, () => this.respond(r.id, false)),
        ], 'friend-request', r),
      );
    }

    // Online friends first; within each group, alphabetical (as the server sends them).
    const online = friends.filter((id) => this.isOnline(this.events.presenceOf(id)));
    const offline = friends.filter((id) => !online.includes(id));
    if (friends.length) items.push(this.heading(`Friends · ${online.length} online`));
    for (const id of [...online, ...offline]) {
      const presence = this.events.presenceOf(id);
      const message = this.button('Message', 'btn-secondary', `Message ${id}`, () => this.events.onMessage(id));
      const call = this.button('Call', 'btn-primary', `Call ${id}`, () => this.events.onCall(id));
      call.disabled = presence === 'busy' || presence === 'dnd' || presence === 'away';
      const remove = this.button('✕', 'btn-ghost icon-only', `Remove ${id} from friends`, () => this.remove(id));
      items.push(this.row(id, PRESENCE_LABELS[presence], [message, call, remove], presence));
    }

    if (outgoing.length) items.push(this.heading('Sent'));
    for (const r of outgoing) {
      items.push(
        this.row(r.id, 'Waiting for them to accept', [
          this.button('Cancel', 'btn-ghost', `Cancel the request to ${r.id}`, () => this.cancel(r.id)),
        ], 'friend-pending', r),
      );
    }

    if (items.length === 0) {
      items.push(el('li', { className: 'empty-state', text: 'No friends yet. Add someone by their ID with a short message — they need to accept.' }));
    }
    this.listEl.replaceChildren(...items);
  }

  private sendRequest(): void {
    const message = this.requestText.value.trim();
    if (!message || !this.requestTo || !this.emitChecked()) return;
    this.requestSend.disabled = true;
    this.socket.emit('friends:request', { to: this.requestTo, message }, withTimeout((res) => {
      this.requestSend.disabled = false;
      if (!res.ok) {
        toast(res.error, 'error');
        return;
      }
      this.requestDialog.close();
      this.requestText.value = '';
      this.input.value = '';
      toast(res.accepted ? `You and ${res.to} are now friends. Your chat is in Chats.` : `Friend request sent to ${res.to}.`, 'success');
    }));
  }

  private setBlock(block: boolean): void {
    if (!this.emitChecked()) {
      this.blockToggle.checked = !block;
      return;
    }
    this.socket.emit('friends:block-requests', { block }, withTimeout((res) => {
      if (!res.ok) {
        toast(res.error, 'error');
        this.blockToggle.checked = !block;
        return;
      }
      toast(
        block ? 'New friend requests are blocked. Requests already here still wait for your answer.' : 'People can send you friend requests again.',
        'success',
      );
    }));
  }

  private respond(from: string, accept: boolean): void {
    if (!this.emitChecked()) return;
    this.socket.emit('friends:respond', { from, accept }, withTimeout((res) => {
      if (!res.ok) toast(res.error, 'error');
      else if (accept) toast(`You and ${from} are now friends. Your chat is in Chats.`, 'success');
    }));
  }

  private cancel(to: string): void {
    if (!this.emitChecked()) return;
    this.socket.emit('friends:cancel', { to }, withTimeout((res) => {
      if (!res.ok) toast(res.error, 'error');
    }));
  }

  private remove(id: string): void {
    if (!window.confirm(`Remove ${id} from your friends? Your chat with ${id} closes too.`)) return;
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

  /** `request`: shows the note that came with a friend request. */
  private row(id: string, detail: string, actions: HTMLElement[], modifier: string, request?: FriendRequest): HTMLLIElement {
    const note = request?.message ? [el('span', { className: 'request-note', text: `“${request.message}”` })] : [];
    return el('li', { className: `user-item person-row ${modifier}` }, [
      avatar(id, [el('span', { className: 'presence-dot' })]),
      el('span', { className: 'user-meta' }, [
        el('span', { className: 'user-name', text: id }),
        el('span', { className: 'user-presence', text: detail }),
        ...note,
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
