import type { AdminLogEntry, AdminOverview, AdminRoom, AdminUser } from '../shared/types';
import { isValidPin, PIN_RULES } from '../shared/validation';
import { $, el, formatDuration, toast } from './lib/dom';
import { bindThemeToggle } from './lib/theme';

bindThemeToggle($<HTMLButtonElement>('#theme-btn'));

type View = 'overview' | 'users' | 'rooms' | 'log';
type Result<T> = ({ ok: true } & T) | { ok: false; error: string; locked?: boolean };

const lockedView = $('#admin-locked');
const dash = $('#admin-dash');
const lockBtn = $<HTMLButtonElement>('#lock-btn');
const OVERVIEW_REFRESH_MS = 5000;
let view: View = 'overview';
let users: AdminUser[] = [];
let rooms: AdminRoom[] = [];
let refreshTimer: ReturnType<typeof setInterval> | undefined;

/** Every request carries the admin header (other sites can't add it). A locked dashboard shows the passcode form. */
async function api<T>(method: 'GET' | 'POST', url: string, body?: unknown): Promise<Result<T>> {
  try {
    const res = await fetch(url, {
      method,
      headers: { 'Content-Type': 'application/json', 'X-Call9me-Admin': '1' },
      body: body === undefined ? undefined : JSON.stringify(body),
      cache: 'no-store',
    });
    if (res.status === 404 && method === 'GET') return { ok: false, error: 'Not found' };
    const data = (await res.json()) as Result<T>;
    if (!data.ok && data.locked) showLocked();
    return data;
  } catch {
    return { ok: false, error: 'Could not reach the server.' };
  }
}

/** Runs an action; shows its message, then reloads the current view. */
async function act(url: string, body: unknown = {}): Promise<void> {
  const res = await api<{ message?: string }>('POST', url, body);
  if (!res.ok) {
    if (!res.locked) toast(res.error, 'error', 6000);
    return;
  }
  toast(res.message ?? 'Done.', 'success');
  void load(view);
}

function showLocked(): void {
  clearInterval(refreshTimer);
  dash.hidden = true;
  lockBtn.hidden = true;
  lockedView.hidden = false;
  document.querySelector<HTMLInputElement>('#unlock-passcode')?.focus();
}

function showDash(): void {
  lockedView.hidden = true;
  dash.hidden = false;
  lockBtn.hidden = false;
  showView(view);
}

document.querySelector<HTMLFormElement>('#unlock-form')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const input = $<HTMLInputElement>('#unlock-passcode');
  const res = await api('POST', '/api/admin/unlock', { passcode: input.value });
  input.value = '';
  if (!res.ok) {
    toast(res.error, 'error');
    input.focus();
    return;
  }
  showDash();
});
lockBtn.addEventListener('click', async () => {
  await api('POST', '/api/admin/lock');
  showLocked();
});

// ---- Views ----

const tabs = $('#admin-tabs');
function showView(next: View): void {
  view = next;
  for (const button of tabs.querySelectorAll<HTMLButtonElement>('button[data-view]')) {
    const selected = button.dataset.view === next;
    button.classList.toggle('active', selected);
    button.setAttribute('aria-selected', String(selected));
  }
  for (const section of document.querySelectorAll<HTMLElement>('section.admin-view')) section.hidden = section.dataset.view !== next;
  clearInterval(refreshTimer);
  if (next === 'overview') refreshTimer = setInterval(() => void load('overview'), OVERVIEW_REFRESH_MS);
  void load(next);
}
tabs.addEventListener('click', (e) => {
  const button = (e.target as HTMLElement).closest<HTMLButtonElement>('button[data-view]');
  if (button) showView(button.dataset.view as View);
});

async function load(which: View): Promise<void> {
  if (which === 'overview') {
    const res = await api<{ overview: AdminOverview }>('GET', '/api/admin/overview');
    if (res.ok) renderOverview(res.overview);
  } else if (which === 'users') {
    const res = await api<{ users: AdminUser[] }>('GET', '/api/admin/users');
    if (res.ok) {
      users = res.users;
      renderUsers();
    }
  } else if (which === 'rooms') {
    const res = await api<{ rooms: AdminRoom[] }>('GET', '/api/admin/rooms');
    if (res.ok) {
      rooms = res.rooms;
      renderRooms();
    }
  } else {
    const res = await api<{ entries: AdminLogEntry[] }>('GET', '/api/admin/log');
    if (res.ok) renderLog(res.entries);
  }
}

const date = (t: number) => new Date(t).toLocaleDateString([], { year: 'numeric', month: 'short', day: 'numeric' });
const dateTime = (t: number) => new Date(t).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });

function button(text: string, variant: string, onClick: () => void, title = ''): HTMLButtonElement {
  const b = el('button', { className: `btn btn-small ${variant}`, text, title });
  b.type = 'button';
  b.addEventListener('click', onClick);
  return b;
}
const tag = (text: string, kind = '') => el('span', { className: `admin-badge ${kind}`, text });

// ---- Edit dialogs ----

let mailOn = false;
const editDialog = el('dialog', { className: 'share-dialog admin-edit' });
editDialog.addEventListener('click', (e) => {
  if (e.target === editDialog) editDialog.close();
});
document.body.append(editDialog);

/** A labelled field for the edit dialog. */
function field(label: string, control: HTMLElement, hint = ''): HTMLElement {
  const id = `edit-${Math.random().toString(36).slice(2, 8)}`;
  control.id = id;
  const l = el('label', { text: label });
  l.htmlFor = id;
  return el('div', { className: 'admin-field' }, [l, control, ...(hint ? [el('small', { className: 'admin-muted', text: hint })] : [])]);
}

function select(options: [string, string][], value: string): HTMLSelectElement {
  const s = el('select');
  for (const [v, text] of options) {
    const o = el('option', { text });
    o.value = v;
    s.append(o);
  }
  s.value = value;
  return s;
}

/**
 * Opens the edit dialog. `save` gets called on "Save" and returns whether to close; `extra`
 * are buttons for one-off actions (they run on their own).
 */
function openEditor(title: string, fields: HTMLElement[], save: () => Promise<boolean>, extra: HTMLElement[] = []): void {
  const saveBtn = button('Save changes', 'btn-primary', async () => {
    saveBtn.disabled = true;
    try {
      if (await save()) editDialog.close();
    } finally {
      saveBtn.disabled = false;
    }
  });
  const cancel = button('Cancel', 'btn-ghost', () => editDialog.close());
  editDialog.replaceChildren(
    el('h3', { className: 'share-title', text: title }),
    el('div', { className: 'admin-fields' }, fields),
    ...(extra.length ? [el('div', { className: 'admin-edit-extra' }, extra)] : []),
    el('div', { className: 'admin-edit-actions' }, [cancel, saveBtn]),
  );
  editDialog.showModal();
}

/** POSTs one change; true if it worked (its message is shown either way). */
async function post(url: string, body: unknown = {}): Promise<boolean> {
  const res = await api<{ message?: string }>('POST', url, body);
  if (!res.ok) {
    if (!res.locked) toast(res.error, 'error', 6000);
    return false;
  }
  toast(res.message ?? 'Saved.', 'success');
  return true;
}

function editUser(u: AdminUser): void {
  const email = el('input');
  email.type = 'email';
  email.value = u.recoveryEmail ?? '';
  email.placeholder = u.googleEmail ? `(uses Google: ${u.googleEmail})` : 'none';
  const status = select(
    [['online', 'Online'], ['idle', 'Idle'], ['dnd', 'Do not disturb'], ['invisible', 'Invisible']],
    u.status,
  );
  const pin = el('input');
  pin.type = 'text';
  pin.inputMode = 'numeric';
  pin.maxLength = 4;
  pin.placeholder = 'leave empty to keep';
  pin.autocomplete = 'off';
  pin.addEventListener('input', () => (pin.value = pin.value.replace(/\D/g, '').slice(0, 4)));

  const extra: HTMLElement[] = [];
  if (mailOn) {
    extra.push(button('✉️ Email a reset link', 'btn-secondary', () => void post(`/api/admin/users/${u.id}/send-reset`),
      'Sends a one-time "choose a new PIN" link to their recovery email'));
  }
  openEditor(
    `Edit ${u.id}`,
    [
      field('Recovery email', email, 'Where "Forgot PIN?" sends reset links. Empty removes it.'),
      field('Status', status),
      field('New PIN', pin, 'Optional. They are signed out everywhere; tell them the new PIN yourself.'),
    ],
    async () => {
      if (pin.value && !isValidPin(pin.value)) {
        toast(PIN_RULES, 'error');
        pin.focus();
        return false;
      }
      const changed = email.value.trim() !== (u.recoveryEmail ?? '') || status.value !== u.status;
      let ok = true;
      if (changed) ok = await post(`/api/admin/users/${u.id}/update`, { recoveryEmail: email.value.trim(), status: status.value });
      if (ok && pin.value) ok = await post(`/api/admin/users/${u.id}/set-pin`, { pin: pin.value });
      if (!changed && !pin.value) toast('Nothing changed.');
      if (ok) void load('users');
      return ok;
    },
    extra,
  );
}

function editRoom(r: AdminRoom): void {
  const visibility = select([['public', 'Public: everyone can see and join'], ['private', "Private: owner's friends only"], ['link', 'Link only: by invite link']], r.visibility);
  const owner = el('input');
  owner.value = r.owner;
  owner.setAttribute('list', 'admin-user-ids');
  owner.autocomplete = 'off';
  const ids = el('datalist');
  ids.id = 'admin-user-ids';
  for (const u of users) {
    const o = el('option');
    o.value = u.id;
    ids.append(o);
  }
  const resetKey = button('🔗 New invite link', 'btn-secondary', () => {
    if (window.confirm(`Make a new invite link for #${r.id}? Links shared so far stop working.`)) {
      void post(`/api/admin/rooms/${r.id}/reset-key`);
    }
  });
  openEditor(
    `Edit #${r.id}`,
    [field('Who can see it', visibility), field('Owner', owner, 'Any account ID. The old owner stays in the room as a member.'), ids],
    async () => {
      let ok = true;
      if (visibility.value !== r.visibility) ok = await post(`/api/admin/rooms/${r.id}/set-visibility`, { visibility: visibility.value });
      const newOwner = owner.value.trim();
      if (ok && newOwner && newOwner.toLowerCase() !== r.owner.toLowerCase()) {
        if (!window.confirm(`Give #${r.id} to ${newOwner}?`)) return false;
        ok = await post(`/api/admin/rooms/${r.id}/set-owner`, { userId: newOwner });
      }
      if (ok) void load('rooms');
      return ok;
    },
    [resetKey],
  );
}
const empty = (text: string) => el('li', { className: 'empty-state', text });

// ---- Overview ----

function renderOverview(o: AdminOverview): void {
  const stat = (label: string, value: number | string, kind = '') =>
    el('div', { className: `admin-stat ${kind}` }, [el('span', { className: 'admin-stat-value', text: String(value) }), el('span', { text: label })]);
  $('#ov-stats').replaceChildren(
    stat('online now', o.online, 'is-good'),
    stat('open devices', o.devices),
    stat('calls now', o.calls.length),
    stat('accounts', o.accounts),
    stat('rooms', o.rooms),
    stat('locked out', o.locked, o.locked ? 'is-warn' : ''),
    stat('suspended', o.suspended, o.suspended ? 'is-warn' : ''),
  );
  $('#ov-calls').replaceChildren(
    ...(o.calls.length
      ? o.calls.map((c) =>
          el('li', { className: 'admin-row' }, [
            el('span', { className: 'admin-row-main' }, [
              el('strong', { text: c.roomId ? `#${c.roomId}` : 'Direct call' }),
              el('span', { className: 'admin-muted', text: `${c.participants.join(', ') || 'nobody yet'}${c.invited.length ? ` · ringing ${c.invited.join(', ')}` : ''}` }),
            ]),
            el('span', { className: 'admin-muted', text: formatDuration(Date.now() - c.startedAt) }),
          ]),
        )
      : [empty('No calls right now.')]),
  );
  mailOn = o.mailEnabled;
  $('#ov-system').textContent =
    `Server up ${formatDuration(Date.now() - o.serverStartedAt)} · build ${o.version} · ${o.memoryMb} MB memory · ` +
    `email ${o.mailEnabled ? 'on' : 'off (set SMTP_* and PUBLIC_URL in .env)'}`;
}

// ---- Users ----

const userSearch = $<HTMLInputElement>('#user-search');
const userFilter = $<HTMLSelectElement>('#user-filter');
userSearch.addEventListener('input', renderUsers);
userFilter.addEventListener('change', renderUsers);

function renderUsers(): void {
  const q = userSearch.value.trim().toLowerCase();
  const filter = userFilter.value;
  const shown = users.filter((u) => {
    const emails = `${u.googleEmail ?? ''} ${u.recoveryEmail ?? ''}`.toLowerCase();
    if (q && !u.id.toLowerCase().includes(q) && !emails.includes(q)) return false;
    if (filter === 'online') return u.online > 0;
    if (filter === 'suspended') return u.suspended;
    if (filter === 'locked') return u.lockedUntil > 0;
    return true;
  });
  $('#user-count').textContent = `${shown.length} of ${users.length} accounts`;
  $('#users-list').replaceChildren(...(shown.length ? shown.map(renderUser) : [empty('Nobody matches.')]));
}

function renderUser(u: AdminUser): HTMLLIElement {
  const me = document.body.dataset.userId?.toLowerCase() === u.id.toLowerCase();
  const badges = [
    u.admin ? tag('admin', 'is-admin') : null,
    u.online ? tag(`online · ${u.online} device${u.online > 1 ? 's' : ''}`, 'is-good') : null,
    u.suspended ? tag('suspended', 'is-bad') : null,
    u.lockedUntil ? tag(`locked until ${dateTime(u.lockedUntil)}`, 'is-warn') : null,
  ].filter((b): b is HTMLSpanElement => b !== null);
  const how = [u.hasPin ? 'PIN' : null, u.googleEmail ? `Google (${u.googleEmail})` : null].filter(Boolean).join(' + ');
  const recovery = u.recoveryEmail ? `recovery ${u.recoveryEmail}` : 'no recovery email';
  const facts = `${how || 'no sign-in method'} · ${recovery} · joined ${date(u.createdAt)} · ${u.sessions} signed-in device(s) · ` +
    `${u.pushDevices} with notifications · ${u.friends} friend(s) · ${u.rooms} room(s) · status ${u.status}`;

  const actions: HTMLElement[] = [];
  const protectedAdmin = u.admin && !me; // other admins are managed in .env
  if (!protectedAdmin) actions.push(button('✏️ Edit', 'btn-primary', () => editUser(u), 'Recovery email, status, PIN'));
  if (!protectedAdmin) {
    actions.push(button('Sign out everywhere', 'btn-secondary', () => {
      if (window.confirm(`Sign ${u.id} out on every device?`)) void act(`/api/admin/users/${u.id}/sign-out`);
    }));
    actions.push(button('Set new PIN', 'btn-secondary', () => {
      const pin = window.prompt(`New 4-digit PIN for ${u.id}. Tell them yourself; they're signed out everywhere.`);
      if (pin === null) return;
      if (!isValidPin(pin)) {
        toast(PIN_RULES, 'error');
        return;
      }
      void act(`/api/admin/users/${u.id}/set-pin`, { pin });
    }));
  }
  if (u.lockedUntil) actions.push(button('Unlock PIN', 'btn-secondary', () => void act(`/api/admin/users/${u.id}/unlock`)));
  if (!protectedAdmin && !me) {
    actions.push(
      u.suspended
        ? button('Unsuspend', 'btn-secondary', () => void act(`/api/admin/users/${u.id}/unsuspend`))
        : button('Suspend', 'btn-ghost btn-delete', () => {
            if (window.confirm(`Suspend ${u.id}? They're signed out everywhere and can't sign in until unsuspended.`)) {
              void act(`/api/admin/users/${u.id}/suspend`);
            }
          }),
    );
    actions.push(button('Delete', 'btn-ghost btn-delete', () => {
      const typed = window.prompt(
        `Delete ${u.id} for good? Their friends, pictures, stickers, call history and the rooms they own go too.\n\nType "${u.id}" to confirm.`,
      );
      if (typed !== null) void act(`/api/admin/users/${u.id}/delete`, { confirm: typed });
    }));
  }
  if (protectedAdmin) actions.push(el('span', { className: 'admin-muted', text: 'Admins are managed in .env' }));

  return el('li', { className: 'admin-row admin-user' }, [
    el('span', { className: 'admin-row-main' }, [
      el('span', { className: 'admin-row-title' }, [el('strong', { text: u.id }), ...badges]),
      el('span', { className: 'admin-muted', text: facts }),
    ]),
    el('span', { className: 'admin-actions' }, actions),
  ]);
}

// ---- Rooms ----

const roomSearch = $<HTMLInputElement>('#room-search');
roomSearch.addEventListener('input', renderRooms);
const VISIBILITY: Record<AdminRoom['visibility'], string> = {
  public: 'public',
  private: 'private',
  link: 'link only',
  'public-chat': 'everyone · announcements',
};

function renderRooms(): void {
  const q = roomSearch.value.trim().toLowerCase();
  const shown = rooms.filter((r) => !q || r.id.includes(q) || r.owner.toLowerCase().includes(q));
  $('#rooms-list').replaceChildren(...(shown.length ? shown.map(renderRoom) : [empty('No rooms match.')]));
}

function personChip(roomId: string, id: string, banned: boolean): HTMLElement {
  const actions = banned
    ? [button('Unban', 'btn-ghost', () => void act(`/api/admin/rooms/${roomId}/unban`, { userId: id }))]
    : [
        button('Remove', 'btn-ghost', () => void act(`/api/admin/rooms/${roomId}/remove-member`, { userId: id, ban: false })),
        button('Ban', 'btn-ghost btn-delete', () => {
          if (window.confirm(`Ban ${id} from #${roomId}? They can't come back, not even with the link.`)) {
            void act(`/api/admin/rooms/${roomId}/remove-member`, { userId: id, ban: true });
          }
        }),
      ];
  return el('span', { className: `admin-chip${banned ? ' is-banned' : ''}` }, [el('span', { text: id }), ...actions]);
}

function renderRoom(r: AdminRoom): HTMLLIElement {
  const isPublicChat = r.visibility === 'public-chat';
  const facts = isPublicChat
    ? `${r.messages} message(s) · ${r.online.length} reading now`
    : `owner ${r.owner} · created ${date(r.createdAt)} · ${r.members.length} member(s) · ${r.messages} message(s)` +
      `${r.online.length ? ` · ${r.online.length} in chat now` : ''}${r.inCall ? ` · ${r.inCall} in a call` : ''}`;
  const actions = [
    button('Clear chat history', 'btn-secondary', () => {
      if (window.confirm(`Delete every message in #${r.id}? Everyone in it sees the chat go.`)) {
        void act(`/api/admin/rooms/${r.id}/clear-history`);
      }
    }),
  ];
  if (!isPublicChat) {
    actions.unshift(button('✏️ Edit', 'btn-primary', () => editRoom(r), 'Visibility, owner, invite link'));
    actions.push(button('Delete room', 'btn-ghost btn-delete', () => {
      if (window.confirm(`Delete #${r.id}? Everyone is moved out and its chat history is deleted.`)) {
        void act(`/api/admin/rooms/${r.id}/delete`);
      }
    }));
  }
  const people: HTMLElement[] = [];
  if (r.members.length || r.banned.length) {
    const details = el('details', { className: 'admin-people' }, [
      el('summary', { text: `People (${r.members.length} member${r.members.length === 1 ? '' : 's'}${r.banned.length ? `, ${r.banned.length} banned` : ''})` }),
      el('div', { className: 'admin-chips' }, [
        ...r.members.map((id) => personChip(r.id, id, false)),
        ...r.banned.map((id) => personChip(r.id, id, true)),
      ]),
    ]);
    people.push(details);
  }
  return el('li', { className: 'admin-row admin-room' }, [
    el('span', { className: 'admin-row-main' }, [
      el('span', { className: 'admin-row-title' }, [
        el('strong', { text: isPublicChat ? '📢 Public chat' : `#${r.id}` }),
        tag(VISIBILITY[r.visibility], r.visibility === 'public' || isPublicChat ? '' : 'is-admin'),
        ...(r.inCall ? [tag('call on', 'is-good')] : []),
      ]),
      el('span', { className: 'admin-muted', text: facts }),
      ...people,
    ]),
    el('span', { className: 'admin-actions' }, actions),
  ]);
}

// ---- Audit log ----

const ACTION_LABELS: Record<string, string> = {
  unlock: 'unlocked the dashboard',
  'unlock-failed': 'typed a wrong admin passcode',
  'sign-out': 'signed out everywhere',
  'set-pin': 'set a new PIN for',
  'unlock-pin': 'lifted the PIN lockout of',
  suspend: 'suspended',
  unsuspend: 'unsuspended',
  'delete-user': 'deleted the account',
  'clear-history': 'cleared the chat of',
  'delete-room': 'deleted the room',
  'remove-member': 'removed someone from',
  'ban-member': 'banned someone from',
  'unban-member': 'unbanned someone in',
  'update-user': 'edited',
  'send-reset': 'emailed a PIN reset link to',
  'self-reset-pin': 'reset their own PIN by email:',
  'room-visibility': 'changed who can see',
  'room-owner': 'changed the owner of',
  'room-reset-key': 'made a new invite link for',
};

function renderLog(entries: AdminLogEntry[]): void {
  $('#log-list').replaceChildren(
    ...(entries.length
      ? entries.map((e) =>
          el('li', { className: `admin-row${e.action === 'unlock-failed' ? ' is-warn' : ''}` }, [
            el('span', { className: 'admin-row-main' }, [
              el('span', { text: `${e.admin} ${ACTION_LABELS[e.action] ?? e.action}${e.target !== '-' ? ` ${e.target}` : ''}` }),
              ...(e.detail ? [el('span', { className: 'admin-muted', text: e.detail })] : []),
            ]),
            el('time', { className: 'admin-muted', text: dateTime(e.at) }),
          ]),
        )
      : [empty('Nothing yet.')]),
  );
}

// Start: the dashboard if this sign-in already unlocked it, else the passcode form.
void (async () => {
  const res = await api<{ overview: AdminOverview }>('GET', '/api/admin/overview');
  if (res.ok) showDash();
  else showLocked();
})();
