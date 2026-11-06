import { io } from 'socket.io-client';
import { CONNECT_ERRORS, type OnlineUserSummary, type PushTestResult, type UserStatus } from '../shared/types';
import { isDmRoomId, isValidRoomId, isValidUserId, MAX_AVATAR_BYTES, ROOM_ID_RULES } from '../shared/validation';
import { CallManager, canShareScreen, IDLE_CALL, type CallInfo } from './lib/CallManager';
import { CallHistoryPanel } from './lib/CallHistoryPanel';
import { ChatPanel } from './lib/ChatPanel';
import { currentPalette, currentTextSize, setPalette, setTextSize, type PaletteId, type TextSize } from './lib/appearance';
import { CustomEmojiStore } from './lib/emoji';
import { FriendsPanel } from './lib/FriendsPanel';
import { JoinDialog } from './lib/JoinDialog';
import { LinkDeviceDialog } from './lib/LinkDeviceDialog';
import { RecoveryEmailDialog } from './lib/RecoveryEmailDialog';
import { RoomMembersDialog } from './lib/RoomMembersDialog';
import { RoomsPanel } from './lib/RoomsPanel';
import { ShareDialog } from './lib/ShareDialog';
import { $, avatar, avatarUrlOf, el, formatDuration, hueFor, onAvatarsChange, paintAvatar, setAvatarUrls, toast } from './lib/dom';
import { squareImage } from './lib/images';
import { MobileTabs } from './lib/MobileTabs';
import { androidDownloadUrl } from './lib/androidApp';
import { nativeBridge, onNativeCommands } from './lib/nativeApp';
import { showInstallHint } from './lib/installHint';
import { isStandalone, PushNotifications, type PushStatus } from './lib/push';
import { NOT_CONNECTED, withTimeout, type AppSocket } from './lib/socket';
import { bindThemeToggle } from './lib/theme';
import { UpdateWatcher } from './lib/updates';
import { lockZoomInStandalone } from './lib/zoom';

lockZoomInStandalone();
const userId = document.body.dataset.userId ?? '';
bindThemeToggle($<HTMLButtonElement>('#theme-btn'));
$('#me-avatar').style.setProperty('--h', String(hueFor(userId)));
const iceServers: RTCIceServer[] = JSON.parse($('#ice-config').textContent || '[]');

// ---- DOM ----
const connDot = $('#conn-status');
const connBanner = $('#conn-banner');
const connBannerText = $('#conn-banner-text');
const roomJoinBtn = $<HTMLButtonElement>('#room-join-btn');
const usersList = $<HTMLUListElement>('#users-list');
const usersCount = $('#users-count');
const callModeSwitch = $('#call-mode');
const callRoomForm = $<HTMLFormElement>('#call-room-form');
const callRoomInput = $<HTMLInputElement>('#call-room-id');
const roomBanner = $('#room-banner');
const roomBannerId = $('#room-banner-id');
const copyLinkBtn = $<HTMLButtonElement>('#copy-link-btn');
const dialForm = $<HTMLFormElement>('#dial-form');
const targetInput = $<HTMLInputElement>('#target-id');
const callBtn = $<HTMLButtonElement>('#call-btn');
const camPrefBtns = [...document.querySelectorAll<HTMLButtonElement>('.cam-pref')];
const callTimer = $('#call-timer');
const stage = $('#stage');
const remoteGrid = $('#remote-grid');
const stagePlaceholder = $('#stage-placeholder');
const stagePlaceholderText = $('#stage-placeholder-text');
const stageCallee = $('#stage-callee');
const incomingAvatar = $('#incoming-avatar');
const localVideo = $<HTMLVideoElement>('#local-video');
const localTile = $('#local-tile');
const localAvatar = $('#local-avatar');
const layoutBtn = $<HTMLButtonElement>('#layout-btn');
const minimizeBtn = $<HTMLButtonElement>('#call-minimize-btn');
const stageFullscreenBtn = $<HTMLButtonElement>('#stage-fullscreen-btn');
const flipBtn = $<HTMLButtonElement>('#flip-btn');
const elsewhereBanner = $('#call-elsewhere');
const elsewhereText = $('#call-elsewhere-text');
const moveCallBtn = $<HTMLButtonElement>('#move-call-btn');
const callReturn = $<HTMLButtonElement>('#call-return');
const callReturnText = $('#call-return-text');
const callStatus = $('#call-status');
const callControls = $('#call-controls');
const micBtn = $<HTMLButtonElement>('#mic-btn');
const camBtn = $<HTMLButtonElement>('#cam-btn');
const shareBtn = $<HTMLButtonElement>('#share-btn');
const hangupBtn = $<HTMLButtonElement>('#hangup-btn');
const notifyBtn = $<HTMLButtonElement>('#notify-btn');
const notifyBanner = $('#notify-banner');
const incomingDialog = $<HTMLDialogElement>('#incoming-dialog');
const incomingText = $('#incoming-text');
const incomingSub = $('#incoming-sub');
const acceptAudioBtn = $<HTMLButtonElement>('#accept-audio-btn');
const acceptVideoBtn = $<HTMLButtonElement>('#accept-video-btn');
const rejectBtn = $<HTMLButtonElement>('#reject-btn');

const tabs = new MobileTabs('call');
const push = new PushNotifications();

function setButtonLabel(button: HTMLButtonElement, label: string, pressed?: boolean): void {
  const span = button.querySelector('.ctrl-label') ?? button.querySelector('span');
  if (span) span.textContent = label;
  else button.textContent = label;
  if (pressed !== undefined) button.setAttribute('aria-pressed', String(pressed));
}

// ---- Camera preference ----
// One Call / Join button; this toggle picks whether calls start with the camera or audio only.
// The camera can still be switched on or off at any time during the call.
const CAMERA_PREF_KEY = 'call9me:camera';
let cameraPref = true;
try {
  cameraPref = localStorage.getItem(CAMERA_PREF_KEY) !== 'off';
} catch {
  /* default: camera on */
}
function renderCameraPref(): void {
  for (const button of camPrefBtns) {
    button.setAttribute('aria-pressed', String(cameraPref));
    button.title = cameraPref
      ? 'Camera on: calls start with video. Tap for audio only.'
      : 'Camera off: calls start audio only. Tap to turn the camera on.';
    button.setAttribute('aria-label', cameraPref ? 'Start with camera on' : 'Start with camera off (audio only)');
  }
}
for (const button of camPrefBtns) {
  button.addEventListener('click', () => {
    cameraPref = !cameraPref;
    try {
      localStorage.setItem(CAMERA_PREF_KEY, cameraPref ? 'on' : 'off');
    } catch {
      /* remembered for this visit only */
    }
    renderCameraPref();
  });
}
renderCameraPref();

// ---- Socket ----
const socket: AppSocket = io({ autoConnect: false });

// ---- App updates ----
// The server pushes its build on every connect; an outdated page offers to reload, and does
// so on its own only when nothing would be interrupted (no call, no unsent message, not on screen).
const updates = new UpdateWatcher({
  isBusy: () => callsInfo.state !== 'idle' || !!$<HTMLInputElement>('#message-input').value,
  busyText: 'A new version of Call9me is ready. Update when you are done.',
});
socket.on('app:version', ({ version }) => updates.report(version));

// In a browser tab: invite the user to add Call9me to their home screen (calls, notifications).
showInstallHint({ delayMs: 6000 });
// Android browser tab: the profile menu also offers the Android app.
const androidGet = document.getElementById('android-get');
if (androidGet && androidDownloadUrl()) androidGet.hidden = false;
let takenRetries = 0;
let hasConnected = false;
/** The Android app disconnected us while in the background: reconnect without a "Reconnected" toast. */
let pausedInBackground = false;

// The server only sends push notifications while the app is NOT on screen.
function reportVisibility(): void {
  if (socket.connected) socket.emit('client:visibility', { visible: document.visibilityState === 'visible' });
}
document.addEventListener('visibilitychange', reportVisibility);
window.addEventListener('pagehide', () => {
  if (socket.connected) socket.emit('client:visibility', { visible: false });
});

// ---- Settings: your status ----
const STATUS_LABELS: Record<UserStatus, string> = {
  online: 'Online',
  idle: 'Idle',
  dnd: 'Do not disturb',
  invisible: 'Invisible',
};
const meBtn = $<HTMLButtonElement>('#me-btn');
const settingsMenu = $('#settings-menu');
const meStatusLabel = $('#me-status-label');
let myStatus: UserStatus = 'online';

function renderMyStatus(): void {
  connDot.dataset.status = myStatus;
  meStatusLabel.textContent = STATUS_LABELS[myStatus];
  for (const item of settingsMenu.querySelectorAll<HTMLButtonElement>('[data-status]')) {
    item.setAttribute('aria-checked', String(item.dataset.status === myStatus));
  }
}

function setSettingsOpen(open: boolean): void {
  settingsMenu.hidden = !open;
  meBtn.setAttribute('aria-expanded', String(open));
}
meBtn.addEventListener('click', () => setSettingsOpen(settingsMenu.hidden));
document.addEventListener('click', (e) => {
  if (!settingsMenu.hidden && !(e.target as HTMLElement).closest('#settings-menu, #me-btn')) setSettingsOpen(false);
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !settingsMenu.hidden) {
    setSettingsOpen(false);
    meBtn.focus();
  }
});
settingsMenu.addEventListener('click', (e) => {
  const item = (e.target as HTMLElement).closest<HTMLButtonElement>('button[data-status]');
  if (!item) return;
  const status = item.dataset.status as UserStatus;
  setSettingsOpen(false);
  if (status === myStatus) return;
  if (!socket.connected) {
    toast(NOT_CONNECTED, 'error');
    return;
  }
  socket.emit('status:set', { status }, withTimeout((res) => {
    if (!res.ok) {
      toast(res.error, 'error');
      return;
    }
    myStatus = status;
    renderMyStatus();
    toast(`Status: ${STATUS_LABELS[status]}.`, 'success');
  }));
});
// ---- Settings: appearance (colour theme + text size, remembered on this device) ----
const palettePicker = $('#palette-picker');
const textSizeSwitch = $('#text-size');
function renderAppearance(): void {
  const palette = currentPalette();
  for (const swatch of palettePicker.querySelectorAll<HTMLButtonElement>('[data-palette]')) {
    swatch.setAttribute('aria-checked', String(swatch.dataset.palette === palette));
  }
  const size = currentTextSize();
  for (const button of textSizeSwitch.querySelectorAll<HTMLButtonElement>('[data-text]')) {
    button.setAttribute('aria-checked', String(button.dataset.text === size));
  }
}
palettePicker.addEventListener('click', (e) => {
  const swatch = (e.target as HTMLElement).closest<HTMLButtonElement>('[data-palette]');
  if (!swatch) return;
  setPalette(swatch.dataset.palette as PaletteId);
  renderAppearance();
});
textSizeSwitch.addEventListener('click', (e) => {
  const button = (e.target as HTMLElement).closest<HTMLButtonElement>('[data-text]');
  if (!button) return;
  setTextSize(button.dataset.text as TextSize);
  renderAppearance();
});
renderAppearance();

// ---- Settings: profile picture ----
const profileAvatar = $('#profile-avatar');
profileAvatar.style.setProperty('--h', String(hueFor(userId)));
const avatarFile = $<HTMLInputElement>('#avatar-file');
const avatarRemoveBtn = $<HTMLButtonElement>('#avatar-remove-btn');
$('#avatar-change-btn').addEventListener('click', () => avatarFile.click());

function sendAvatar(image: string | null): void {
  if (!socket.connected) {
    toast(NOT_CONNECTED, 'error');
    return;
  }
  socket.emit('profile:avatar', { image }, withTimeout((res) => {
    if (!res.ok) toast(res.error, 'error');
    else toast(image ? 'Profile picture updated.' : 'Profile picture removed.', 'success');
  }));
}
avatarFile.addEventListener('change', async () => {
  const file = avatarFile.files?.[0];
  avatarFile.value = '';
  if (!file) return;
  try {
    sendAvatar(await squareImage(file, 256, MAX_AVATAR_BYTES));
  } catch {
    toast('That picture could not be used. Try a PNG or JPEG.', 'error');
  }
});
avatarRemoveBtn.addEventListener('click', () => {
  if (window.confirm('Remove your profile picture?')) sendAvatar(null);
});

/** Everyone's pictures changed (or arrived): repaint every avatar on screen. */
function repaintAvatars(): void {
  paintAvatar($('#me-avatar'), userId);
  paintAvatar(profileAvatar, userId);
  avatarRemoveBtn.hidden = !avatarUrlOf(userId);
  for (const tile of [...tiles.values(), ...screenTiles.values()]) {
    paintAvatar(tile.root.querySelector<HTMLElement>('.tile-avatar')!, tile.root.dataset.peer ?? '');
  }
  paintSelfTile();
  for (const node of [incomingAvatar, stageCallee]) if (node.dataset.person) paintAvatar(node, node.dataset.person);
  renderUsers();
  friends?.render();
  callHistory.render();
}
socket.on('avatars:update', setAvatarUrls);
onAvatarsChange(repaintAvatars);

// The server sends our saved status on every connect (it's shared by all our devices).
socket.on('status:update', ({ status }) => {
  myStatus = status;
  renderMyStatus();
});
renderMyStatus();

// ---- Connection status ----
// A banner (not just the dot) says when we're offline; the first connect gets a moment before it shows.
let bannerTimer: ReturnType<typeof setTimeout> | undefined;
function renderConnection(): void {
  const online = socket.connected;
  connDot.dataset.state = online ? 'online' : 'offline';
  connDot.title = online ? 'Connected' : hasConnected ? 'Disconnected — reconnecting…' : 'Connecting…';
  connBannerText.textContent = !navigator.onLine
    ? 'You are offline. Waiting for the network…'
    : hasConnected
      ? 'Connection lost. Reconnecting…'
      : 'Connecting to the server…';
  clearTimeout(bannerTimer);
  if (online) connBanner.hidden = true;
  else if (hasConnected) connBanner.hidden = false;
  else bannerTimer = setTimeout(() => (connBanner.hidden = socket.connected), 2000);
  renderCallState(callsInfo);
}

/** Skips socket.io's reconnect back-off, e.g. when the network or the app comes back. */
function reconnectNow(): void {
  if (socket.connected) return;
  socket.disconnect();
  socket.connect();
}
$('#conn-retry-btn').addEventListener('click', reconnectNow);
window.addEventListener('online', reconnectNow);
window.addEventListener('offline', renderConnection);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && hasConnected) reconnectNow();
});

socket.on('connect', () => {
  takenRetries = 0;
  reportVisibility();
  callHistory.load();
  if (hasConnected) {
    if (!pausedInBackground) toast('Reconnected', 'success');
    pausedInBackground = false;
    chat.rejoin();
  } else {
    prefillCallRoomFromUrl();
    joinRoomFromUrl(window.location.href); // otherwise the Chat tab shows the list of chats
    if (pendingAnswer) {
      // The server delivers the ringing invite right after connecting; if it doesn't, it's over.
      const { callId } = pendingAnswer;
      setTimeout(() => {
        if (pendingAnswer?.callId === callId) {
          pendingAnswer = null;
          toast('That call is no longer ringing.');
        }
      }, 4000);
    }
  }
  hasConnected = true;
  renderConnection();
});

socket.on('disconnect', (reason) => {
  // Requests queued while offline belong to a session the server has already dropped
  // (it ends our calls); replaying them after reconnecting would do stale things.
  socket.sendBuffer = [];
  // (A ringing call left behind by the Android app going to the background rings natively instead.)
  if (calls.state !== 'idle' && !pausedInBackground) toast('Lost connection to server — call ended.', 'error');
  calls.reset();
  // The server closed this connection itself, so socket.io won't retry on its own.
  if (reason === 'io server disconnect') socket.connect();
  renderConnection();
});

socket.on('connect_error', (err) => {
  if (err.message === CONNECT_ERRORS.UNAUTHORIZED) {
    window.location.replace('/?error=session');
  } else if (err.message === CONNECT_ERRORS.TOO_MANY_DEVICES) {
    // After a page refresh the old connection may take a moment to be released.
    if (takenRetries++ < 3) setTimeout(() => socket.connect(), 1000);
    else window.location.replace('/?error=devices');
  }
});

// ---- Online users ----
let lastUsers: OnlineUserSummary[] = [];
/** Set up further down (see "Friends"); the online list shows who's a friend. */
let friends: FriendsPanel | undefined;
socket.on('users:update', (users) => {
  lastUsers = users;
  renderUsers();
});

const PRESENCE_LABELS: Record<OnlineUserSummary['presence'], string> = {
  available: 'Online',
  busy: 'In a call',
  idle: 'Idle',
  dnd: 'Do not disturb',
  offline: 'Offline · rings their phone',
};
/** Presences that can't take a call right now. */
const UNCALLABLE: ReadonlySet<OnlineUserSummary['presence']> = new Set(['busy', 'dnd']);

/** Phone "People" tab: pending friend requests matter more than the online count. */
function updateUsersBadge(onlineCount: number): void {
  const requests = friends?.current.incoming.length ?? 0;
  tabs.setBadge('users', requests ? `+${requests}` : onlineCount || null);
}

function renderUsers(): void {
  const others = lastUsers.filter((u) => u.id !== userId);
  const onlineCount = others.filter((u) => u.presence !== 'offline').length;
  usersCount.textContent = String(onlineCount);
  updateUsersBadge(onlineCount);
  friends?.render(); // friends' presence comes from this list

  // Friends who are online first, then everyone else who is publicly online (or reachable).
  const friendsOnline = others.filter((u) => u.presence !== 'offline' && friends?.isFriend(u.id));
  const everyone = others.filter((u) => !friendsOnline.includes(u));
  const items: HTMLElement[] = [];
  if (friendsOnline.length) {
    items.push(el('li', { className: 'list-heading', text: `Friends online (${friendsOnline.length})` }));
    items.push(...friendsOnline.map(renderUserItem));
  }
  items.push(el('li', { className: 'list-heading', text: friendsOnline.length ? 'Everyone else' : 'Everyone online' }));
  if (everyone.length) items.push(...everyone.map(renderUserItem));
  else items.push(el('li', { className: 'empty-state', text: friendsOnline.length ? 'Nobody else right now.' : 'Nobody else is online yet.' }));
  usersList.replaceChildren(...items);
}

function renderUserItem(u: OnlineUserSummary): HTMLLIElement {
  const inCall = calls.state === 'in-call';
  const callBtn = el('button', {
    className: 'btn btn-small btn-primary user-call-btn',
    text: inCall ? 'Add' : 'Call',
    title: inCall ? `Add ${u.id} to the call` : `Call ${u.id}`,
  });
  callBtn.type = 'button';
  callBtn.disabled = UNCALLABLE.has(u.presence) || calls.state === 'incoming' || !socket.connected;
  callBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    targetInput.value = u.id;
    startCall();
  });

  const isFriend = friends?.isFriend(u.id) ?? false;
  const actions: HTMLElement[] = [callBtn];
  if (friends && !isFriend && !friends.isPending(u.id)) {
    const addBtn = el('button', { className: 'btn btn-small btn-ghost icon-only', text: '+', title: `Add ${u.id} as a friend` });
    addBtn.type = 'button';
    addBtn.setAttribute('aria-label', `Add ${u.id} as a friend`);
    addBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      friends?.request(u.id);
    });
    actions.unshift(addBtn);
  }

  const item = el('li', { className: `user-item ${u.presence}` }, [
    avatar(u.id, [el('span', { className: 'presence-dot', title: u.presence })]),
    el('span', { className: 'user-meta' }, [
      el('span', { className: 'user-name', text: u.id }),
      el('span', {
        className: 'user-presence',
        text: PRESENCE_LABELS[u.presence] + (isFriend ? ' · Friend' : friends?.isPending(u.id) ? ' · Request pending' : ''),
      }),
    ]),
    el('span', { className: 'row-actions' }, actions),
  ]);
  item.tabIndex = 0;
  const select = () => {
    targetInput.value = u.id;
    if (tabs.isPhone) tabs.show('call');
    else targetInput.focus();
  };
  item.addEventListener('click', select);
  item.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') select();
  });
  return item;
}

// ---- Call tiles ----
// Everyone in the call gets an equal tile in one grid (us included); a screen share is a
// tile of its own next to the sharer's camera, joined by choice ("Watch stream"). Tapping a
// tile maximizes it, with the others in a strip below; tapping it again goes back to the grid.
interface Tile {
  root: HTMLElement;
  video: HTMLVideoElement;
  status: HTMLElement;
}
/** People's camera tiles, by user ID (not ours). */
const tiles = new Map<string, Tile>();
/** Screen-share tiles, by the sharer's user ID (ours under our own ID). */
const screenTiles = new Map<string, Tile>();
/** Peers sharing their screen right now (from their `call:screen`). */
const sharingPeers = new Set<string>();
/** Screen shares we chose to watch; the others show a "Watch stream" card. */
const watchedShares = new Set<string>();
/** Each peer's screen-share video, which exists before (and between) their shares. */
const peerScreenStreams = new Map<string, MediaStream>();
/** Peers who switched their camera off (their video track may not report "muted" right away). */
const cameraOffPeers = new Set<string>();
/** The maximized tile ("cam:<id>", "screen:<id>", or "cam:" + our ID), or null for the grid. */
let focusKey: string | null = null;

const cameraKey = (id: string) => `cam:${id}`;
const screenKey = (id: string) => `screen:${id}`;

function tileShell(key: string, ownerId: string, name: string, extra: HTMLElement[] = []): Tile {
  const video = el('video');
  video.autoplay = true;
  video.playsInline = true;
  keepPlaying(video);
  const status = el('span', { className: 'tile-status' });
  const fullscreenBtn = el('button', { className: 'tile-fullscreen', title: 'Full screen', text: '⤢' });
  fullscreenBtn.type = 'button';
  const tileAvatar = el('div', { className: 'tile-avatar', text: ownerId.charAt(0).toUpperCase() });
  paintAvatar(tileAvatar, ownerId); // their profile picture while their camera is off
  const root = el('div', { className: 'tile' }, [
    tileAvatar,
    video,
    ...extra,
    el('div', { className: 'tile-label' }, [el('span', { className: 'tile-name', text: name }), status]),
    fullscreenBtn,
  ]);
  fullscreenBtn.addEventListener('click', (e) => {
    e.stopPropagation(); // not a tap on the tile (that toggles maximizing it)
    focusKey = key;
    layoutStage();
    enterStageFullscreen(video);
  });
  root.dataset.key = key;
  root.dataset.peer = ownerId;
  root.style.setProperty('--h', String(hueFor(ownerId)));
  root.tabIndex = 0;
  root.setAttribute('role', 'button');
  return { root, video, status };
}

function ensureTile(peerId: string): Tile {
  let tile = tiles.get(peerId);
  if (tile) return tile;
  tile = tileShell(cameraKey(peerId), peerId, peerId);
  tile.status.textContent = 'Connecting…';
  remoteGrid.append(tile.root);
  tiles.set(peerId, tile);
  layoutStage();
  return tile;
}

function removeTile(peerId: string): void {
  tiles.get(peerId)?.root.remove();
  tiles.delete(peerId);
  sharingPeers.delete(peerId);
  watchedShares.delete(peerId);
  peerScreenStreams.delete(peerId);
  removeScreenTile(peerId);
  layoutStage();
}

/** A screen-share tile: ours (always shown), or a peer's with "Watch stream" / "Stop watching". */
function ensureScreenTile(ownerId: string): Tile {
  let tile = screenTiles.get(ownerId);
  if (tile) return tile;
  const mine = ownerId === userId;
  const extra: HTMLElement[] = [];
  if (!mine) {
    const watch = el('button', { className: 'btn btn-primary screen-watch', text: 'Watch stream' });
    watch.type = 'button';
    watch.addEventListener('click', (e) => {
      e.stopPropagation();
      watchShare(ownerId, true);
    });
    const stop = el('button', { className: 'tile-screen-toggle', text: 'Stop watching' });
    stop.type = 'button';
    stop.addEventListener('click', (e) => {
      e.stopPropagation();
      watchShare(ownerId, false);
    });
    extra.push(el('div', { className: 'screen-card' }, [el('p', { text: `${ownerId} is sharing their screen` }), watch]), stop);
  }
  tile = tileShell(screenKey(ownerId), ownerId, mine ? 'Your screen' : `${ownerId}'s screen`, extra);
  tile.root.classList.add('screen-tile');
  tile.video.muted = true; // screens carry no sound
  remoteGrid.append(tile.root);
  screenTiles.set(ownerId, tile);
  return tile;
}

function removeScreenTile(ownerId: string): void {
  screenTiles.get(ownerId)?.root.remove();
  screenTiles.delete(ownerId);
  if (focusKey === screenKey(ownerId)) focusKey = null;
}

/** Watching a share maximizes it (like opening a stream); stopping goes back to the grid. */
function watchShare(peerId: string, watch: boolean): void {
  if (!sharingPeers.has(peerId)) return;
  if (watch) {
    watchedShares.add(peerId);
    focusKey = screenKey(peerId);
    screenTiles.get(peerId)?.video.play().catch(() => {});
  } else {
    watchedShares.delete(peerId);
    if (focusKey === screenKey(peerId)) focusKey = null;
  }
  layoutStage();
}

/** A peer started or stopped sharing: their screen tile comes and goes. */
function setPeerSharing(peerId: string, sharing: boolean): void {
  if (sharing) {
    sharingPeers.add(peerId);
    const tile = ensureScreenTile(peerId);
    const stream = peerScreenStreams.get(peerId);
    if (stream && tile.video.srcObject !== stream) tile.video.srcObject = stream;
  } else {
    sharingPeers.delete(peerId);
    watchedShares.delete(peerId);
    removeScreenTile(peerId);
  }
  layoutStage();
}

/**
 * The whole call goes full screen (the maximized tile big, everyone else along the side),
 * not just one video, so the other cameras stay in view. iPhones can't make a page element
 * full screen; there the call already covers the screen, so maximizing is enough.
 */
/** Full screen takes the whole call panel, so the mute / camera / leave buttons come along. */
const callPanel = stage.closest<HTMLElement>('.call-panel') ?? stage;
const canStageFullscreen = typeof callPanel.requestFullscreen === 'function' && document.fullscreenEnabled !== false;
function enterStageFullscreen(video?: HTMLVideoElement): void {
  if (document.fullscreenElement === callPanel) return;
  if (canStageFullscreen) {
    callPanel.requestFullscreen().catch(() => {});
    return;
  }
  // Last resort (old iPad Safari): the browser's own full-screen player for that video.
  (video as (HTMLVideoElement & { webkitEnterFullscreen?: () => void }) | undefined)?.webkitEnterFullscreen?.();
}
function renderStageFullscreen(): void {
  const on = document.fullscreenElement === callPanel;
  stage.classList.toggle('is-fullscreen', on);
  stageFullscreenBtn.hidden = !canStageFullscreen || callsInfo?.state !== 'in-call';
  const label = on ? 'Exit full screen' : 'Full screen';
  stageFullscreenBtn.title = label;
  stageFullscreenBtn.setAttribute('aria-label', label);
}
stageFullscreenBtn.addEventListener('click', () => {
  if (document.fullscreenElement === callPanel) void document.exitFullscreen().catch(() => {});
  else enterStageFullscreen();
});
document.addEventListener('fullscreenchange', renderStageFullscreen);

/**
 * Live call video (including a shared screen) must never stay paused: no controls,
 * no picture-in-picture or context menu, and anything that pauses it resumes it.
 */
const liveVideos = new Set<HTMLVideoElement>();
function keepPlaying(video: HTMLVideoElement): void {
  video.controls = false;
  video.disablePictureInPicture = true;
  video.setAttribute('disableremoteplayback', '');
  video.addEventListener('contextmenu', (e) => e.preventDefault());
  const resume = () => {
    if (video.srcObject && video.isConnected) video.play().catch(() => {});
  };
  video.addEventListener('pause', resume);
  video.addEventListener('webkitendfullscreen', resume); // iOS native player closed
  liveVideos.add(video);
}

function resumeAllVideos(): void {
  for (const video of liveVideos) {
    if (!video.isConnected) liveVideos.delete(video);
    else if (video.paused && video.srcObject) video.play().catch(() => {});
  }
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') resumeAllVideos();
});
// Hardware media keys / lock-screen controls must not pause the call.
try {
  navigator.mediaSession?.setActionHandler('pause', () => resumeAllVideos());
  navigator.mediaSession?.setActionHandler('stop', () => resumeAllVideos());
} catch {
  // Not supported for this media in some browsers.
}
keepPlaying(localVideo);
// Opened from a notification, the browser may block call audio until the first tap.
document.addEventListener('pointerdown', resumeAllVideos);

// Our own camera tile lives in the grid with everyone else's.
remoteGrid.append(localTile);
localTile.dataset.key = cameraKey(userId);
localTile.tabIndex = 0;
localTile.setAttribute('role', 'button');
localTile.style.setProperty('--h', String(hueFor(userId)));
function paintSelfTile(): void {
  localAvatar.textContent = userId.charAt(0).toUpperCase();
  paintAvatar(localAvatar, userId);
}
paintSelfTile();

const liveVideo = (stream: MediaStream | null | undefined) =>
  stream?.getVideoTracks().some((t) => t.readyState === 'live' && !t.muted) ?? false;

/** Shows the avatar instead of a black box while a peer sends no video or has their camera off. */
function refreshTileVideo(peerId: string): void {
  const tile = tiles.get(peerId);
  if (!tile) return;
  tile.root.classList.toggle('has-video', liveVideo(tile.video.srcObject as MediaStream | null) && !cameraOffPeers.has(peerId));
}

function watchVideoTracks(peerId: string, stream: MediaStream): void {
  for (const track of stream.getVideoTracks()) {
    track.onmute = track.onunmute = track.onended = () => refreshTileVideo(peerId);
  }
  refreshTileVideo(peerId);
}

/** Puts every tile in its place: an even grid, or one maximized with the others in a strip. */
function layoutStage(): void {
  const inCall = callsInfo?.state === 'in-call';
  const others = tiles.size + screenTiles.size;
  // Alone (still ringing): our camera fills the stage behind "Calling…", if it's on.
  const selfVideo = liveVideo(localVideo.srcObject as MediaStream | null);
  localTile.hidden = !inCall || (others === 0 && !selfVideo);
  localTile.classList.toggle('has-video', selfVideo);
  stage.classList.toggle('solo', inCall && others === 0);

  for (const [ownerId, tile] of screenTiles) {
    const watching = ownerId === userId || watchedShares.has(ownerId);
    tile.root.classList.toggle('has-video', watching);
    tile.root.classList.toggle('is-watching', watching);
  }
  for (const peerId of tiles.keys()) refreshTileVideo(peerId);

  const all = [...remoteGrid.querySelectorAll<HTMLElement>(':scope > .tile:not([hidden])')];
  if (focusKey && !all.some((t) => t.dataset.key === focusKey)) focusKey = null;
  if (all.length < 2) focusKey = null; // nothing to maximize over
  for (const tile of all) {
    const focused = tile.dataset.key === focusKey;
    tile.classList.toggle('is-focused', focused);
    tile.title = focused ? 'Tap to go back to everyone' : 'Tap to maximize';
    tile.querySelector('.tile-fullscreen')?.setAttribute('title', 'Maximize and go full screen');
  }
  remoteGrid.dataset.count = String(all.length);
  stage.classList.toggle('has-focus', focusKey !== null);
  layoutBtn.hidden = focusKey === null;
  layoutBtn.title = 'Show everyone';
  layoutBtn.setAttribute('aria-label', 'Show everyone');
  stagePlaceholder.hidden = others > 0;
}

function toggleFocus(key: string | undefined): void {
  if (!key) return;
  focusKey = focusKey === key ? null : key;
  layoutStage();
}
remoteGrid.addEventListener('click', (e) => {
  const tile = (e.target as HTMLElement).closest<HTMLElement>('.tile');
  if (tile && !(e.target as HTMLElement).closest('button')) toggleFocus(tile.dataset.key);
});
remoteGrid.addEventListener('keydown', (e) => {
  const tile = (e.target as HTMLElement).closest<HTMLElement>('.tile');
  if (tile && e.target === tile && (e.key === 'Enter' || e.key === ' ')) {
    e.preventDefault();
    toggleFocus(tile.dataset.key);
  }
});
layoutBtn.addEventListener('click', () => {
  focusKey = null;
  layoutStage();
});

// ---- Full-screen call (minimize to use the rest of the app while it goes on) ----
let callMinimized = false;
function setCallMinimized(minimized: boolean): void {
  callMinimized = minimized;
  document.body.classList.toggle('call-minimized', minimized && callsInfo.state === 'in-call');
  renderCallReturn();
}
minimizeBtn.addEventListener('click', () => {
  if (document.fullscreenElement === callPanel) void document.exitFullscreen().catch(() => {});
  setCallMinimized(true);
});

/** While idle: a call we just left (rejoin it) wins over one we're in on another device (move it here). */
function callOffer(): { kind: 'rejoin'; secondsLeft: number; where: string } | { kind: 'elsewhere'; where: string } | null {
  if (callsInfo.state !== 'idle' || !calls) return null;
  const where = (c: { roomId: string | null; participants: string[] }) =>
    c.roomId ? `#${c.roomId}` : c.participants.length ? `with ${c.participants.join(', ')}` : '';
  const rejoin = calls.rejoinable;
  if (rejoin) return { kind: 'rejoin', secondsLeft: Math.max(0, Math.ceil((rejoin.until - Date.now()) / 1000)), where: where(rejoin) };
  return calls.elsewhere ? { kind: 'elsewhere', where: where(calls.elsewhere) } : null;
}

/** The floating pill: back to a minimized call, rejoin a call we just left, or take over one from another device. */
function renderCallReturn(): void {
  const inCall = callsInfo.state === 'in-call';
  const offer = callOffer();
  callReturn.hidden = !(inCall && callMinimized) && !offer;
  callReturn.classList.toggle('is-elsewhere', !inCall && !!offer);
  callReturnText.textContent = inCall
    ? 'Return to call'
    : offer?.kind === 'rejoin'
      ? `Rejoin call · ${formatDuration(offer.secondsLeft * 1000)}`
      : 'In a call on another device · Move it here';
}
callReturn.addEventListener('click', () => {
  if (callsInfo.state === 'in-call') {
    setCallMinimized(false);
    tabs.show('call');
  } else takeCallOffer();
});

function takeCallOffer(): void {
  const offer = callOffer();
  if (!offer) return;
  tabs.show('call');
  if (offer.kind === 'rejoin') void calls.rejoin(cameraPref);
  else void calls.moveHere(cameraPref);
}
moveCallBtn.addEventListener('click', takeCallOffer);

/** Counts down the minute we have to rejoin. */
let offerTimer: ReturnType<typeof setInterval> | undefined;
function renderElsewhere(): void {
  const offer = callOffer();
  elsewhereBanner.hidden = !offer;
  if (offer?.kind === 'rejoin') {
    elsewhereText.textContent = `You left the call ${offer.where} · ${offer.secondsLeft}s to rejoin`;
    moveCallBtn.textContent = 'Rejoin';
  } else if (offer) {
    elsewhereText.textContent = `In a call ${offer.where} on another device`;
    moveCallBtn.textContent = 'Move call here';
  }
  if (offer?.kind === 'rejoin' && !offerTimer) offerTimer = setInterval(renderElsewhere, 1000);
  else if (offer?.kind !== 'rejoin' && offerTimer) {
    clearInterval(offerTimer);
    offerTimer = undefined;
  }
  renderCallReturn();
}

// ---- Camera flip (front ↔ back) ----
async function refreshFlipButton(): Promise<void> {
  const show = callsInfo.state === 'in-call' && !!calls?.isCameraOn;
  flipBtn.hidden = !(show && (await calls.canFlipCamera()));
}
flipBtn.addEventListener('click', async () => {
  flipBtn.disabled = true;
  try {
    await calls.flipCamera();
  } finally {
    flipBtn.disabled = false;
  }
});

// ---- Calls ----
let callsInfo: CallInfo = { ...IDLE_CALL };
type CallMode = 'user' | 'room';
let callMode: CallMode = 'user';

const calls = new CallManager(socket, userId, iceServers, {
  onStateChange: renderCallState,
  onLocalStream: (stream) => {
    localVideo.srcObject = stream;
    // Our own front camera is shown mirrored (like a mirror); the back camera isn't.
    localTile.classList.toggle('is-mirrored', calls?.cameraFacing !== 'environment');
    for (const track of stream?.getVideoTracks() ?? []) track.onended = track.onmute = track.onunmute = () => layoutStage();
    layoutStage();
    void refreshFlipButton();
  },
  onFacingChange: (facing) => localTile.classList.toggle('is-mirrored', facing === 'user'),
  onElsewhere: renderElsewhere,
  onRejoinable: renderElsewhere,
  onPeerStream: (peerId, stream) => {
    const tile = ensureTile(peerId);
    if (tile.video.srcObject !== stream) tile.video.srcObject = stream;
    tile.video.play().catch(() => {});
    watchVideoTracks(peerId, stream);
  },
  onPeerScreenStream: (peerId, stream) => {
    peerScreenStreams.set(peerId, stream);
    const tile = screenTiles.get(peerId);
    if (tile && tile.video.srcObject !== stream) tile.video.srcObject = stream;
  },
  onPeerConnectionState: (peerId, state) => {
    const tile = tiles.get(peerId);
    if (!tile) return;
    const labels: Partial<Record<RTCPeerConnectionState, string>> = {
      new: 'Connecting…',
      connecting: 'Connecting…',
      disconnected: 'Reconnecting…',
      failed: 'Connection failed',
    };
    tile.status.textContent = labels[state] ?? '';
    tile.root.dataset.conn = state;
  },
  onPeerRemoved: removeTile,
  onPeerScreen: (peerId, sharing) => {
    const wasSharing = sharingPeers.has(peerId);
    setPeerSharing(peerId, sharing);
    if (sharing && !wasSharing) toast(`${peerId} is sharing their screen. Press “Watch stream” to see it.`);
  },
  onPeerCamera: (peerId, on) => {
    if (on) cameraOffPeers.delete(peerId);
    else cameraOffPeers.add(peerId);
    refreshTileVideo(peerId);
  },
  onLocalScreen: (stream) => {
    const sharing = stream !== null;
    setButtonLabel(shareBtn, sharing ? 'Stop sharing' : 'Share screen', sharing);
    shareBtn.classList.toggle('active', sharing);
    // Our screen gets a tile of its own (a preview of what everyone can watch); our camera stays on.
    if (stream) ensureScreenTile(userId).video.srcObject = stream;
    else removeScreenTile(userId);
    layoutStage();
  },
  onIncoming: (from, video, participants, roomId) => {
    showPerson(incomingAvatar, from);
    incomingText.textContent = roomId
      ? `${from} invited you to room #${roomId}`
      : `${from} is ${video ? 'video' : 'voice'} calling you`;
    // Answer however you like; the caller's choice is just the highlighted default.
    acceptVideoBtn.className = `btn ${video ? 'btn-success' : 'btn-secondary'}`;
    acceptAudioBtn.className = `btn ${video ? 'btn-secondary' : 'btn-success'}`;
    const others = participants.filter((p) => p !== from);
    incomingSub.textContent = others.length ? `With ${others.join(', ')}` : '';
    tabs.show('call');
    if (tryAutoAnswer()) return;
    if (!incomingDialog.open) incomingDialog.showModal();
    navigator.vibrate?.([400, 200, 400, 200, 400]);
  },
  onNotice: (message, kind) => toast(message, kind),
});

/** Fills a big avatar (`.avatar[data-hue]`) with someone's picture or initial; null hides it. */
function showPerson(node: HTMLElement, id: string | null): void {
  node.hidden = id === null;
  if (id === null) {
    delete node.dataset.person;
    return;
  }
  node.dataset.person = id;
  node.textContent = id.charAt(0).toUpperCase();
  node.style.setProperty('--h', String(hueFor(id)));
  paintAvatar(node, id);
}

function renderCallState(info: CallInfo): void {
  const wasIdle = callsInfo.state === 'idle';
  callsInfo = info;
  const { state, roomId, participants, invited, away, incomingFrom } = info;
  // Android app: a call keeps running in the background (foreground service + call notification).
  nativeBridge?.callState(JSON.stringify({ state, video: info.video, peers: participants, roomId }));

  stage.dataset.state = state;
  document.body.classList.toggle('in-call', state === 'in-call');
  // A new call opens full screen; minimizing lasts until it ends.
  if (wasIdle && state === 'in-call') callMinimized = false;
  document.body.classList.toggle('call-minimized', state === 'in-call' && callMinimized);
  minimizeBtn.hidden = state !== 'in-call';
  // The call ended (or we minimized it): leave full screen.
  if (state !== 'in-call' && document.fullscreenElement === callPanel) void document.exitFullscreen().catch(() => {});
  renderStageFullscreen();
  const inCall = state === 'in-call';
  const idle = state === 'idle';

  // Idle: choose "call a user" or "join a room". In a call: the dial form adds people.
  callModeSwitch.hidden = !idle;
  callRoomForm.hidden = !idle || callMode !== 'room';
  dialForm.hidden = idle && callMode !== 'user';
  callBtn.textContent = inCall ? 'Add to call' : 'Call';
  for (const button of camPrefBtns) button.hidden = inCall;
  targetInput.disabled = state === 'incoming';
  callBtn.disabled = state === 'incoming' || !socket.connected;
  roomJoinBtn.disabled = !socket.connected;
  targetInput.placeholder = inCall ? 'User ID to add' : 'User ID to call';

  roomBanner.hidden = !(inCall && roomId);
  roomBannerId.textContent = roomId ? `#${roomId}` : '';

  callControls.hidden = !inCall;
  shareBtn.hidden = !canShareScreen();

  let status: string;
  if (idle) status = socket.connected ? 'Ready' : hasConnected ? 'Offline' : 'Connecting…';
  else if (state === 'incoming') status = `Incoming call from ${incomingFrom}`;
  else if (participants.length === 0 && away.length) status = `${away.join(', ')} left · waiting a minute for them to rejoin…`;
  else if (roomId && participants.length === 0) status = `Waiting in #${roomId} — share the invite link`;
  else if (participants.length === 0) status = invited.length ? `Calling ${invited.join(', ')}…` : 'Starting call…';
  else {
    status = `${roomId ? `#${roomId}` : 'In call'} · ${participants.length + 1} people`;
    if (invited.length) status += ` · ringing ${invited.join(', ')}`;
    if (away.length) status += ` · waiting for ${away.join(', ')}`;
  }
  callStatus.textContent = status;
  stagePlaceholderText.textContent = idle
    ? callMode === 'room'
      ? 'Enter a room ID. Everyone who joins the same ID is in the same call.'
      : 'Pick someone from the online list, or type their ID, then press call.'
    : status;
  // Ringing someone (nobody in the call yet): show who we're calling.
  const callee = inCall && !roomId && participants.length === 0 && invited.length === 1 ? invited[0] : null;
  showPerson(stageCallee, callee);
  stagePlaceholder.classList.toggle('has-callee', callee !== null);

  if (state !== 'incoming' && incomingDialog.open) incomingDialog.close();
  if (state === 'idle') {
    setButtonLabel(micBtn, 'Mute', false);
    setButtonLabel(camBtn, 'Camera', false);
    micBtn.classList.remove('active');
    camBtn.classList.remove('active');
    cameraOffPeers.clear();
    for (const peerId of [...tiles.keys()]) removeTile(peerId);
    for (const ownerId of [...screenTiles.keys()]) removeScreenTile(ownerId);
    sharingPeers.clear();
    watchedShares.clear();
    peerScreenStreams.clear();
    focusKey = null;
  }
  micBtn.disabled = !calls?.hasLocalTrack('audio');
  // In a call without microphone access: show the slashed mic, not a "Mute" that does nothing.
  if (inCall && micBtn.disabled) setButtonLabel(micBtn, 'No mic', true);
  camBtn.disabled = !inCall;
  if (inCall && calls) renderCameraButton(calls.isCameraOn);
  renderTimer(info);

  if (wasIdle && state !== 'idle') tabs.show('call');
  layoutStage();
  renderElsewhere();
  void refreshFlipButton();
  updateCallBadge();
  renderUsers();
  updates.refresh();
}

// ---- Call timer ----
// Counts from when someone else first joins until we leave the call.
let connectedSince: number | null = null;
let timerInterval: ReturnType<typeof setInterval> | undefined;

function tickTimer(): void {
  if (connectedSince !== null) callTimer.textContent = formatDuration(Date.now() - connectedSince);
}

function renderTimer(info: CallInfo): void {
  if (info.state === 'in-call' && info.participants.length > 0 && connectedSince === null) {
    connectedSince = Date.now();
    timerInterval = setInterval(tickTimer, 1000);
  } else if (info.state !== 'in-call' && connectedSince !== null) {
    connectedSince = null;
    clearInterval(timerInterval);
  }
  callTimer.hidden = connectedSince === null;
  tickTimer();
}

function updateCallBadge(): void {
  tabs.setBadge('call', callsInfo.state === 'in-call' && !tabs.isVisible('call') ? '●' : null);
}

/** Calls the ID in the dial box (camera per the toggle), or adds them to the current call. */
function startCall(): void {
  const to = targetInput.value.trim();
  if (!isValidUserId(to)) {
    toast('Enter a valid user ID to call.', 'error');
    targetInput.focus();
    return;
  }
  if (to.toLowerCase() === userId.toLowerCase()) {
    toast('You cannot call yourself.', 'error');
    return;
  }
  if (!socket.connected) {
    toast(NOT_CONNECTED, 'error'); // keep the typed ID for when the connection is back
    return;
  }
  targetInput.value = '';
  if (tabs.isPhone) tabs.show('call');
  void calls.startCall(to, cameraPref);
}

dialForm.addEventListener('submit', (e) => {
  e.preventDefault();
  startCall();
});
// ---- Call rooms (join by room ID) ----
function setCallMode(mode: CallMode): void {
  callMode = mode;
  for (const button of callModeSwitch.querySelectorAll<HTMLButtonElement>('button[data-mode]')) {
    const selected = button.dataset.mode === mode;
    button.classList.toggle('active', selected);
    button.setAttribute('aria-selected', String(selected));
  }
  renderCallState(callsInfo);
}
callModeSwitch.addEventListener('click', (e) => {
  const button = (e.target as HTMLElement).closest<HTMLButtonElement>('button[data-mode]');
  if (button) setCallMode(button.dataset.mode as CallMode);
});

function joinCallRoom(): void {
  const roomId = callRoomInput.value.trim();
  if (!isValidRoomId(roomId)) {
    toast(`Enter a valid room ID (${ROOM_ID_RULES})`, 'error');
    callRoomInput.focus();
    return;
  }
  if (tabs.isPhone) tabs.show('call');
  // An invite link's key (see prefillCallRoomFromUrl) is used once, for the room it came with.
  const key = pendingCallKey?.roomId === roomId.toLowerCase() ? pendingCallKey.key : undefined;
  pendingCallKey = null;
  void calls.joinRoom(roomId, cameraPref, key);
}
let pendingCallKey: { roomId: string; key: string } | null = null;
callRoomForm.addEventListener('submit', (e) => {
  e.preventDefault();
  joinCallRoom();
});

// "Invite": pick friends to ring into the room's call; the link is copied for anyone else.
copyLinkBtn.addEventListener('click', () => {
  if (callsInfo.roomId) share.open(callsInfo.roomId, true);
});

// ---- Answering from a call notification ----
// The notification opens `/app?answer=<callId>` (or messages an open window). The server
// re-sends the still-ringing invite when we connect, and we accept it without a dialog.
let pendingAnswer: { callId: string; expires: number } | null = null;

function setPendingAnswer(href: string): void {
  const callId = new URL(href, window.location.origin).searchParams.get('answer');
  if (!callId || !/^[0-9a-f-]{36}$/i.test(callId)) return;
  pendingAnswer = { callId, expires: Date.now() + 60_000 };
  tabs.show('call');
  if (!tryAutoAnswer() && socket.connected) {
    // Already connected and the invite isn't here: it stopped ringing meanwhile.
    setTimeout(() => {
      if (pendingAnswer?.callId === callId) {
        pendingAnswer = null;
        toast('That call is no longer ringing.');
      }
    }, 3000);
  }
}

/** @returns whether the incoming call was the one the user chose to answer from the notification. */
function tryAutoAnswer(): boolean {
  if (!pendingAnswer || pendingAnswer.expires < Date.now()) {
    pendingAnswer = null;
    return false;
  }
  if (callsInfo.state !== 'incoming' || callsInfo.callId !== pendingAnswer.callId) return false;
  pendingAnswer = null;
  if (incomingDialog.open) incomingDialog.close();
  void calls.acceptIncoming();
  return true;
}

/** `/app?call=xyz` (an invite link) prefills the room; joining needs a tap (camera + audio autoplay). */
function prefillCallRoomFromUrl(href = window.location.href): void {
  const params = new URL(href, window.location.origin).searchParams;
  const room = params.get('call');
  if (!room || !isValidRoomId(room)) return;
  const key = params.get('key');
  pendingCallKey = key ? { roomId: room.toLowerCase(), key } : null;
  callRoomInput.value = room;
  setCallMode('room');
  tabs.show('call');
  toast(`Press Join to enter room #${room.toLowerCase()}.`, 'info', 6000);
  history.replaceState(null, '', '/app');
}

hangupBtn.addEventListener('click', () => calls.hangUp());
micBtn.addEventListener('click', () => {
  const on = calls.toggleMic();
  setButtonLabel(micBtn, on ? 'Mute' : 'Unmute', !on);
  micBtn.classList.toggle('active', !on);
});
function renderCameraButton(on: boolean): void {
  setButtonLabel(camBtn, on ? 'Camera' : 'Camera off', !on);
  camBtn.classList.toggle('active', !on);
  camBtn.title = on ? 'Turn camera off' : 'Turn camera on';
}
camBtn.addEventListener('click', async () => {
  camBtn.disabled = true; // asking for the camera can take a moment (permission prompt)
  try {
    renderCameraButton(await calls.toggleCamera());
  } finally {
    camBtn.disabled = callsInfo.state !== 'in-call';
    void refreshFlipButton();
  }
});
shareBtn.addEventListener('click', () => {
  if (calls.isSharingScreen) void calls.stopScreenShare();
  else void calls.startScreenShare();
});
acceptVideoBtn.addEventListener('click', () => {
  incomingDialog.close();
  void calls.acceptIncoming(true);
});
acceptAudioBtn.addEventListener('click', () => {
  incomingDialog.close();
  void calls.acceptIncoming(false);
});
rejectBtn.addEventListener('click', () => {
  incomingDialog.close();
  calls.rejectIncoming();
});
// Escape key closes the dialog — treat it as a rejection.
incomingDialog.addEventListener('cancel', () => calls.rejectIncoming());

// ---- Call history ----
const callHistory = new CallHistoryPanel(socket, (entry) => {
  if (callsInfo.state === 'incoming') {
    toast('Answer or decline the incoming call first.', 'error');
    return;
  }
  if (entry.roomId) {
    if (callsInfo.state !== 'idle') {
      toast('Leave the current call first.', 'error');
      return;
    }
    callRoomInput.value = entry.roomId;
    setCallMode('room');
    joinCallRoom();
  } else {
    setCallMode('user');
    targetInput.value = entry.peers[0];
    startCall();
  }
});

// ---- People panel views: Online / Friends / Rooms / Recent ----
type PeopleView = 'online' | 'friends' | 'rooms' | 'recent';
const peopleSwitch = $('#people-views');
function showPeopleView(view: PeopleView): void {
  for (const button of peopleSwitch.querySelectorAll<HTMLButtonElement>('button[data-view]')) {
    const selected = button.dataset.view === view;
    button.classList.toggle('active', selected);
    button.setAttribute('aria-selected', String(selected));
  }
  for (const panel of document.querySelectorAll<HTMLElement>('.people-view')) panel.hidden = panel.dataset.view !== view;
}
peopleSwitch.addEventListener('click', (e) => {
  const button = (e.target as HTMLElement).closest<HTMLButtonElement>('button[data-view]');
  if (button) showPeopleView(button.dataset.view as PeopleView);
});

// ---- Friends ----
const friendsCount = $('#friends-count');
friends = new FriendsPanel(socket, userId, {
  presenceOf: (id) => lastUsers.find((u) => u.id.toLowerCase() === id.toLowerCase())?.presence ?? 'away',
  onCall: (id) => {
    setCallMode('user');
    targetInput.value = id;
    startCall();
  },
  onMessage: (id) => {
    chat.openDm(id);
    tabs.show('chat');
  },
  onChange: (state) => {
    friendsCount.hidden = state.incoming.length === 0;
    friendsCount.textContent = String(state.incoming.length);
    renderUsers();
  },
});

// ---- Rooms directory ----
function joinRoomCall(roomId: string, key?: string): void {
  if (callsInfo.state !== 'idle') {
    toast('Leave the current call first.', 'error');
    return;
  }
  callRoomInput.value = roomId;
  if (key) pendingCallKey = { roomId: roomId.toLowerCase(), key };
  setCallMode('room');
  joinCallRoom();
}

const rooms = new RoomsPanel(socket, userId, {
  onOpenChat: (roomId) => {
    chat.join(roomId);
    tabs.show('chat');
  },
  onJoinCall: (roomId) => joinRoomCall(roomId),
  onShare: (roomId) => share.open(roomId, false),
  onMembers: (roomId) => roomMembers.open(roomId),
});
const roomMembers = new RoomMembersDialog(socket);
const joinDialog = new JoinDialog(socket);

// ---- Sharing rooms: to friends in the app, or by link (copied automatically) ----
const share = new ShareDialog(socket, {
  friends: () => friends?.current.friends ?? [],
  presenceOf: (id) => lastUsers.find((u) => u.id.toLowerCase() === id.toLowerCase())?.presence ?? 'away',
  keyOf: (roomId) => rooms.find(roomId)?.key,
});

/** A friend shared a room with us: a small card to open it (or join its call) right away. */
const invitesEl = el('div', { className: 'invite-stack' });
document.body.append(invitesEl);
/** A card from someone (a shared room, a mention) with an action button and "Later". */
function showCard(from: string, text: string, actionLabel: string, onAction: () => void, detail?: string): void {
  const open = el('button', { className: 'btn btn-primary btn-small', text: actionLabel });
  open.type = 'button';
  const dismiss = el('button', { className: 'btn btn-ghost btn-small', text: 'Later' });
  dismiss.type = 'button';
  const body = el('span', { className: 'invite-text', text });
  if (detail) body.append(el('span', { className: 'invite-detail', text: detail }));
  const card = el('div', { className: 'invite-card' }, [avatar(from), body, el('span', { className: 'invite-actions' }, [dismiss, open])]);
  card.setAttribute('role', 'status');
  open.addEventListener('click', () => {
    card.remove();
    onAction();
  });
  dismiss.addEventListener('click', () => card.remove());
  invitesEl.append(card);
  // Keep the stack short: drop the oldest.
  while (invitesEl.children.length > 3) invitesEl.firstElementChild?.remove();
  navigator.vibrate?.(150);
}

socket.on('rooms:shared', ({ from, roomId, call, key }) => {
  const text = call ? `${from} invites you to the call in #${roomId}` : `${from} shared #${roomId} with you`;
  showCard(from, text, call ? 'Join call' : 'Open', () => {
    if (call) {
      joinRoomCall(roomId, key);
    } else {
      chat.join(roomId, false, key);
      tabs.show('chat');
    }
  });
});

// Tagged with @: a card unless we're already looking at that room's chat (the message is highlighted there).
socket.on('chat:mention', ({ from, roomId, text }) => {
  if (chat.room === roomId && tabs.isVisible('chat') && document.visibilityState === 'visible') return;
  showCard(from, `${from} mentioned you in #${roomId}`, 'Open', () => {
    if (chat.room !== roomId) chat.join(roomId);
    tabs.show('chat');
  }, text);
});

// Back from linking Google in Settings.
if (new URLSearchParams(window.location.search).get('google') === 'linked') {
  toast('Google account linked. You can sign in with Google from now on.', 'success', 6000);
  history.replaceState(null, '', '/app');
}

/** `/app?friends=1` (from a friend-request notification) opens the Friends list. */
function showFriendsFromUrl(href: string): boolean {
  if (!new URL(href, window.location.origin).searchParams.has('friends')) return false;
  showPeopleView('friends');
  tabs.show('users');
  if (window.location.search) history.replaceState(null, '', '/app');
  return true;
}
showFriendsFromUrl(window.location.href);

// ---- Chat ----
const customEmoji = new CustomEmojiStore(socket);
// The Chat tab badge is the unread total across all our rooms (kept by the chat list).
const chat = new ChatPanel(socket, userId, customEmoji, (total) =>
  tabs.setBadge('chat', total > 99 ? '99+' : total || null),
);
chat.isOnScreen = () => tabs.isVisible('chat') && document.visibilityState === 'visible';
document.addEventListener('visibilitychange', () => chat.markRead());
// `@` suggestions beyond the room: friends first, then everyone online.
chat.mentionCandidates = () => [...(friends?.current.friends ?? []), ...lastUsers.map((u) => u.id)];
// Joining is permanent (it stays in the list, with notifications, until we leave), so show the room and ask first.
chat.beforeJoin = async (roomId, key) => {
  if (isDmRoomId(roomId)) return true; // a chat with a friend (the server checks you're friends)
  if (rooms.find(roomId)?.owner.toLowerCase() === userId.toLowerCase()) return true;
  return joinDialog.open(roomId, key);
};
// The room part of a chat's ⚙ Settings (share; for the owner: visibility, members, delete).
chat.roomSettings = (roomId, close) => rooms.settingsFor(roomId, close);
// Leaving an invite-only room you don't own means needing its link to come back.
chat.beforeLeave = (roomId) => {
  const room = rooms.find(roomId);
  if (!room || room.visibility !== 'link' || room.owner.toLowerCase() === userId.toLowerCase()) return true;
  return window.confirm(`Leave #${roomId}? It's invite-only: you'll need its link to come back.`);
};

tabs.onChange((tab) => {
  if (tab === 'chat') chat.markRead();
  updateCallBadge();
});

/** `/app?room=xyz` (e.g. from a chat notification) opens that room. */
/** @returns whether the URL named a room to open. */
function joinRoomFromUrl(href: string): boolean {
  const params = new URL(href, window.location.origin).searchParams;
  const room = params.get('room');
  if (!room || !isValidRoomId(room)) return false;
  chat.join(room, false, params.get('key') ?? undefined); // the key lets us into invite-only rooms
  tabs.show('chat');
  if (window.location.search) history.replaceState(null, '', '/app');
  return true;
}

// ---- Notifications (PWA push) ----
function renderPushStatus(status: PushStatus): void {
  notifyBtn.hidden = status === 'unsupported';
  notifyBtn.dataset.status = status;
  const titles: Record<PushStatus, string> = {
    unsupported: '',
    'needs-install': 'Add to Home Screen to enable notifications',
    denied: 'Notifications are blocked in your browser settings',
    off: 'Enable notifications for calls and messages',
    on: 'Notifications on — click to turn off',
  };
  notifyBtn.title = titles[status];
  notifyBtn.setAttribute('aria-label', titles[status]);
  notifyBtn.setAttribute('aria-pressed', String(status === 'on'));
  renderNotifyBanner(status);
}

// In the installed app, ask once (until dismissed) to turn notifications on — without
// them, calls and messages can't reach the phone while the app is closed.
const BANNER_DISMISSED_KEY = 'call9me:notifyBannerDismissed';
function renderNotifyBanner(status: PushStatus): void {
  let dismissed = false;
  try {
    dismissed = localStorage.getItem(BANNER_DISMISSED_KEY) === '1';
  } catch {
    /* show it */
  }
  notifyBanner.hidden = !(status === 'off' && isStandalone() && !dismissed);
}
$('#notify-banner-enable').addEventListener('click', () => notifyBtn.click());
$('#notify-banner-dismiss').addEventListener('click', () => {
  notifyBanner.hidden = true;
  try {
    localStorage.setItem(BANNER_DISMISSED_KEY, '1');
  } catch {
    /* hidden for this visit only */
  }
});

notifyBtn.addEventListener('click', async () => {
  const status = notifyBtn.dataset.status as PushStatus;
  try {
    if (status === 'needs-install') {
      toast('On iPhone/iPad: tap Share → "Add to Home Screen", then open Call9me from your home screen.', 'info', 8000);
    } else if (status === 'denied') {
      toast('Notifications are blocked. Allow them in your browser/site settings.', 'error', 6000);
    } else if (status === 'on') {
      notifyMenu.hidden = !notifyMenu.hidden;
    } else {
      const next = await push.enable();
      renderPushStatus(next);
      toast(next === 'on' ? 'Notifications on. You will be alerted to calls and messages.' : 'Notifications were not allowed.',
        next === 'on' ? 'success' : 'error');
    }
  } catch (err) {
    console.error(err);
    toast('Could not change notification settings.', 'error');
  }
});

// Bell menu (when notifications are on): send a test, or turn them off.
const notifyMenu = $('#notify-menu');
document.addEventListener('click', (e) => {
  if (!notifyMenu.hidden && !(e.target as HTMLElement).closest('#notify-menu, #notify-btn')) notifyMenu.hidden = true;
});
$('#notify-test-btn').addEventListener('click', async () => {
  notifyMenu.hidden = true;
  try {
    // A subscription made with an old server key is always rejected (Apple: BadJwtToken).
    if (await push.repair().catch(() => false)) toast('Re-registered this device for notifications.', 'success');
    const res = await fetch('/api/push/test', { method: 'POST' });
    const data: { ok: boolean; results?: PushTestResult[] } = await res.json();
    const results = data.results ?? [];
    if (results.length === 0) {
      toast('This device is not subscribed. Turn notifications off and on again.', 'error', 7000);
      renderPushStatus(await push.status());
    } else if (data.ok) {
      toast(`Test sent to ${results.length} device${results.length > 1 ? 's' : ''}. It should appear in a few seconds.`, 'success', 6000);
    } else {
      const failed = results.filter((r) => !r.ok);
      const badJwt = failed.some((r) => /BadJwtToken/i.test(r.error ?? ''));
      toast(
        `Push rejected by ${failed.map((r) => `${r.service} (${r.status}${r.error ? `: ${r.error}` : ''})`).join(', ')}` +
          (badJwt
            ? ' — check VAPID_SUBJECT in .env (a real mailto: or https: address) and that the server clock is correct.'
            : ''),
        'error',
        15000,
      );
    }
  } catch {
    toast('Could not send a test notification.', 'error');
  }
});
$('#notify-off-btn').addEventListener('click', async () => {
  notifyMenu.hidden = true;
  renderPushStatus(await push.disable());
  toast('Notifications turned off.');
});

navigator.serviceWorker?.addEventListener('message', (event: MessageEvent<{ type?: string; url?: string }>) => {
  if (event.data?.type !== 'open-url' || !event.data.url) return;
  if (showFriendsFromUrl(event.data.url)) return;
  joinRoomFromUrl(event.data.url);
  prefillCallRoomFromUrl(event.data.url); // a shared call room (`?call=…`)
  setPendingAnswer(event.data.url);
  if (!new URL(event.data.url, window.location.origin).searchParams.has('room')) tabs.show('call');
});

void push.init().then(renderPushStatus);

// ---- Recovery email (for "Forgot your PIN?") ----
const recoveryEmail = new RecoveryEmailDialog();
$('#recovery-email-btn').addEventListener('click', () => {
  setSettingsOpen(false);
  void recoveryEmail.open();
});

// ---- Signing in other devices (QR code) ----
const linkDevice = new LinkDeviceDialog(userId);
$('#link-device-btn').addEventListener('click', () => {
  setSettingsOpen(false);
  linkDevice.open();
});
// Opened from the QR code's link (e.g. scanned with a phone's camera app while signed in there).
const pairParam = new URLSearchParams(window.location.search).get('pair');
if (pairParam) {
  linkDevice.open(pairParam);
  history.replaceState(null, '', '/app');
}

// ---- Sign out ----
$('#leave-btn').addEventListener('click', async () => {
  calls.hangUp();
  socket.disconnect();
  try {
    localStorage.removeItem('call9me:lastRoom');
  } catch {
    /* ignore */
  }
  await push.detach();
  await fetch('/api/logout', { method: 'POST' }).catch(() => {});
  window.location.href = '/';
});
window.addEventListener('pagehide', () => calls.hangUp());

// ---- Android app (android/): its call screen, call notification and background handling ----
onNativeCommands({
  answer: (callId) => setPendingAnswer(`/app?answer=${encodeURIComponent(callId)}`),
  hangUp: () => calls.hangUp(),
  // In the background (and not in a call) the app goes quiet: calls then ring through the
  // app's own notifications (Firebase), not this page, so they don't ring twice.
  background: (away) => {
    if (away) {
      if (callsInfo.state === 'in-call' || !socket.connected) return;
      pausedInBackground = true;
      socket.disconnect();
      renderConnection();
    } else if (!socket.connected) {
      reconnectNow();
    }
  },
});
window.matchMedia('(max-width: 720px)').addEventListener('change', updateCallBadge);

renderCallState(callsInfo);
if (new URL(window.location.href).searchParams.has('answer')) {
  setPendingAnswer(window.location.href);
  history.replaceState(null, '', '/app');
}
socket.connect();
