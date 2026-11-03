import type { ChatMessage } from '../../shared/types';
import { isValidRoomId, MAX_MESSAGE_LENGTH, ROOM_ID_RULES } from '../../shared/validation';
import { $, autoFocus, el, formatTime, toast } from './dom';
import { renderRichText, type CustomEmojiStore } from './emoji';
import { EmojiPicker } from './EmojiPicker';
import { MentionAutocomplete } from './MentionAutocomplete';
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
  private readonly sendBtn = $<HTMLButtonElement>('#send-btn');

  constructor(
    private readonly socket: AppSocket,
    private readonly userId: string,
    private readonly emoji: CustomEmojiStore,
    /** Called for messages from other people in the current room (for unread badges). */
    private readonly onIncomingMessage: (message: ChatMessage) => void = () => {},
  ) {
    this.messageInput.maxLength = MAX_MESSAGE_LENGTH;
    new EmojiPicker(socket, userId, emoji, this.messageInput, $<HTMLButtonElement>('#emoji-btn'), this.messageForm, (id) =>
      this.sendSticker(id),
    );
    // `@` suggestions: people in this room first, then whoever the app adds (friends, online).
    new MentionAutocomplete(this.messageInput, this.messageForm, () => [...this.roomMembers, ...this.mentionCandidates()], userId);
    // A newly added custom emoji may already be used in messages on screen.
    emoji.onChange(() => {
      for (const node of this.messagesEl.querySelectorAll<HTMLElement>('.msg-text[data-raw]')) {
        renderRichText(node, node.dataset.raw ?? '', this.emoji, this.userId);
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
    socket.on('chat:deleted', ({ roomId, by }) => {
      if (roomId !== this.currentRoom) return;
      // The server already took us out of the room; just reset the panel.
      this.currentRoom = null;
      this.rememberRoom(null);
      this.messagesEl.replaceChildren();
      this.membersEl.replaceChildren();
      this.render();
      toast(by === this.userId ? `#${roomId} was deleted.` : `#${roomId} was deleted by ${by}.`);
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

  /** Asked before leaving (e.g. to warn that an invite-only room needs its link again). */
  beforeLeave: (roomId: string) => boolean = () => true;
  /** More people to suggest after `@` (besides this room's members). */
  mentionCandidates: () => string[] = () => [];
  private roomMembers: string[] = [];

  /**
   * Leaves a room for good (default: the open one): its chat, its notifications and our
   * membership, so it drops off our Rooms list unless it's public.
   */
  leave(roomId = this.currentRoom): void {
    if (!roomId || !this.beforeLeave(roomId)) return;
    if (!this.socket.connected) {
      toast(NOT_CONNECTED, 'error');
      return;
    }
    this.socket.emit('rooms:leave', { roomId }, withTimeout((res) => {
      if (!res.ok) toast(res.error, 'error');
      else toast(`You left #${roomId}.`);
    }));
    if (roomId !== this.currentRoom) return;
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
    this.sendBtn.disabled = !joined;
    this.messageInput.placeholder = joined ? `Message #${this.currentRoom}` : 'Join a room to chat';
    if (!joined) {
      this.messagesEl.replaceChildren(
        el('p', { className: 'empty-state', text: 'Enter a room ID above. Anyone with the same ID joins the same room.' }),
      );
    }
  }

  private renderMembers(members: string[]): void {
    this.roomMembers = members;
    this.membersEl.replaceChildren(
      el('span', { className: 'members-label', text: `${members.length} online:` }),
      ...members.map((m) => el('span', { className: m === this.userId ? 'chip chip-self' : 'chip', text: m })),
    );
  }

  /** Message body with emoji pictures for `:name:` (kept as `data-raw` to re-render when emoji change). */
  private messageText(text: string): HTMLElement {
    const node = el('div', { className: 'msg-text' });
    node.dataset.raw = text;
    // Messages that tag us stand out (the whole bubble, see .msg-mentions-me).
    if (renderRichText(node, text, this.emoji, this.userId)) node.classList.add('msg-mentions-me');
    return node;
  }

  /** A sticker message; if its owner removed it since, say so instead of a broken picture. */
  private stickerImage(url: string): HTMLElement {
    const img = el('img', { className: 'msg-sticker' });
    img.src = url;
    img.alt = 'Sticker';
    img.loading = 'lazy';
    img.addEventListener('error', () => img.replaceWith(el('div', { className: 'msg-text msg-sticker-gone', text: 'Sticker removed' })), {
      once: true,
    });
    return img;
  }

  private sendSticker(stickerId: string): void {
    if (!this.currentRoom) return;
    if (!this.socket.connected) {
      toast(NOT_CONNECTED, 'error');
      return;
    }
    this.socket.emit('chat:sticker', { roomId: this.currentRoom, stickerId }, withTimeout((res) => {
      if (!res.ok) toast(res.error, 'error');
    }));
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
          message.sticker ? this.stickerImage(message.sticker) : this.messageText(message.text),
        ]),
      );
    }
    if (atBottom || message.from === this.userId) this.messagesEl.scrollTop = this.messagesEl.scrollHeight;
  }
}
