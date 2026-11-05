/**
 * Socket.IO event contract shared by the server and the browser client.
 * Server-side code must still validate every payload at runtime.
 */

export interface SessionDescription {
  type: 'offer' | 'answer';
  sdp: string;
}

export interface IceCandidate {
  candidate: string;
  sdpMid?: string | null;
  sdpMLineIndex?: number | null;
  usernameFragment?: string | null;
}

export interface IceServerConfig {
  urls: string | string[];
  username?: string;
  credential?: string;
}

/**
 * What others see. "busy": in a call. "idle" / "dnd": the status the user chose.
 * "offline": app closed (or invisible), but notifications are on — calling rings their phone.
 */
export type Presence = 'available' | 'busy' | 'idle' | 'dnd' | 'offline';

/**
 * The status a user picks in Settings. "dnd": calls to them are refused and they get no
 * notifications. "invisible": they look offline to everyone but can use the app as usual.
 */
export type UserStatus = 'online' | 'idle' | 'dnd' | 'invisible';
export const USER_STATUSES: readonly UserStatus[] = ['online', 'idle', 'dnd', 'invisible'];

export interface OnlineUserSummary {
  id: string;
  presence: Presence;
}

export interface ChatMessage {
  id: string;
  roomId: string;
  from: string;
  text: string;
  timestamp: number;
  system?: boolean;
  /** A sticker message: the sticker picture's URL (`text` is empty). */
  sticker?: string;
}

/** A row of our chat list: a room we've joined (or the Public chat), its last message and unread count. */
/** Our own choices for a room in our chat list (only we see them). */
export interface RoomPrefs {
  /** Kept at the top of the list. */
  pinned?: boolean;
  /** No push notifications for its messages (being @mentioned still notifies) and no unread badge. */
  muted?: boolean;
  /** Moved to the Archived section at the bottom of the list. */
  archived?: boolean;
}

export interface ChatRoomPreview extends RoomPrefs {
  id: string;
  lastMessage?: ChatMessage;
  /** Messages from others since we last read the room. */
  unread: number;
  visibility?: RoomVisibility;
}

/** One of our own stickers (a picture we added; sending it posts it big in chat). */
export interface Sticker {
  id: string;
  url: string;
}

/**
 * "public": listed for everyone and anyone can join. "private": listed only for the
 * owner's friends, and only they (or people called into it) can join. "link": a room
 * that's always listed for its members and that people join only through its invite link.
 * People who joined a room, or had it shared with them, can always come back (unless banned).
 * Every room keeps its chat history.
 */
export type RoomVisibility = 'public' | 'private' | 'link';

/** A room (chat + call sharing one ID) as listed in the Rooms directory. */
export interface RoomSummary {
  id: string;
  /** Whoever used the ID first; only they can change the visibility. */
  owner: string;
  visibility: RoomVisibility;
  /** Everyone in the room's chat or call right now (sorted). */
  online: string[];
  /** How many of them are in the room's call. */
  inCall: number;
  /** People who joined the chat and haven't left it (they get its notifications). */
  followers: number;
  /** The invite key of a "link" room (only sent to people who are allowed in). */
  key?: string;
  /** We belong to it (member, following its chat, or in it now), so we can leave it. */
  joined?: boolean;
}

/** Our friends and pending requests (IDs as registered). */
export interface FriendsState {
  friends: string[];
  /** Requests waiting for us to accept or decline. */
  incoming: string[];
  /** Requests we sent that are still pending. */
  outgoing: string[];
}

/** A picture emoji anyone can use in chat by typing `:name:`. */
export interface CustomEmoji {
  name: string;
  /** Who added it (only they can remove it). */
  owner: string;
  url: string;
}

/** A call we're in on another of our devices (it can be moved to this one). */
export interface CallElsewhere {
  callId: string;
  roomId: string | null;
  /** The other people in it. */
  participants: string[];
  video: boolean;
}

/** A call we just left (or dropped out of): we can rejoin it until `until` (0: not any more). */
export interface CallRejoin extends CallElsewhere {
  until: number;
}

export interface CallUpdate {
  callId: string;
  /** Set for call rooms (joined by room ID); null for invite-only calls. */
  roomId: string | null;
  participants: string[];
  invited: string[];
  /** People who left a moment ago and can still rejoin (the call waits for them). */
  away: string[];
  video: boolean;
}

/**
 * One call as one user saw it. "completed": someone else was connected (see `durationMs`);
 * "missed" / "declined": an incoming call we didn't take; "unanswered": we called or opened
 * a room and nobody joined; "cancelled": we hung up before anyone answered.
 */
export type CallOutcome = 'completed' | 'missed' | 'declined' | 'unanswered' | 'cancelled';

export interface CallHistoryEntry {
  id: string;
  callId: string;
  direction: 'outgoing' | 'incoming' | 'room';
  roomId: string | null;
  /** Everyone else who was invited to, or was in, the call with us. */
  peers: string[];
  video: boolean;
  outcome: CallOutcome;
  startedAt: number;
  endedAt: number;
  /** Time spent with at least one other person connected. */
  durationMs: number;
}

export type Ack<T = {}> =(result: ({ ok: true } & T) | { ok: false; error: string }) => void;

export interface ClientToServerEvents {
  'users:list': (ack: Ack<{ users: OnlineUserSummary[] }>) => void;
  /** Whether the app is on screen; push notifications are only sent while it isn't. */
  'client:visibility': (payload: { visible: boolean }) => void;

  /** Starts a new call, or adds `to` to the call we are already in. */
  'call:invite': (
    payload: { to: string; video: boolean },
    /** `offline`: the callee's app is closed; their device is being rung via push. */
    ack: Ack<{ callId: string; to: string; offline: boolean }>,
  ) => void;
  /**
   * Joins (or opens) the group call for a room ID — anyone using the same ID meets there.
   * The ack lists the participants we must send offers to.
   */
  'call:join-room': (
    /** `key`: the invite key from a link, needed the first time for "link" rooms. */
    payload: { roomId: string; video: boolean; key?: string },
    ack: Ack<{ callId: string; roomId: string; participants: string[]; video: boolean }>,
  ) => void;
  /**
   * Joins the call (`video`: whether we answer with our camera on); the ack lists the
   * participants we must send offers to.
   */
  'call:accept': (
    payload: { callId: string; video?: boolean },
    ack: Ack<{ callId: string; participants: string[]; video: boolean }>,
  ) => void;
  'call:reject': (payload: { callId: string; reason?: string }) => void;
  'call:leave': () => void;
  /**
   * Moves the call we're in on another device to this one, without leaving it: the other
   * device drops out quietly, and we send offers to everyone in the ack.
   */
  'call:move-here': (ack: Ack<CallElsewhere>) => void;
  /** Back into a call we left less than a minute ago (see `call:rejoinable`). */
  'call:rejoin': (payload: { callId: string; video: boolean }, ack: Ack<CallElsewhere>) => void;
  /** Tells the other participants whether our outgoing video is currently a screen share. */
  'call:screen': (payload: { sharing: boolean }) => void;
  /** Tells the other participants whether our camera is on (so they can show our avatar instead). */
  'call:camera': (payload: { on: boolean }) => void;

  /** Mesh signaling: each message targets one participant of our call. */
  'webrtc:offer': (payload: { to: string; sdp: SessionDescription }) => void;
  'webrtc:answer': (payload: { to: string; sdp: SessionDescription }) => void;
  'webrtc:ice': (payload: { to: string; candidate: IceCandidate }) => void;

  'chat:join': (
    payload: { roomId: string; key?: string },
    ack: Ack<{ roomId: string; history: ChatMessage[]; members: string[] }>,
  ) => void;
  'chat:leave': (payload: { roomId: string }) => void;
  /**
   * A room as it looks before joining: its listing and latest messages (`room` is null if
   * the ID is free, so joining creates it). `key`: the invite key from a link.
   */
  'chat:preview': (
    payload: { roomId: string; key?: string },
    ack: Ack<{ room: RoomSummary | null; recent: ChatMessage[] }>,
  ) => void;
  /** Pins, mutes or archives a room in our chat list (fields left out stay as they were). */
  'chat:prefs': (payload: { roomId: string } & RoomPrefs, ack: Ack) => void;
  /** Stops viewing a room's conversation (back to the chat list); we stay in the room. */
  'chat:close': (payload: { roomId: string }) => void;
  /** We've seen everything in this room so far (resets its unread count). */
  'chat:read': (payload: { roomId: string }) => void;
  'chat:message': (payload: { roomId: string; text: string }, ack: Ack) => void;

  /** Our call history, newest first. */
  'history:list': (ack: Ack<{ entries: CallHistoryEntry[] }>) => void;
  'history:clear': (ack: Ack) => void;

  /** Claims a new room ID (we become its owner), or changes the visibility of a room we own. */
  'rooms:create': (payload: { roomId: string; visibility: RoomVisibility }, ack: Ack<{ room: RoomSummary }>) => void;
  'rooms:set-visibility': (payload: { roomId: string; visibility: RoomVisibility }, ack: Ack) => void;
  /** Leaves a room for good: its chat, its notifications and our membership (a "link" room then needs the link again). */
  'rooms:leave': (payload: { roomId: string }, ack: Ack) => void;
  /** A room we own: everyone who joined it (besides us) and everyone banned from it. */
  'rooms:members': (payload: { roomId: string }, ack: Ack<{ members: string[]; banned: string[] }>) => void;
  /** Takes someone out of a room we own; `ban` also keeps them from ever coming back. */
  'rooms:remove-member': (payload: { roomId: string; userId: string; ban: boolean }, ack: Ack) => void;
  'rooms:unban': (payload: { roomId: string; userId: string }, ack: Ack) => void;
  /** Deletes a room we own: its chat, history, members and settings (not while its call is on). */
  'rooms:delete': (payload: { roomId: string }, ack: Ack) => void;
  /** Shares a room with friends: they may join it from then on and get an invite (and a push). */
  'rooms:share': (
    payload: { roomId: string; to: string[]; call: boolean },
    ack: Ack<{ sent: string[] }>,
  ) => void;

  'friends:request': (payload: { to: string }, ack: Ack<{ to: string; accepted: boolean }>) => void;
  /** Accepts or declines a request someone sent us. */
  'friends:respond': (payload: { from: string; accept: boolean }, ack: Ack) => void;
  /** Withdraws a request we sent. */
  'friends:cancel': (payload: { to: string }, ack: Ack) => void;
  'friends:remove': (payload: { id: string }, ack: Ack) => void;

  'status:set': (payload: { status: UserStatus }, ack: Ack) => void;
  /** Sets our profile picture (a PNG/WebP/GIF data URL; the app crops and shrinks it first), or removes it (null). */
  'profile:avatar': (payload: { image: string | null }, ack: Ack) => void;

  /** Adds a picture to our sticker collection (PNG/WebP/GIF data URL, shrunk by the app first). */
  'stickers:add': (payload: { image: string }, ack: Ack<{ sticker: Sticker }>) => void;
  'stickers:remove': (payload: { id: string }, ack: Ack) => void;
  /** Posts one of our stickers in a chat room. */
  'chat:sticker': (payload: { roomId: string; stickerId: string }, ack: Ack) => void;

  /** Adds a custom emoji; `image` is a PNG/WebP/GIF data URL (the app shrinks pictures first). */
  'emoji:add': (payload: { name: string; image: string }, ack: Ack<{ emoji: CustomEmoji }>) => void;
  'emoji:remove': (payload: { name: string }, ack: Ack) => void;
}

export interface ServerToClientEvents {
  /** The current front-end build; sent on every connect so outdated pages can offer an update. */
  'app:version': (payload: { version: string }) => void;
  'users:update': (users: OnlineUserSummary[]) => void;

  'call:incoming': (payload: {
    callId: string;
    roomId: string | null;
    from: string;
    video: boolean;
    participants: string[];
  }) => void;
  /** Our invite was withdrawn before we answered (caller hung up / timed out). */
  'call:cancelled': (payload: { callId: string; reason: string }) => void;
  /** Sent to every participant whenever membership or pending invites change. */
  'call:update': (payload: CallUpdate) => void;
  'call:peer-joined': (payload: { callId: string; userId: string }) => void;
  'call:peer-left': (payload: { callId: string; userId: string; reason: string }) => void;
  'call:rejected': (payload: { callId: string; from: string; reason: string }) => void;
  /** The call is over for us (nobody else left). */
  'call:ended': (payload: { callId: string; reason: string }) => void;
  /** We left (or dropped out of) a call that waits a minute for us to come back; `until: 0` once it doesn't. */
  'call:rejoinable': (payload: CallRejoin) => void;
  /** To our other devices: the call we're in elsewhere, or null once we're in none. */
  'call:elsewhere': (payload: CallElsewhere | null) => void;
  /** To the device that had our call: it moved to another of our devices (don't send call:leave). */
  'call:moved': (payload: { callId: string }) => void;
  /** Someone in our call switched devices: drop the old connection; offers from the new device follow. */
  'call:peer-moved': (payload: { callId: string; userId: string }) => void;
  'call:screen': (payload: { from: string; sharing: boolean }) => void;
  'call:camera': (payload: { from: string; on: boolean }) => void;

  'webrtc:offer': (payload: { from: string; sdp: SessionDescription }) => void;
  'webrtc:answer': (payload: { from: string; sdp: SessionDescription }) => void;
  'webrtc:ice': (payload: { from: string; candidate: IceCandidate }) => void;

  'chat:message': (message: ChatMessage) => void;
  'chat:members': (payload: { roomId: string; members: string[] }) => void;
  /** Our chat list (the Public chat first, then the rooms we've joined); sent on connect. */
  'chat:rooms': (rooms: ChatRoomPreview[]) => void;
  /** Someone tagged us (`@ourId`) in a room's chat. */
  'chat:mention': (payload: { from: string; roomId: string; text: string }) => void;
  /** The owner deleted this room; everyone in it has been moved out. */
  'chat:deleted': (payload: { roomId: string; by: string }) => void;
  /** The owner took us out of this room (`banned`: and we can't come back). */
  'chat:removed': (payload: { roomId: string; by: string; banned: boolean }) => void;

  /** A call of ours just ended (or was missed) and was added to the history. */
  'history:new': (entry: CallHistoryEntry) => void;

  /** The rooms we can see (public ones, our friends' private ones, our own); sent on connect and on change. */
  'rooms:update': (rooms: RoomSummary[]) => void;
  /** Our friends and requests; sent on connect and on change. */
  'friends:update': (state: FriendsState) => void;
  /** A friend shared a room with us (`call`: they invite us to its call rather than its chat). */
  'rooms:shared': (payload: { from: string; roomId: string; call: boolean; key?: string }) => void;
  /** Someone just sent us a friend request (for a toast). */
  'friends:requested': (payload: { from: string }) => void;

  /** Everyone's profile picture URL by lowercased user ID; sent on connect and whenever one changes. */
  'avatars:update': (urls: Record<string, string>) => void;
  /** Our own status (sent on connect, so every device shows the same choice). */
  'status:update': (payload: { status: UserStatus }) => void;
  /** Our own stickers; sent on connect and whenever we add or remove one. */
  'stickers:update': (stickers: Sticker[]) => void;
  /** All custom emoji; sent on connect and whenever one is added or removed. */
  'emoji:update': (emoji: CustomEmoji[]) => void;
}

export interface SocketData {
  userId: string;
}

/** Error codes sent through Socket.IO's connect_error during the auth handshake. */
export const CONNECT_ERRORS = {
  UNAUTHORIZED: 'UNAUTHORIZED',
  /** This ID is already open on as many devices as allowed. */
  TOO_MANY_DEVICES: 'TOO_MANY_DEVICES',
} as const;

// ---- REST API ----

export interface AvailabilityResponse {
  valid: boolean;
  /** An account (ID + PIN) already exists for this ID. */
  registered: boolean;
  /** Someone is signed in with this ID right now (on any device). */
  online: boolean;
  message: string;
}

// ---- Sign in with a QR code ----

type ApiResult<T> = ({ ok: true } & T) | { ok: false; error: string };

/** The new device's code: shown as a QR code (of `url`) and as text. */
export type PairStartResponse = ApiResult<{ code: string; url: string; expiresAt: number }>;
/** Polled by the new device; "approved" comes with its session cookie. */
export type PairStatusResponse = ApiResult<{ status: 'pending' | 'expired' } | { status: 'approved'; userId: string }>;
/** For the signed-in device: which browser is asking to be signed in, and since when. */
export type PairInfoResponse = ApiResult<{ code: string; device: string; ageMs: number }>;

// ---- Web Push ----

export interface PushSubscriptionJSON {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

/** Payload the server pushes; the service worker turns it into a notification. */
export interface PushPayload {
  type: 'call' | 'missed-call' | 'chat' | 'friend';
  title: string;
  body: string;
  /** Notifications with the same tag replace each other. */
  tag: string;
  url: string;
  /** For "call": lets the notification's Decline button reject the call without opening the app. */
  callId?: string;
}

/** What a push service (Apple, Google, Mozilla…) answered for one device. */
export interface PushTestResult {
  /** e.g. "web.push.apple.com" */
  service: string;
  ok: boolean;
  status: number;
  error?: string;
}

export type LoginResponse = { ok: true; userId: string; created: boolean } | { ok: false; error: string };
