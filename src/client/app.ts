import { io } from 'socket.io-client';
import { CONNECT_ERRORS, type OnlineUserSummary, type PushTestResult, type UserStatus } from '../shared/types';
import { isValidRoomId, isValidUserId, MAX_AVATAR_BYTES, ROOM_ID_RULES } from '../shared/validation';
import { CallManager, canShareScreen, IDLE_CALL, type CallInfo } from './lib/CallManager';
import { CallHistoryPanel } from './lib/CallHistoryPanel';
import { ChatPanel } from './lib/ChatPanel';
import { CustomEmojiStore } from './lib/emoji';
import { FriendsPanel } from './lib/FriendsPanel';
import { RoomsPanel } from './lib/RoomsPanel';
import { ShareDialog } from './lib/ShareDialog';
import { $, avatar, avatarUrlOf, el, formatDuration, hueFor, onAvatarsChange, paintAvatar, setAvatarUrls, toast } from './lib/dom';
import { squareImage } from './lib/images';
import { MobileTabs } from './lib/MobileTabs';
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
const localVideo = $<HTMLVideoElement>('#local-video');
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
let takenRetries = 0;
let hasConnected = false;

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
  for (const [peerId, tile] of tiles) paintAvatar(tile.root.querySelector<HTMLElement>('.tile-avatar')!, peerId);
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
    toast('Reconnected', 'success');
    chat.rejoin();
  } else {
    prefillCallRoomFromUrl();
    if (!joinRoomFromUrl(window.location.href)) chat.restoreLastRoom();
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
  if (calls.state !== 'idle') toast('Lost connection to server — call ended.', 'error');
  calls.reset();
  // The server closed this connection itself, so socket.io won't retry on its own.
  if (reason === 'io server disconnect') socket.connect();
  renderConnection();
});

socket.on('connect_error', (err) => {
  if (err.message === CONNECT_ERRORS.UNAUTHORIZED) {
    window.location.replace('/?error=session');
  } else if (err.message === CONNECT_ERRORS.ID_TAKEN) {
    // After a page refresh the old connection may take a moment to be released.
    if (takenRetries++ < 3) setTimeout(() => socket.connect(), 1000);
    else window.location.replace('/?error=taken');
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

// ---- Participant tiles ----
interface Tile {
  root: HTMLElement;
  video: HTMLVideoElement;
  status: HTMLElement;
}
const tiles = new Map<string, Tile>();
const sharingPeers = new Set<string>();
/** Peers who switched their camera off (their video track may not report "muted" right away). */
const cameraOffPeers = new Set<string>();

function ensureTile(peerId: string): Tile {
  let tile = tiles.get(peerId);
  if (tile) return tile;

  const video = el('video');
  video.autoplay = true;
  video.playsInline = true;
  keepPlaying(video);
  const status = el('span', { className: 'tile-status', text: 'Connecting…' });
  const fullscreenBtn = el('button', { className: 'tile-fullscreen', title: 'Full screen', text: '⤢' });
  fullscreenBtn.type = 'button';
  fullscreenBtn.addEventListener('click', () => enterFullscreen(root, video));

  const tileAvatar = el('div', { className: 'tile-avatar', text: peerId.charAt(0).toUpperCase() });
  paintAvatar(tileAvatar, peerId); // their profile picture while their camera is off
  const root = el('div', { className: 'tile' }, [
    tileAvatar,
    video,
    el('div', { className: 'tile-label' }, [el('span', { className: 'tile-name', text: peerId }), status]),
    fullscreenBtn,
  ]);
  root.dataset.peer = peerId;
  root.style.setProperty('--h', String(hueFor(peerId)));
  remoteGrid.append(root);
  tile = { root, video, status };
  tiles.set(peerId, tile);
  layoutStage();
  return tile;
}

function removeTile(peerId: string): void {
  tiles.get(peerId)?.root.remove();
  tiles.delete(peerId);
  sharingPeers.delete(peerId);
  layoutStage();
}

/**
 * Full screen on the tile itself (no native player, so no pause button). iPhone Safari
 * only supports native video full screen; `keepPlaying` resumes it if paused there.
 */
function enterFullscreen(tile: HTMLElement, video: HTMLVideoElement): void {
  const v = video as HTMLVideoElement & { webkitEnterFullscreen?: () => void };
  if (tile.requestFullscreen) tile.requestFullscreen().catch(() => v.webkitEnterFullscreen?.());
  else v.webkitEnterFullscreen?.();
}

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

/** Shows the avatar instead of a black box while a peer sends no video or has their camera off. */
function refreshTileVideo(peerId: string): void {
  const tile = tiles.get(peerId);
  const stream = tile?.video.srcObject as MediaStream | null | undefined;
  if (!tile || !stream) return;
  const receiving = stream.getVideoTracks().some((t) => t.readyState === 'live' && !t.muted);
  tile.root.classList.toggle('has-video', receiving && (sharingPeers.has(peerId) || !cameraOffPeers.has(peerId)));
}

function watchVideoTracks(peerId: string, stream: MediaStream): void {
  for (const track of stream.getVideoTracks()) {
    track.onmute = track.onunmute = track.onended = () => refreshTileVideo(peerId);
  }
  refreshTileVideo(peerId);
}

function layoutStage(): void {
  remoteGrid.dataset.count = String(tiles.size);
  const someoneSharing = sharingPeers.size > 0;
  stage.classList.toggle('has-screen', someoneSharing);
  for (const [peerId, tile] of tiles) {
    tile.root.classList.toggle('is-sharing', sharingPeers.has(peerId));
    refreshTileVideo(peerId);
  }
  stagePlaceholder.hidden = tiles.size > 0;
}

// ---- Calls ----
let callsInfo: CallInfo = { ...IDLE_CALL };
type CallMode = 'user' | 'room';
let callMode: CallMode = 'user';

const calls = new CallManager(socket, userId, iceServers, {
  onStateChange: renderCallState,
  onLocalStream: (stream, isScreen) => {
    localVideo.srcObject = stream;
    localVideo.hidden = !stream || stream.getVideoTracks().length === 0;
    localVideo.classList.toggle('is-screen', isScreen);
  },
  onPeerStream: (peerId, stream) => {
    const tile = ensureTile(peerId);
    if (tile.video.srcObject !== stream) tile.video.srcObject = stream;
    tile.video.play().catch(() => {});
    watchVideoTracks(peerId, stream);
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
    if (sharing) sharingPeers.add(peerId);
    else sharingPeers.delete(peerId);
    layoutStage();
    if (sharing && tabs.isPhone) tabs.show('call');
  },
  onPeerCamera: (peerId, on) => {
    if (on) cameraOffPeers.delete(peerId);
    else cameraOffPeers.add(peerId);
    refreshTileVideo(peerId);
  },
  onLocalScreen: (sharing) => {
    setButtonLabel(shareBtn, sharing ? 'Stop sharing' : 'Share screen', sharing);
    shareBtn.classList.toggle('active', sharing);
    camBtn.disabled = sharing;
  },
  onIncoming: (from, video, participants, roomId) => {
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

function renderCallState(info: CallInfo): void {
  const wasIdle = callsInfo.state === 'idle';
  callsInfo = info;
  const { state, roomId, participants, invited, incomingFrom } = info;

  stage.dataset.state = state;
  document.body.classList.toggle('in-call', state === 'in-call');
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
  else if (roomId && participants.length === 0) status = `Waiting in #${roomId} — share the invite link`;
  else if (participants.length === 0) status = invited.length ? `Calling ${invited.join(', ')}…` : 'Starting call…';
  else {
    status = `${roomId ? `#${roomId}` : 'In call'} · ${participants.length + 1} people`;
    if (invited.length) status += ` · ringing ${invited.join(', ')}`;
  }
  callStatus.textContent = status;
  stagePlaceholder.textContent = idle
    ? callMode === 'room'
      ? 'Enter a room ID. Everyone who joins the same ID is in the same call.'
      : 'Pick someone from the online list, or type their ID, then press call.'
    : status;

  if (state !== 'incoming' && incomingDialog.open) incomingDialog.close();
  if (state === 'idle') {
    setButtonLabel(micBtn, 'Mute', false);
    setButtonLabel(camBtn, 'Camera', false);
    micBtn.classList.remove('active');
    camBtn.classList.remove('active');
    sharingPeers.clear();
    cameraOffPeers.clear();
    for (const peerId of [...tiles.keys()]) removeTile(peerId);
  }
  micBtn.disabled = !calls?.hasLocalTrack('audio');
  // In a call without microphone access: show the slashed mic, not a "Mute" that does nothing.
  if (inCall && micBtn.disabled) setButtonLabel(micBtn, 'No mic', true);
  camBtn.disabled = !inCall || !!calls?.isSharingScreen;
  if (inCall && calls) renderCameraButton(calls.isCameraOn);
  renderTimer(info);

  if (wasIdle && state !== 'idle') tabs.show('call');
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
    camBtn.disabled = callsInfo.state !== 'in-call' || calls.isSharingScreen;
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
});

// ---- Sharing rooms: to friends in the app, or by link (copied automatically) ----
const share = new ShareDialog(socket, {
  friends: () => friends?.current.friends ?? [],
  presenceOf: (id) => lastUsers.find((u) => u.id.toLowerCase() === id.toLowerCase())?.presence ?? 'away',
  keyOf: (roomId) => rooms.find(roomId)?.key,
});
$('#share-room-btn').addEventListener('click', () => {
  if (chat.room) share.open(chat.room, false);
});

/** A friend shared a room with us: a small card to open it (or join its call) right away. */
const invitesEl = el('div', { className: 'invite-stack' });
document.body.append(invitesEl);
socket.on('rooms:shared', ({ from, roomId, call, key }) => {
  const open = el('button', { className: 'btn btn-primary btn-small', text: call ? 'Join call' : 'Open' });
  open.type = 'button';
  const dismiss = el('button', { className: 'btn btn-ghost btn-small', text: 'Later' });
  dismiss.type = 'button';
  const card = el('div', { className: 'invite-card' }, [
    avatar(from),
    el('span', { className: 'invite-text', text: call ? `${from} invites you to the call in #${roomId}` : `${from} shared #${roomId} with you` }),
    el('span', { className: 'invite-actions' }, [dismiss, open]),
  ]);
  card.setAttribute('role', 'status');
  open.addEventListener('click', () => {
    card.remove();
    if (call) {
      joinRoomCall(roomId, key);
    } else {
      chat.join(roomId, false, key);
      tabs.show('chat');
    }
  });
  dismiss.addEventListener('click', () => card.remove());
  invitesEl.append(card);
  navigator.vibrate?.(150);
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
let unread = 0;
const customEmoji = new CustomEmojiStore(socket);
const chat = new ChatPanel(socket, userId, customEmoji, () => {
  if (tabs.isVisible('chat')) return;
  unread++;
  tabs.setBadge('chat', unread > 99 ? '99+' : unread);
});

tabs.onChange((tab) => {
  if (tab === 'chat') {
    unread = 0;
    tabs.setBadge('chat', null);
  }
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
window.matchMedia('(max-width: 720px)').addEventListener('change', updateCallBadge);

renderCallState(callsInfo);
if (new URL(window.location.href).searchParams.has('answer')) {
  setPendingAnswer(window.location.href);
  history.replaceState(null, '', '/app');
}
socket.connect();
