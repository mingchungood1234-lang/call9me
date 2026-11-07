import type { IceCandidate } from '../../shared/types';
import { nativeBridge, onNativeCommands } from './nativeApp';

/**
 * Native calls in the Android app (android/…/NativeCall.kt). The page keeps the call's logic
 * (socket.io: invites, rooms, rejoin, moving devices) in CallManager; the app does the media:
 * Android's own WebRTC, camera, microphone, speaker and screen capture, and shows its native
 * call screen. Signaling passes through here: offers, answers and ICE candidates from the
 * socket go to the app, and the app's go out on the socket. Browser peers can't tell the difference.
 *
 * Page → app: `Call9meAndroid.callMedia(json)`. App → page: `call9meNative.callMedia(json)`.
 */

export interface NativeMediaState {
  /** We have a microphone track. */
  audio: boolean;
  /** The microphone is unmuted. */
  mic: boolean;
  camera: boolean;
  sharing: boolean;
  facing: 'user' | 'environment';
}

type SignalKind = 'offer' | 'answer' | 'ice';

/** What the app sends the page. */
type AppMessage =
  | { op: 'started'; state: NativeMediaState }
  | { op: 'state'; state: NativeMediaState }
  | { op: 'signal'; to: string; kind: SignalKind; sdp?: string; candidate?: IceCandidate }
  | { op: 'peerState'; peer: string; state: RTCPeerConnectionState }
  | { op: 'hangUp' }
  | { op: 'invite'; to: string };

export interface NativeCallHandlers {
  /** Send this offer/answer/candidate to `to` over the socket. */
  signal(to: string, kind: SignalKind, sdp: string | undefined, candidate: IceCandidate | undefined): void;
  /** Mic, camera, screen share or camera facing changed (from either screen). */
  onState(state: NativeMediaState, previous: NativeMediaState): void;
  onPeerState(peer: string, state: RTCPeerConnectionState): void;
  /** Hang up pressed on the native call screen. */
  onHangUp(): void;
  /** "Add person" on the native call screen. */
  onInvite(to: string): void;
}

const IDLE_STATE: NativeMediaState = { audio: false, mic: false, camera: false, sharing: false, facing: 'user' };

/** True in an Android app that runs calls natively. */
export function nativeCallsAvailable(): boolean {
  try {
    return typeof nativeBridge?.callMedia === 'function' && nativeBridge.nativeCallsSupported?.() === true;
  } catch {
    return false;
  }
}

export class NativeCallMedia {
  private current: NativeMediaState = { ...IDLE_STATE };
  private starting: ((state: NativeMediaState) => void) | null = null;

  constructor(private readonly handlers: NativeCallHandlers) {
    onNativeCommands({ callMedia: (json) => this.receive(json) });
  }

  get state(): NativeMediaState {
    return this.current;
  }

  /** Opens the microphone (and camera) and the native call screen. Resolves once ready. */
  start(options: { video: boolean; facing: 'user' | 'environment'; iceServers: RTCIceServer[]; selfId: string }): Promise<NativeMediaState> {
    this.starting?.({ ...IDLE_STATE });
    return new Promise((resolve) => {
      this.starting = resolve;
      this.send({ op: 'start', ...options, iceServers: options.iceServers.map(normalizeIceServer) });
    });
  }

  stop(): void {
    this.starting?.({ ...IDLE_STATE });
    this.starting = null;
    this.current = { ...IDLE_STATE };
    this.send({ op: 'stop' });
  }

  /** We make the offer to this peer. */
  connect(peer: string): void {
    this.send({ op: 'connect', peer });
  }

  offer(from: string, sdp: RTCSessionDescriptionInit): void {
    this.send({ op: 'offer', from, sdp: sdp.sdp ?? '' });
  }

  answer(from: string, sdp: RTCSessionDescriptionInit): void {
    this.send({ op: 'answer', from, sdp: sdp.sdp ?? '' });
  }

  ice(from: string, candidate: RTCIceCandidateInit): void {
    this.send({ op: 'ice', from, candidate });
  }

  removePeer(peer: string): void {
    this.send({ op: 'removePeer', peer });
  }

  peerScreen(peer: string, sharing: boolean): void {
    this.send({ op: 'peerScreen', peer, sharing });
  }

  peerCamera(peer: string, on: boolean): void {
    this.send({ op: 'peerCamera', peer, on });
  }

  /** Who's in the call, for the native screen's header. */
  info(info: { roomId: string | null; participants: string[]; invited: string[]; away: string[] }): void {
    this.send({ op: 'info', ...info });
  }

  notice(message: string, kind: string): void {
    this.send({ op: 'notice', message, kind });
  }

  // The web call controls still work (e.g. after minimizing the native screen).
  toggleMic(): boolean {
    this.send({ op: 'mic', on: !this.current.mic });
    return !this.current.mic;
  }

  toggleCamera(): boolean {
    this.send({ op: 'camera', on: !this.current.camera });
    return !this.current.camera;
  }

  flipCamera(): void {
    this.send({ op: 'flip' });
  }

  setScreenShare(on: boolean): void {
    this.send({ op: 'screen', on });
  }

  /** Brings the native call screen back to the front. */
  show(): void {
    this.send({ op: 'show' });
  }

  private send(message: Record<string, unknown>): void {
    try {
      nativeBridge?.callMedia?.(JSON.stringify(message));
    } catch (err) {
      console.warn('Native call bridge failed', err);
    }
  }

  private receive(json: string): void {
    let message: AppMessage;
    try {
      message = JSON.parse(json) as AppMessage;
    } catch {
      return;
    }
    switch (message.op) {
      case 'started': {
        const resolve = this.starting;
        this.starting = null;
        this.setState(message.state);
        resolve?.(message.state);
        break;
      }
      case 'state':
        this.setState(message.state);
        break;
      case 'signal':
        this.handlers.signal(message.to, message.kind, message.sdp, message.candidate);
        break;
      case 'peerState':
        this.handlers.onPeerState(message.peer, message.state);
        break;
      case 'hangUp':
        this.handlers.onHangUp();
        break;
      case 'invite':
        this.handlers.onInvite(message.to);
        break;
    }
  }

  private setState(state: NativeMediaState): void {
    const previous = this.current;
    this.current = { ...state };
    this.handlers.onState(this.current, previous);
  }
}

function normalizeIceServer(server: RTCIceServer): { urls: string[]; username?: string; credential?: string } {
  const urls = Array.isArray(server.urls) ? server.urls : [server.urls];
  return { urls, username: server.username, credential: typeof server.credential === 'string' ? server.credential : undefined };
}
