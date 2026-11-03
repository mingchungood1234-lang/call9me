import type { CallHistoryEntry } from '../../shared/types';
import { $, avatar, el, formatDuration, formatTime, toast } from './dom';
import { NOT_CONNECTED, withTimeout, type AppSocket } from './socket';

/** Only the most recent ones are shown (the server keeps more). */
const MAX_SHOWN = 50;

const ARROWS: Record<CallHistoryEntry['direction'], string> = { outgoing: '↗', incoming: '↙', room: '#' };

function outcomeLabel(entry: CallHistoryEntry): string {
  switch (entry.outcome) {
    case 'completed':
      return `${entry.video ? 'Video' : 'Voice'} · ${formatDuration(entry.durationMs)}`;
    case 'missed':
      return 'Missed';
    case 'declined':
      return 'Declined';
    case 'unanswered':
      return entry.direction === 'room' ? 'No one joined' : 'No answer';
    case 'cancelled':
      return 'Cancelled';
  }
}

/** "14:05" today, "Yesterday", or a short date. */
function formatWhen(timestamp: number): string {
  const date = new Date(timestamp);
  const today = new Date();
  const yesterday = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1);
  if (date.toDateString() === today.toDateString()) return formatTime(timestamp);
  if (date.toDateString() === yesterday.toDateString()) return 'Yesterday';
  return date.toLocaleDateString([], { month: 'short', day: 'numeric' });
}

/** "Recent calls": our call history from the server, kept live while the app is open. */
export class CallHistoryPanel {
  private entries: CallHistoryEntry[] = [];
  private loaded = false;

  private readonly listEl = $<HTMLUListElement>('#history-list');
  private readonly clearBtn = $<HTMLButtonElement>('#history-clear-btn');

  constructor(
    private readonly socket: AppSocket,
    /** "Call back": call the same person, or rejoin the same room. */
    private readonly onCallBack: (entry: CallHistoryEntry) => void,
  ) {
    socket.on('history:new', (entry) => {
      if (this.entries.some((e) => e.id === entry.id)) return;
      this.entries.unshift(entry);
      this.render();
    });
    this.clearBtn.addEventListener('click', () => this.clear());
    this.render();
  }

  /** (Re)loads the whole history, e.g. after (re)connecting — calls may have been missed meanwhile. */
  load(): void {
    this.socket.emit('history:list', withTimeout((res) => {
      if (!res.ok) {
        if (!this.loaded) this.render(res.error);
        return;
      }
      this.loaded = true;
      this.entries = res.entries;
      this.render();
    }));
  }

  private clear(): void {
    if (!this.socket.connected) {
      toast(NOT_CONNECTED, 'error');
      return;
    }
    if (!window.confirm('Clear your call history?')) return;
    this.socket.emit('history:clear', withTimeout((res) => {
      if (!res.ok) {
        toast(res.error, 'error');
        return;
      }
      this.entries = [];
      this.render();
    }));
  }

  private render(error?: string): void {
    this.clearBtn.hidden = this.entries.length === 0;
    if (this.entries.length === 0) {
      const text = error ?? (this.loaded ? 'No calls yet.' : 'Loading…');
      this.listEl.replaceChildren(el('li', { className: 'empty-state', text }));
      return;
    }
    this.listEl.replaceChildren(...this.entries.slice(0, MAX_SHOWN).map((entry) => this.renderEntry(entry)));
  }

  private renderEntry(entry: CallHistoryEntry): HTMLLIElement {
    const name = entry.roomId ? `#${entry.roomId}` : entry.peers.join(', ') || 'Unknown';
    const who = entry.roomId ? entry.roomId : entry.peers[0] ?? '?';
    const detail = `${outcomeLabel(entry)} · ${formatWhen(entry.startedAt)}`;

    const callBack = el('button', {
      className: 'btn btn-small btn-secondary history-call-btn',
      text: entry.roomId ? 'Join' : 'Call',
      title: entry.roomId ? `Join #${entry.roomId} again` : `Call ${entry.peers[0] ?? ''} back`,
    });
    callBack.type = 'button';
    callBack.disabled = !entry.roomId && entry.peers.length === 0;
    callBack.addEventListener('click', () => this.onCallBack(entry));

    const item = el('li', { className: `history-item outcome-${entry.outcome}` }, [
      avatar(who),
      el('span', { className: 'user-meta' }, [
        el('span', { className: 'user-name', text: name, title: name }),
        el('span', { className: 'history-detail' }, [
          el('span', { className: `history-arrow dir-${entry.direction}`, text: ARROWS[entry.direction] }),
          document.createTextNode(` ${detail}`),
        ]),
      ]),
      callBack,
    ]);
    item.title = new Date(entry.startedAt).toLocaleString();
    return item;
  }
}
