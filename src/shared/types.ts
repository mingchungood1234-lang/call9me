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

export type Presence = 'available' | 'busy';

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
}

export interface CallUpdate {
  callId: string;
  /** Set for call rooms (joined by room ID); null for invite-only calls. */
  roomId: string | null;
  participants: string[];
  invited: string[];
  video: boolean;
}

export type Ack<T = {}> = (result: ({ ok: true } & T) | { ok: false; error: string }) => void;

export interface ClientToServerEvents {
  'users:list': (ack: Ack<{ users: OnlineUserSummary[] }>) => void;

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
    payload: { roomId: string; video: boolean },
    ack: Ack<{ callId: string; roomId: string; participants: string[]; video: boolean }>,
  ) => void;
  /** Joins the call; the ack lists the participants we must send offers to. */
  'call:accept': (
    payload: { callId: string },
    ack: Ack<{ callId: string; participants: string[]; video: boolean }>,
  ) => void;
  'call:reject': (payload: { callId: string; reason?: string }) => void;
  'call:leave': () => void;
  /** Tells the other participants whether our outgoing video is currently a screen share. */
  'call:screen': (payload: { sharing: boolean }) => void;

  /** Mesh signaling: each message targets one participant of our call. */
  'webrtc:offer': (payload: { to: string; sdp: SessionDescription }) => void;
  'webrtc:answer': (payload: { to: string; sdp: SessionDescription }) => void;
  'webrtc:ice': (payload: { to: string; candidate: IceCandidate }) => void;

  'chat:join': (
    payload: { roomId: string },
    ack: Ack<{ roomId: string; history: ChatMessage[]; members: string[] }>,
  ) => void;
  'chat:leave': (payload: { roomId: string }) => void;
  'chat:message': (payload: { roomId: string; text: string }, ack: Ack) => void;
}

export interface ServerToClientEvents {
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
  'call:screen': (payload: { from: string; sharing: boolean }) => void;

  'webrtc:offer': (payload: { from: string; sdp: SessionDescription }) => void;
  'webrtc:answer': (payload: { from: string; sdp: SessionDescription }) => void;
  'webrtc:ice': (payload: { from: string; candidate: IceCandidate }) => void;

  'chat:message': (message: ChatMessage) => void;
  'chat:members': (payload: { roomId: string; members: string[] }) => void;
}

export interface SocketData {
  userId: string;
}

/** Error codes sent through Socket.IO's connect_error during the auth handshake. */
export const CONNECT_ERRORS = {
  UNAUTHORIZED: 'UNAUTHORIZED',
  ID_TAKEN: 'ID_TAKEN',
} as const;

// ---- REST API ----

export interface AvailabilityResponse {
  valid: boolean;
  /** An account (ID + PIN) already exists for this ID. */
  registered: boolean;
  /** Someone is currently signed in with this ID. */
  online: boolean;
  message: string;
}

// ---- Web Push ----

export interface PushSubscriptionJSON {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

/** Payload the server pushes; the service worker turns it into a notification. */
export interface PushPayload {
  type: 'call' | 'missed-call' | 'chat';
  title: string;
  body: string;
  /** Notifications with the same tag replace each other. */
  tag: string;
  url: string;
  /** For "call": lets the notification's Decline button reject the call without opening the app. */
  callId?: string;
}

export type LoginResponse = { ok: true; userId: string; created: boolean } | { ok: false; error: string };
