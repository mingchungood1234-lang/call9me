import { avatar, el, toast } from './dom';
import { NOT_CONNECTED, withTimeout, type AppSocket } from './socket';

/** The owner's view of a room's people: remove or ban members, lift bans. */
export class RoomMembersDialog {
  private readonly dialog: HTMLDialogElement;
  private readonly title: HTMLElement;
  private readonly membersHeading: HTMLElement;
  private readonly membersList: HTMLUListElement;
  private readonly bannedHeading: HTMLElement;
  private readonly bannedList: HTMLUListElement;
  private roomId = '';

  constructor(private readonly socket: AppSocket) {
    this.title = el('h3', { className: 'share-title' });
    this.membersHeading = el('p', { className: 'share-section' });
    this.membersList = el('ul', { className: 'share-friends' });
    this.bannedHeading = el('p', { className: 'share-section' });
    this.bannedList = el('ul', { className: 'share-friends' });
    const closeBtn = el('button', { className: 'btn btn-ghost', text: 'Done' });
    closeBtn.type = 'button';
    closeBtn.addEventListener('click', () => this.dialog.close());

    this.dialog = el('dialog', { className: 'share-dialog' }, [
      this.title,
      el('p', { className: 'join-note', text: 'Removed people can join again if they can see the room. Banned people never can.' }),
      this.membersHeading,
      this.membersList,
      this.bannedHeading,
      this.bannedList,
      el('div', { className: 'dialog-actions' }, [closeBtn]),
    ]);
    this.dialog.addEventListener('click', (e) => {
      if (e.target === this.dialog) this.dialog.close(); // backdrop
    });
    document.body.append(this.dialog);
  }

  open(roomId: string): void {
    this.roomId = roomId;
    this.title.textContent = `People in #${roomId}`;
    this.refresh(true);
  }

  private refresh(show = false): void {
    if (!this.socket.connected) {
      toast(NOT_CONNECTED, 'error');
      return;
    }
    this.socket.emit('rooms:members', { roomId: this.roomId }, withTimeout((res) => {
      if (!res.ok) {
        toast(res.error, 'error');
        return;
      }
      this.render(res.members, res.banned);
      if (show && !this.dialog.open) this.dialog.showModal();
    }));
  }

  private render(members: string[], banned: string[]): void {
    this.membersHeading.textContent = `Members (${members.length})`;
    this.membersList.replaceChildren(
      ...(members.length
        ? members.map((id) =>
            this.row(id, [
              this.button('Remove', 'btn-ghost', `Take ${id} out of #${this.roomId}`, () => this.remove(id, false)),
              this.button('Ban', 'btn-ghost btn-delete', `Remove ${id} and keep them out of #${this.roomId}`, () =>
                this.remove(id, true),
              ),
            ]),
          )
        : [el('li', { className: 'empty-state', text: 'Nobody else has joined yet.' })]),
    );
    this.bannedHeading.hidden = this.bannedList.hidden = banned.length === 0;
    this.bannedHeading.textContent = `Banned (${banned.length})`;
    this.bannedList.replaceChildren(
      ...banned.map((id) => this.row(id, [this.button('Unban', 'btn-ghost', `Let ${id} join #${this.roomId} again`, () => this.unban(id))])),
    );
  }

  private remove(id: string, ban: boolean): void {
    const question = ban
      ? `Ban ${id} from #${this.roomId}? They're taken out and can't come back, not even with the link.`
      : `Remove ${id} from #${this.roomId}?`;
    if (!window.confirm(question)) return;
    this.socket.emit('rooms:remove-member', { roomId: this.roomId, userId: id, ban }, withTimeout((res) => {
      if (!res.ok) toast(res.error, 'error');
      else toast(`${id} was ${ban ? 'banned from' : 'removed from'} #${this.roomId}.`, 'success');
      this.refresh();
    }));
  }

  private unban(id: string): void {
    this.socket.emit('rooms:unban', { roomId: this.roomId, userId: id }, withTimeout((res) => {
      if (!res.ok) toast(res.error, 'error');
      else toast(`${id} can join #${this.roomId} again.`, 'success');
      this.refresh();
    }));
  }

  private row(id: string, actions: HTMLButtonElement[]): HTMLLIElement {
    return el('li', { className: 'user-item' }, [
      avatar(id),
      el('span', { className: 'user-name', text: id }),
      el('span', { className: 'row-actions' }, actions),
    ]);
  }

  private button(text: string, variant: string, title: string, onClick: () => void): HTMLButtonElement {
    const button = el('button', { className: `btn btn-small ${variant}`, text, title });
    button.type = 'button';
    button.addEventListener('click', onClick);
    return button;
  }
}
