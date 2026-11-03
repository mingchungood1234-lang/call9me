import type { ChatMessage } from '../../shared/types';
import { isValidRoomId, MAX_MESSAGE_LENGTH, ROOM_ID_RULES } from '../../shared/validation';
import { $, autoFocus, el, formatTime, toast } from './dom';
import { renderRichText, type CustomEmojiStore } from './emoji';
import { EmojiPicker } from './EmojiPicker';
import { NOT_CONNECTED, withTimeout, type AppSocket } from './socket';

const LAST_ROOM_KEY = 'call9me:lastRoom';

/** Public chat room UI: join a room by ID, see members, send/receive messages. */
export class ChatPanel {
  private currentRoom: string | null = null;

  private readonly joinForm = $<HTMLFormElement>('#room-form');
  private readonly roomInput = $<HTMLInputElement>('#room-id');
  private readonly leaveBtn = $<HTMLButtonElement>('#leave-room-btn');
  /** Opening the share dialog is up to the app (see app.ts); this only shows it while in a room. */
  private readonly shareBtn = $<HTMLButtonElement>('#share-room-btn');
  private readonly roomTitle = $<HTMLElement>('#room-title');
  private readonly membersEl = $<HTMLElement>('#room-members');
  private readonly messagesEl = $<HTMLElement>('#messages');
  private readonly messageForm = $<HTMLFormElement>('#message-form');
  private readonly messageInput = $<HTMLInputElement>('#message-input');

  constructor(
    private readonly socket: AppSocket,
    private readonly userId: string,
    private readonly emoji: CustomEmojiStore,
    /** Called for messages from other people in the current room (for unread badges). */
    private readonly onIncomingMessage: (message: ChatMessage) => void = () => {},
  ) {
    this.messageInput.maxLength = MAX_MESSAGE_LENGTH;
    new EmojiPicker(socket, userId, emoji, this.messageInput, $<HTMLButtonElement>('#emoji-btn'), this.messageForm);
    // A newly added custom emoji may already be used in messages on screen.
    emoji.onChange(() => {
      for (const node of this.messagesEl.querySelectorAll<HTMLElement>('.msg-text[data-raw]')) {
        renderRichText(node, node.dataset.raw ?? '', this.emoji);
      }
    });
    this.joinForm.addEventListener('submit', (e) => {
      e.preventDefault();
      this.join(this.roomInput.value.trim());
    });
    this.leaveBtn.addEventListener('click', () => this.leave());
    this.messageForm.addEventListener('submit', (e) => {
      e.preventDefault();
      this.send();
    });

    socket.on('chat:message', (message) => {
      if (message.roomId !== this.currentRoom) return;
      this.appendMessage(message);
      if (!message.system && message.from !== this.userId) this.onIncomingMessage(message);
    });
    socket.on('chat:members', ({ roomId, members }) => {
      if (roomId === this.currentRoom) this.renderMembers(members);
    });

    this.render();
  }

  get room(): string | null {
    return this.currentRoom;
  }

  /** When the app is reopened, go back to the room the user was in (they still get its notifications). */
  restoreLastRoom(): void {
    if (this.currentRoom) return;
    let last: string | null = null;
    try {
      last = localStorage.getItem(LAST_ROOM_KEY);
    } catch {
      return;
    }
    if (last && isValidRoomId(last)) this.join(last, true);
  }

  private rememberRoom(roomId: string | null): void {
    try {
      if (roomId) localStorage.setItem(LAST_ROOM_KEY, roomId);
      else localStorage.removeItem(LAST_ROOM_KEY);
    } catch {
      // Not remembered (private mode); the room still works for this visit.
    }
  }

  /** Re-join the active room after a reconnect (server state was lost). */
  rejoin(): void {
    if (this.currentRoom) this.join(this.currentRoom, true);
  }

  /** `key`: the invite key from a link (needed the first time for invite-only rooms). */
  join(roomId: string, silent = false, key?: string): void {
    if (!isValidRoomId(roomId)) {
      toast(`Invalid room ID. ${ROOM_ID_RULES}`, 'error');
      return;
    }
    const previous = this.currentRoom;
    if (previous === roomId.toLowerCase() && !silent) return;
    if (!this.socket.connected) {
      // The current room is rejoined automatically once the connection is back (see `rejoin`).
      if (!silent) toast(NOT_CONNECTED, 'error');
      return;
    }
    if (previous && previous !== roomId.toLowerCase()) this.socket.emit('chat:leave', { roomId: previous });

    this.socket.emit('chat:join', { roomId, key }, withTimeout((res) => {
      if (!res.ok) {
        if (!silent) toast(res.error, 'error');
        return;
      }
      this.currentRoom = res.roomId;
      this.roomInput.value = res.roomId;
      this.rememberRoom(res.roomId);
      this.messagesEl.replaceChildren();
      res.history.forEach((m) => this.appendMessage(m));
      this.renderMembers(res.members);
      this.render();
      if (!silent) autoFocus(this.messageInput); // not on phones: it would pop the keyboard up
    }));
  }

  leave(): void {
    if (!this.currentRoom) return;
    this.socket.emit('chat:leave', { roomId: this.currentRoom });
    this.currentRoom = null;
    this.rememberRoom(null);
    this.messagesEl.replaceChildren();
    this.membersEl.replaceChildren();
    this.render();
  }

  private send(): void {
    const text = this.messageInput.value.trim();
    if (!text || !this.currentRoom) return;
    if (!this.socket.connected) {
      toast(NOT_CONNECTED, 'error');
      return;
    }
    this.socket.emit('chat:message', { roomId: this.currentRoom, text }, withTimeout((res) => {
      if (res.ok) return;
      toast(res.error, 'error');
      // Give the unsent text back so it isn't lost (unless they've started typing again).
      if (!this.messageInput.value) this.messageInput.value = text;
    }));
    this.messageInput.value = '';
  }

  private render(): void {
    const joined = this.currentRoom !== null;
    this.roomTitle.textContent = joined ? `#${this.currentRoom}` : 'Not in a room';
    this.leaveBtn.hidden = !joined;
    this.shareBtn.hidden = !joined;
    this.messageInput.disabled = !joined;
    this.messageForm.querySelector('button')!.disabled = !joined;
    this.messageInput.placeholder = joined ? `Message #${this.currentRoom}` : 'Join a room to chat';
    if (!joined) {
      this.messagesEl.replaceChildren(
        el('p', { className: 'empty-state', text: 'Enter a room ID above. Anyone with the same ID joins the same room.' }),
      );
    }
  }

  private renderMembers(members: string[]): void {
    this.membersEl.replaceChildren(
      el('span', { className: 'members-label', text: `${members.length} online:` }),
      ...members.map((m) => el('span', { className: m === this.userId ? 'chip chip-self' : 'chip', text: m })),
    );
  }

  /** Message body with emoji pictures for `:name:` (kept as `data-raw` to re-render when emoji change). */
  private messageText(text: string): HTMLElement {
    const node = el('div', { className: 'msg-text' });
    node.dataset.raw = text;
    renderRichText(node, text, this.emoji);
    return node;
  }

  private appendMessage(message: ChatMessage): void {
    const atBottom =
      this.messagesEl.scrollHeight - this.messagesEl.scrollTop - this.messagesEl.clientHeight < 40;

    if (message.system) {
      this.messagesEl.append(el('p', { className: 'msg-system', text: message.text }));
    } else {
      const mine = message.from === this.userId;
      this.messagesEl.append(
        el('div', { className: mine ? 'msg msg-mine' : 'msg' }, [
          el('div', { className: 'msg-meta' }, [
            el('span', { className: 'msg-author', text: mine ? 'You' : message.from }),
            el('time', { text: formatTime(message.timestamp) }),
          ]),
          this.messageText(message.text),
        ]),
      );
    }
    if (atBottom || message.from === this.userId) this.messagesEl.scrollTop = this.messagesEl.scrollHeight;
  }
}
