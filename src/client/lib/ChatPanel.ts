import type { ChatMessage } from '../../shared/types';
import { isValidRoomId, MAX_MESSAGE_LENGTH, ROOM_ID_RULES } from '../../shared/validation';
import { $, el, formatTime, toast } from './dom';
import type { AppSocket } from './socket';

/** Public chat room UI: join a room by ID, see members, send/receive messages. */
export class ChatPanel {
  private currentRoom: string | null = null;

  private readonly joinForm = $<HTMLFormElement>('#room-form');
  private readonly roomInput = $<HTMLInputElement>('#room-id');
  private readonly leaveBtn = $<HTMLButtonElement>('#leave-room-btn');
  private readonly roomTitle = $<HTMLElement>('#room-title');
  private readonly membersEl = $<HTMLElement>('#room-members');
  private readonly messagesEl = $<HTMLElement>('#messages');
  private readonly messageForm = $<HTMLFormElement>('#message-form');
  private readonly messageInput = $<HTMLInputElement>('#message-input');

  constructor(
    private readonly socket: AppSocket,
    private readonly userId: string,
    /** Called for messages from other people in the current room (for unread badges). */
    private readonly onIncomingMessage: (message: ChatMessage) => void = () => {},
  ) {
    this.messageInput.maxLength = MAX_MESSAGE_LENGTH;
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

  /** Re-join the active room after a reconnect (server state was lost). */
  rejoin(): void {
    if (this.currentRoom) this.join(this.currentRoom, true);
  }

  join(roomId: string, silent = false): void {
    if (!isValidRoomId(roomId)) {
      toast(`Invalid room ID. ${ROOM_ID_RULES}`, 'error');
      return;
    }
    const previous = this.currentRoom;
    if (previous === roomId.toLowerCase() && !silent) return;
    if (previous && previous !== roomId.toLowerCase()) this.socket.emit('chat:leave', { roomId: previous });

    this.socket.emit('chat:join', { roomId }, (res) => {
      if (!res.ok) {
        toast(res.error, 'error');
        return;
      }
      this.currentRoom = res.roomId;
      this.roomInput.value = res.roomId;
      this.messagesEl.replaceChildren();
      res.history.forEach((m) => this.appendMessage(m));
      this.renderMembers(res.members);
      this.render();
      if (!silent) this.messageInput.focus();
    });
  }

  leave(): void {
    if (!this.currentRoom) return;
    this.socket.emit('chat:leave', { roomId: this.currentRoom });
    this.currentRoom = null;
    this.messagesEl.replaceChildren();
    this.membersEl.replaceChildren();
    this.render();
  }

  private send(): void {
    const text = this.messageInput.value.trim();
    if (!text || !this.currentRoom) return;
    this.socket.emit('chat:message', { roomId: this.currentRoom, text }, (res) => {
      if (!res.ok) toast(res.error, 'error');
    });
    this.messageInput.value = '';
  }

  private render(): void {
    const joined = this.currentRoom !== null;
    this.roomTitle.textContent = joined ? `#${this.currentRoom}` : 'Not in a room';
    this.leaveBtn.hidden = !joined;
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
          el('div', { className: 'msg-text', text: message.text }),
        ]),
      );
    }
    if (atBottom || message.from === this.userId) this.messagesEl.scrollTop = this.messagesEl.scrollHeight;
  }
}
