import type { ChatMessage, ChatRoomPreview } from '../../shared/types';
import { isValidRoomId, MAX_MESSAGE_LENGTH, PUBLIC_ROOM_ID, ROOM_ID_RULES } from '../../shared/validation';
import { $, autoFocus, avatar, el, formatTime, hueFor, toast } from './dom';
import { renderRichText, type CustomEmojiStore } from './emoji';
import { EmojiPicker } from './EmojiPicker';
import { MentionAutocomplete } from './MentionAutocomplete';
import { NOT_CONNECTED, withTimeout, type AppSocket } from './socket';

/** How a room is named in the list and header. */
export function roomTitle(roomId: string): string {
  return roomId === PUBLIC_ROOM_ID ? '📢 Public chat' : `#${roomId}`;
}

/** "14:05" today, else a short date. */
function listTime(timestamp: number): string {
  const date = new Date(timestamp);
  return date.toDateString() === new Date().toDateString()
    ? formatTime(timestamp)
    : date.toLocaleDateString([], { month: 'short', day: 'numeric' });
}

/**
 * Chats: the list of rooms we've joined (the Public chat pinned first), each with its last
 * message and unread count, kept live; tapping one opens its conversation (← goes back).
 */
export class ChatPanel {
  /** The room whose conversation is open (null while the list is shown). */
  private currentRoom: string | null = null;
  private readonly inbox = new Map<string, ChatRoomPreview>();
  private readonly isAdmin = document.body.hasAttribute('data-admin');

  private readonly listView = $<HTMLElement>('#chat-list-view');
  private readonly roomView = $<HTMLElement>('#chat-room-view');
  private readonly listEl = $<HTMLUListElement>('#chat-list');
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
  private readonly readonlyNote = $<HTMLElement>('#chat-readonly');

  /** Asked before leaving (e.g. to warn that an invite-only room needs its link again). */
  beforeLeave: (roomId: string) => boolean = () => true;
  /** More people to suggest after `@` (besides this room's members). */
  mentionCandidates: () => string[] = () => [];
  /** Whether the open conversation is actually on screen (then new messages count as read). */
  isOnScreen: () => boolean = () => document.visibilityState === 'visible';
  private roomMembers: string[] = [];

  constructor(
    private readonly socket: AppSocket,
    private readonly userId: string,
    private readonly emoji: CustomEmojiStore,
    /** Total unread messages across all rooms (for the Chat tab badge). */
    private readonly onUnreadChange: (total: number) => void = () => {},
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
    $('#chat-back-btn').addEventListener('click', () => this.back());
    this.messageForm.addEventListener('submit', (e) => {
      e.preventDefault();
      this.send();
    });

    socket.on('chat:rooms', (rooms) => {
      this.inbox.clear();
      for (const room of rooms) this.inbox.set(room.id, room);
      this.renderList();
    });
    socket.on('chat:message', (message) => this.onMessage(message));
    socket.on('chat:members', ({ roomId, members }) => {
      if (roomId === this.currentRoom) this.renderMembers(members);
    });
    socket.on('chat:deleted', ({ roomId, by }) => {
      this.inbox.delete(roomId);
      if (roomId === this.currentRoom) this.showList();
      this.renderList();
      toast(by === this.userId ? `#${roomId} was deleted.` : `#${roomId} was deleted by ${by}.`);
    });

    this.renderList();
    this.showList();
  }

  /** The open conversation's room, if any. */
  get room(): string | null {
    return this.currentRoom;
  }

  /** After a reconnect the server forgot what we were viewing: open it again. */
  rejoin(): void {
    if (this.currentRoom) this.join(this.currentRoom, true);
  }

  /**
   * Opens a room's conversation, joining the room first if it isn't in our list.
   * `key`: the invite key from a link (needed the first time for invite-only rooms).
   */
  join(roomId: string, silent = false, key?: string): void {
    if (!isValidRoomId(roomId)) {
      toast(`Invalid room ID. ${ROOM_ID_RULES}`, 'error');
      return;
    }
    const id = roomId.toLowerCase();
    if (!this.socket.connected) {
      // An open room is reopened automatically once the connection is back (see `rejoin`).
      if (!silent) toast(NOT_CONNECTED, 'error');
      return;
    }
    const previous = this.currentRoom;
    if (previous && previous !== id) this.socket.emit('chat:close', { roomId: previous });

    this.socket.emit('chat:join', { roomId, key }, withTimeout((res) => {
      if (!res.ok) {
        if (!silent) toast(res.error, 'error');
        return;
      }
      this.currentRoom = res.roomId;
      this.roomInput.value = '';
      const entry = this.inbox.get(res.roomId) ?? { id: res.roomId, unread: 0 };
      entry.unread = 0;
      entry.lastMessage = [...res.history].reverse().find((m) => !m.system) ?? entry.lastMessage;
      this.inbox.set(res.roomId, entry);
      this.messagesEl.replaceChildren();
      res.history.forEach((m) => this.appendMessage(m));
      this.messagesEl.scrollTop = this.messagesEl.scrollHeight;
      this.renderMembers(res.members);
      this.showRoom();
      this.renderList();
      if (!silent) autoFocus(this.messageInput); // not on phones: it would pop the keyboard up
    }));
  }

  /** The open conversation is (back) on screen: everything in it counts as read. */
  markRead(): void {
    const entry = this.currentRoom ? this.inbox.get(this.currentRoom) : undefined;
    if (!entry || !this.isOnScreen()) return;
    if (entry.unread) {
      entry.unread = 0;
      this.renderList();
    }
    this.socket.emit('chat:read', { roomId: entry.id });
  }

  /**
   * Leaves a room for good (default: the open one): off our list, no more notifications,
   * membership gone, so it drops off the Rooms list too unless it's public.
   */
  leave(roomId = this.currentRoom): void {
    if (!roomId || roomId === PUBLIC_ROOM_ID || !this.beforeLeave(roomId)) return;
    if (!this.socket.connected) {
      toast(NOT_CONNECTED, 'error');
      return;
    }
    this.socket.emit('rooms:leave', { roomId }, withTimeout((res) => {
      if (!res.ok) toast(res.error, 'error');
      else toast(`You left #${roomId}.`);
    }));
    this.inbox.delete(roomId);
    if (roomId === this.currentRoom) this.showList();
    this.renderList();
  }

  // ---- List ----

  private back(): void {
    if (this.currentRoom) this.socket.emit('chat:close', { roomId: this.currentRoom });
    this.showList();
  }

  private showList(): void {
    this.currentRoom = null;
    this.roomMembers = [];
    this.listView.hidden = false;
    this.roomView.hidden = true;
    this.messagesEl.replaceChildren();
    this.membersEl.replaceChildren();
  }

  private showRoom(): void {
    const room = this.currentRoom;
    if (!room) return;
    const isPublic = room === PUBLIC_ROOM_ID;
    const canPost = !isPublic || this.isAdmin;
    this.listView.hidden = true;
    this.roomView.hidden = false;
    this.roomTitle.textContent = roomTitle(room);
    this.leaveBtn.hidden = isPublic;
    this.shareBtn.hidden = isPublic;
    this.messageForm.hidden = !canPost;
    this.readonlyNote.hidden = canPost;
    this.messageInput.disabled = this.sendBtn.disabled = !canPost;
    this.messageInput.placeholder = isPublic ? 'Post an announcement to everyone' : `Message #${room}`;
  }

  private onMessage(message: ChatMessage): void {
    const entry = this.inbox.get(message.roomId) ?? { id: message.roomId, unread: 0 };
    this.inbox.set(message.roomId, entry);
    if (!message.system || !entry.lastMessage) entry.lastMessage = message;
    const fromOthers = !message.system && message.from !== this.userId;

    if (message.roomId === this.currentRoom) {
      this.appendMessage(message);
      if (fromOthers && !this.isOnScreen()) entry.unread++;
      else if (fromOthers) this.socket.emit('chat:read', { roomId: message.roomId });
    } else if (fromOthers) {
      entry.unread++;
    }
    this.renderList();
  }

  private renderList(): void {
    const rooms = [...this.inbox.values()].sort((a, b) => {
      if (a.id === PUBLIC_ROOM_ID) return -1;
      if (b.id === PUBLIC_ROOM_ID) return 1;
      return (b.lastMessage?.timestamp ?? 0) - (a.lastMessage?.timestamp ?? 0);
    });
    const total = rooms.reduce((sum, r) => sum + r.unread, 0);
    this.onUnreadChange(total);

    const items = rooms.map((room) => this.renderListItem(room));
    if (rooms.length <= 1) {
      items.push(el('li', { className: 'empty-state', text: 'Join a room above, or open one from People → Rooms. Your rooms show up here.' }));
    }
    this.listEl.replaceChildren(...items);
  }

  private renderListItem(room: ChatRoomPreview): HTMLLIElement {
    const isPublic = room.id === PUBLIC_ROOM_ID;
    const icon = isPublic ? el('span', { className: 'avatar room-avatar chat-public-icon', text: '📢' }) : el('span', { className: 'avatar room-avatar', text: '#' });
    if (!isPublic) icon.style.setProperty('--h', String(hueFor(room.id)));

    const last = room.lastMessage;
    let preview = isPublic ? 'Announcements for everyone' : 'No messages yet';
    if (last) {
      const body = last.sticker ? 'Sticker' : last.text;
      preview = last.system ? body : `${last.from === this.userId ? 'You' : last.from}: ${body}`;
    }

    const item = el('li', { className: `chat-item${room.unread ? ' has-unread' : ''}${isPublic ? ' is-public' : ''}` }, [
      icon,
      el('span', { className: 'chat-item-main' }, [
        el('span', { className: 'chat-item-top' }, [
          el('span', { className: 'user-name', text: roomTitle(room.id) }),
          el('time', { className: 'chat-item-time', text: last ? listTime(last.timestamp) : '' }),
        ]),
        el('span', { className: 'chat-item-bottom' }, [
          el('span', { className: 'chat-item-preview', text: preview }),
          ...(room.unread ? [el('span', { className: 'chat-unread', text: room.unread > 99 ? '99+' : String(room.unread) })] : []),
        ]),
      ]),
    ]);
    item.tabIndex = 0;
    item.setAttribute('role', 'button');
    item.setAttribute('aria-label', `${roomTitle(room.id)}${room.unread ? `, ${room.unread} unread` : ''}`);
    item.addEventListener('click', () => this.join(room.id));
    item.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        this.join(room.id);
      }
    });
    return item;
  }

  // ---- Conversation ----

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

  private renderMembers(members: string[]): void {
    this.roomMembers = members;
    this.membersEl.replaceChildren(
      el('span', { className: 'members-label', text: `${members.length} here now:` }),
      ...members.map((m) => {
        const chip = el('span', { className: m === this.userId ? 'chip chip-self' : 'chip' }, [avatar(m), document.createTextNode(m)]);
        return chip;
      }),
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
    const atBottom = this.messagesEl.scrollHeight - this.messagesEl.scrollTop - this.messagesEl.clientHeight < 40;

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
