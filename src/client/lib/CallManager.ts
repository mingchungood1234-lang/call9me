import type { CallElsewhere, CallRejoin, IceCandidate } from '../../shared/types';
import { canShareNativeScreen, startNativeScreen, stopNativeScreen } from './nativeScreen';
import { NOT_CONNECTED, withTimeout, type AppSocket } from './socket';

export type CallState = 'idle' | 'incoming' | 'in-call';
/** Front camera ("user", shown mirrored) or back camera ("environment"). */
export type CameraFacing = 'user' | 'environment';

export interface CallInfo {
  state: CallState;
  callId: string | null;
  /** Set when this is a call room (joinable by ID). */
  roomId: string | null;
  video: boolean;
  /** Other users connected to the call (server's view). */
  participants: string[];
  /** Users still ringing. */
  invited: string[];
  /** People who left a moment ago; the call waits a minute for them to rejoin. */
  away: string[];
  /** Set while state is "incoming". */
  incomingFrom: string | null;
}

export interface CallEvents {
  onStateChange(info: CallInfo): void;
  /** Our camera and microphone (null: none). */
  onLocalStream(stream: MediaStream | null): void;
  /** A peer's camera and microphone. */
  onPeerStream(peerId: string, stream: MediaStream): void;
  /** A peer's screen-share video (its own slot, next to their camera; it only has frames while they share). */
  onPeerScreenStream(peerId: string, stream: MediaStream): void;
  onPeerConnectionState(peerId: string, state: RTCPeerConnectionState): void;
  onPeerRemoved(peerId: string): void;
  onPeerScreen(peerId: string, sharing: boolean): void;
  /** A peer switched their camera on or off. */
  onPeerCamera(peerId: string, on: boolean): void;
  /** Our own screen share (null: not sharing). */
  onLocalScreen(stream: MediaStream | null): void;
  onIncoming(from: string, video: boolean, participants: string[], roomId: string | null): void;
  /** A call we just left can still be rejoined (until `call.until`), or not any more (null). */
  onRejoinable(call: CallRejoin | null): void;
  /** We're in a call on another of our devices (null: not any more); it can be moved here. */
  onElsewhere(call: CallElsewhere | null): void;
  /** The camera switched between front ("user") and back ("environment"). */
  onFacingChange(facing: CameraFacing): void;
  onNotice(message: string, kind?: 'info' | 'success' | 'error'): void;
}

interface Peer {
  id: string;
  pc: RTCPeerConnection;
  pendingIce: RTCIceCandidateInit[];
  /** Their camera and microphone. */
  stream: MediaStream;
  /** Their screen share, from the second video slot. */
  screenStream: MediaStream | null;
  /** Only the offerer restarts ICE, so both sides never send offers at once. */
  isOfferer: boolean;
  restarts: number;
  /** Pending ICE restart after a "disconnected" spell that didn't heal by itself. */
  restartTimer?: ReturnType<typeof setTimeout>;
}

/** ICE restarts tried per peer before the connection is reported as failed. */
const MAX_ICE_RESTARTS = 3;
/** How long a "disconnected" connection may recover on its own before an ICE restart. */
const DISCONNECT_GRACE_MS = 4000;

export const IDLE_CALL: CallInfo = {
  state: 'idle',
  callId: null,
  roomId: null,
  video: true,
  participants: [],
  invited: [],
  away: [],
  incomingFrom: null,
};
const IDLE = IDLE_CALL;

/**
 * Screen capture exists in desktop browsers and in the Android app (natively, see nativeScreen.ts);
 * phone browsers can view a share but not start one.
 */
export function canShareScreen(): boolean {
  if (canShareNativeScreen()) return true;
  return (
    typeof navigator.mediaDevices?.getDisplayMedia === 'function' &&
    !window.matchMedia('(pointer: coarse)').matches
  );
}

/**
 * Group calls as a full mesh: one RTCPeerConnection per other participant.
 *
 * Joining: whoever accepts an invite sends an offer to every existing participant,
 * so each pair has exactly one offerer (no glare). Every connection negotiates two
 * send-capable video transceivers (even voice calls): the first for the camera, the
 * second for a screen share, so both can be on at once and either switched with
 * `replaceTrack`, no renegotiation. A peer on an older version negotiates only one;
 * then a screen share replaces the camera there, as before.
 */
export class CallManager {
  private info: CallInfo = { ...IDLE };
  private readonly peers = new Map<string, Peer>();
  private localStream: MediaStream | null = null;
  private screenTrack: MediaStreamTrack | null = null;
  /** Incremented on every cleanup so stale async continuations can bail out. */
  private session = 0;
  /** Set while accepting, so a second tap (or auto-answer) can't accept twice. */
  private accepting = false;
  /** Which camera we use; kept across calls. */
  private facing: CameraFacing = 'user';
  /** Set while the camera is being flipped, so taps can't overlap. */
  private flipping = false;
  /** The call we're in on another of our devices, if any. */
  private elsewhereCall: CallElsewhere | null = null;
  /** A call we left a moment ago that we can still rejoin. */
  private rejoinCall: CallRejoin | null = null;
  /** The call we were in when the connection dropped, to rejoin automatically once it's back. */
  private dropped: { callId: string; video: boolean } | null = null;

  constructor(
    private readonly socket: AppSocket,
    private readonly selfId: string,
    private readonly iceServers: RTCIceServer[],
    private readonly events: CallEvents,
  ) {
    this.bindSocket();
  }

  get state(): CallState {
    return this.info.state;
  }

  get isSharingScreen(): boolean {
    return this.screenTrack !== null;
  }

  /** Starts a call, or (when already in one) invites another person into it. */
  async startCall(to: string, video: boolean): Promise<void> {
    if (this.info.state === 'incoming') {
      this.events.onNotice('Answer or decline the incoming call first.', 'error');
      return;
    }
    if (!this.socket.connected) {
      this.events.onNotice(NOT_CONNECTED, 'error');
      return;
    }
    if (this.info.state === 'in-call') {
      this.socket.emit('call:invite', { to, video: this.info.video }, withTimeout((res) => {
        if (!res.ok) this.events.onNotice(res.error, 'error');
        else if (res.offline) this.events.onNotice(`${res.to} is offline — ringing their device with a notification…`);
        else this.events.onNotice(`Ringing ${res.to}…`);
      }));
      return;
    }

    const session = this.session;
    this.setInfo({ ...IDLE, state: 'in-call', video, invited: [to] });

    const stream = await this.acquireMedia(video);
    if (session !== this.session) {
      // Hung up while waiting for the permission prompt.
      stream?.getTracks().forEach((t) => t.stop());
      return;
    }
    this.setLocalStream(stream);

    this.socket.emit('call:invite', { to, video }, this.callAck(session, (res) => {
      this.setInfo({ ...this.info, callId: res.callId });
      if (res.offline) this.events.onNotice(`${res.to} is offline — ringing their device with a notification…`);
    }));
  }

  /** Joins the call room with this ID (everyone using the same ID meets there). */
  /** `key`: the invite key from a link (needed the first time for invite-only rooms). */
  async joinRoom(roomId: string, video: boolean, key?: string): Promise<void> {
    if (this.info.state !== 'idle') {
      this.events.onNotice('Leave the current call first.', 'error');
      return;
    }
    if (!this.socket.connected) {
      this.events.onNotice(NOT_CONNECTED, 'error');
      return;
    }
    const session = this.session;
    this.setInfo({ ...IDLE, state: 'in-call', roomId: roomId.toLowerCase(), video });

    const stream = await this.acquireMedia(video);
    if (session !== this.session) {
      stream?.getTracks().forEach((t) => t.stop());
      return;
    }
    this.setLocalStream(stream);

    this.socket.emit('call:join-room', { roomId, video, key }, this.callAck(session, (res) => {
      this.setInfo({ ...this.info, callId: res.callId, roomId: res.roomId, participants: res.participants });
      for (const peerId of res.participants) void this.connectTo(peerId);
    }));
  }

  /** Answers with the camera on (`video`) or audio only, whatever kind of call the caller started. */
  async acceptIncoming(video = this.info.video): Promise<void> {
    const { state, callId } = this.info;
    if (state !== 'incoming' || !callId || this.accepting) return;
    if (!this.socket.connected) {
      this.events.onNotice(NOT_CONNECTED, 'error');
      return;
    }
    const session = this.session;

    this.accepting = true;
    let stream: MediaStream | null;
    try {
      stream = await this.acquireMedia(video);
    } finally {
      this.accepting = false;
    }
    if (session !== this.session) {
      stream?.getTracks().forEach((t) => t.stop());
      return;
    }
    this.setLocalStream(stream);
    this.setInfo({ ...this.info, state: 'in-call', video, incomingFrom: null });

    this.socket.emit('call:accept', { callId, video }, this.callAck(session, (res) => {
      this.setInfo({ ...this.info, participants: res.participants });
      for (const peerId of res.participants) void this.connectTo(peerId);
    }));
  }

  rejectIncoming(reason = 'declined'): void {
    if (this.info.state !== 'incoming' || !this.info.callId) return;
    this.socket.emit('call:reject', { callId: this.info.callId, reason });
    this.cleanup();
  }

  hangUp(): void {
    this.dropped = null;
    if (this.info.state === 'idle') return;
    if (this.info.state === 'incoming') return this.rejectIncoming();
    if (this.info.callId) this.socket.emit('call:leave');
    this.cleanup();
  }

  /**
   * Ends the call locally without notifying the server (e.g. after a disconnect). The
   * server keeps the call open a minute for us, so we rejoin by ourselves on reconnect.
   */
  reset(): void {
    if (this.info.state === 'in-call' && this.info.callId) this.dropped = { callId: this.info.callId, video: this.isCameraOn };
    if (this.info.state !== 'idle') this.cleanup();
  }

  /** A call we left less than a minute ago, if any (see `rejoin`). */
  get rejoinable(): CallRejoin | null {
    return this.rejoinCall;
  }

  /** Back into the call we just left (`video`: camera on). */
  async rejoin(video: boolean): Promise<void> {
    const call = this.rejoinCall;
    if (!call || this.info.state !== 'idle') return;
    if (!this.socket.connected) {
      this.events.onNotice(NOT_CONNECTED, 'error');
      return;
    }
    const session = this.session;
    this.setInfo({ ...IDLE, state: 'in-call', callId: call.callId, roomId: call.roomId, video, participants: call.participants });

    const stream = await this.acquireMedia(video);
    if (session !== this.session) {
      stream?.getTracks().forEach((t) => t.stop());
      return;
    }
    this.setLocalStream(stream);

    this.socket.emit('call:rejoin', { callId: call.callId, video }, this.callAck(session, (res) => {
      this.setRejoinable(null);
      this.setInfo({ ...this.info, callId: res.callId, roomId: res.roomId, participants: res.participants });
      for (const peerId of res.participants) void this.connectTo(peerId);
      this.events.onNotice('Back in the call.', 'success');
    }));
  }

  private setRejoinable(call: CallRejoin | null): void {
    this.rejoinCall = call;
    this.events.onRejoinable(call);
  }

  /** @returns whether the microphone is now enabled. */
  toggleMic(): boolean {
    return this.toggleTracks(this.localStream?.getAudioTracks() ?? []);
  }

  get isCameraOn(): boolean {
    return this.cameraTrack() !== null;
  }

  /**
   * Turns the camera off (releasing it), or on — asking for it if needed, so a call
   * started audio-only can switch to video at any time. Every connection already has a
   * video slot, so this swaps the outgoing track without renegotiating.
   * @returns whether the camera is now on.
   */
  async toggleCamera(): Promise<boolean> {
    if (this.state !== 'in-call') return false;
    const current = this.cameraTrack();
    if (current) {
      current.stop();
      this.setCameraTrack(null);
      return false;
    }

    if (!navigator.mediaDevices?.getUserMedia) {
      this.events.onNotice('The camera needs HTTPS or localhost.', 'error');
      return false;
    }
    const session = this.session;
    let track: MediaStreamTrack | undefined;
    try {
      track = (await this.openCamera(this.facing)) ?? undefined;
    } catch (err) {
      console.warn('Camera unavailable', err);
      this.events.onNotice('Could not turn on the camera. Check that it is allowed and not in use.', 'error');
      return false;
    }
    if (!track || session !== this.session || this.cameraTrack()) {
      track?.stop();
      return this.isCameraOn;
    }
    this.setCameraTrack(track);
    return true;
  }

  hasLocalTrack(kind: 'audio' | 'video'): boolean {
    return (this.localStream?.getTracks().filter((t) => t.kind === kind).length ?? 0) > 0;
  }

  async startScreenShare(): Promise<void> {
    if (this.state !== 'in-call' || this.screenTrack) return;

    let stream: MediaStream;
    if (canShareNativeScreen()) {
      // Android app: the system's "Start sharing?" prompt. Stopping from Android's own controls ends it here too.
      const native = await startNativeScreen(() => void this.stopScreenShare());
      if (!native) return; // Refused or failed.
      stream = native;
    } else {
      try {
        stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
      } catch {
        return; // The user closed the picker.
      }
    }
    const track = stream.getVideoTracks()[0];
    if (!track || this.state !== 'in-call' || this.screenTrack) {
      stream.getTracks().forEach((t) => t.stop());
      stopNativeScreen();
      return;
    }

    track.contentHint = 'detail';
    this.screenTrack = track;
    // Fires when the user presses the browser's own "Stop sharing" bar.
    track.onended = () => void this.stopScreenShare();
    await this.syncVideoSenders();

    this.events.onLocalScreen(stream);
    this.socket.emit('call:screen', { sharing: true });
  }

  async stopScreenShare(): Promise<void> {
    const track = this.screenTrack;
    if (!track) return;
    this.screenTrack = null;
    track.onended = null;
    track.stop();
    stopNativeScreen();

    await this.syncVideoSenders();
    if (this.state !== 'idle') this.socket.emit('call:screen', { sharing: false });
    this.events.onLocalScreen(null);
  }

  /** The call we're in on another of our devices, if any (see `moveHere`). */
  get elsewhere(): CallElsewhere | null {
    return this.elsewhereCall;
  }

  /**
   * Takes over the call we're in on another of our devices: nobody sees us leave. The
   * other device drops out, and we connect to everyone from here (`video`: camera on).
   */
  async moveHere(video: boolean): Promise<void> {
    const call = this.elsewhereCall;
    if (!call || this.info.state !== 'idle') return;
    if (!this.socket.connected) {
      this.events.onNotice(NOT_CONNECTED, 'error');
      return;
    }
    const session = this.session;
    this.setInfo({ ...IDLE, state: 'in-call', callId: call.callId, roomId: call.roomId, video, participants: call.participants });

    const stream = await this.acquireMedia(video);
    if (session !== this.session) {
      stream?.getTracks().forEach((t) => t.stop());
      return;
    }
    this.setLocalStream(stream);

    this.socket.emit('call:move-here', withTimeout((res) => {
      if (session !== this.session) return;
      if (!res.ok) {
        this.events.onNotice(res.error, 'error');
        this.cleanup();
        return;
      }
      this.setElsewhere(null);
      this.setInfo({ ...this.info, callId: res.callId, roomId: res.roomId, participants: res.participants });
      for (const peerId of res.participants) void this.connectTo(peerId);
      // Everyone dropped our old connection: tell them what this device sends.
      this.socket.emit('call:camera', { on: this.isCameraOn });
      this.events.onNotice('The call is on this device now.', 'success');
    }));
  }

  get cameraFacing(): CameraFacing {
    return this.facing;
  }

  /** Whether there's more than one camera to switch between (phones; some laptops with a webcam). */
  async canFlipCamera(): Promise<boolean> {
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      return devices.filter((d) => d.kind === 'videoinput').length > 1;
    } catch {
      return false;
    }
  }

  /**
   * Switches between the front and back camera mid-call: the new track replaces the old
   * one on every connection, with no renegotiation. The old camera is released first,
   * since many phones can't open both at once. @returns whether it switched.
   */
  async flipCamera(): Promise<boolean> {
    const current = this.cameraTrack();
    if (this.state !== 'in-call' || !current || this.flipping) return false;
    this.flipping = true;
    const session = this.session;
    const next: CameraFacing = this.facing === 'user' ? 'environment' : 'user';
    const previousDevice = current.getSettings().deviceId;
    current.stop();
    try {
      let track = await this.openCamera(next).catch(() => null);
      // No camera facing that way (e.g. two webcams): take whichever other camera there is.
      if (!track || (previousDevice && track.getSettings().deviceId === previousDevice)) {
        track?.stop();
        track = await this.otherCamera(previousDevice);
      }
      if (!track) {
        // Nothing else to switch to: get the old camera back.
        track = await this.openCamera(this.facing).catch(() => null);
        if (track && session === this.session) this.setCameraTrack(track, false);
        else track?.stop();
        this.events.onNotice('Could not switch the camera.', 'error');
        return false;
      }
      if (session !== this.session) {
        track.stop();
        return false;
      }
      this.facing = (track.getSettings().facingMode as CameraFacing | undefined) ?? next;
      this.setCameraTrack(track, false);
      this.events.onFacingChange(this.facing);
      return true;
    } finally {
      this.flipping = false;
    }
  }

  // ---- Internals ----

  private async openCamera(facing: CameraFacing): Promise<MediaStreamTrack | null> {
    const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: facing } } });
    return stream.getVideoTracks()[0] ?? null;
  }

  /** Any camera other than `deviceId`. */
  private async otherCamera(deviceId: string | undefined): Promise<MediaStreamTrack | null> {
    const cameras = (await navigator.mediaDevices.enumerateDevices().catch(() => [])).filter((d) => d.kind === 'videoinput');
    const other = cameras.find((d) => d.deviceId && d.deviceId !== deviceId);
    if (!other) return null;
    const stream = await navigator.mediaDevices.getUserMedia({ video: { deviceId: { exact: other.deviceId } } }).catch(() => null);
    return stream?.getVideoTracks()[0] ?? null;
  }

  private setElsewhere(call: CallElsewhere | null): void {
    this.elsewhereCall = call;
    this.events.onElsewhere(call);
  }

  /**
   * Ack for a request that starts or joins a call. It is ignored if the user hung up
   * in the meantime and ends the call on error. If no reply arrives, it gives up and
   * leaves any call the server may still have put us in.
   */
  private callAck<T extends { ok: true }>(
    session: number,
    onOk: (res: T) => void,
  ): (res: T | { ok: false; error: string }) => void {
    return withTimeout(
      (res: T | { ok: false; error: string }) => {
        if (session !== this.session) {
          if (res.ok) this.socket.emit('call:leave');
          return;
        }
        if (!res.ok) {
          this.events.onNotice(res.error, 'error');
          this.cleanup();
          return;
        }
        onOk(res);
      },
      () => {
        if (session === this.session && this.socket.connected) this.socket.emit('call:leave');
      },
    );
  }

  private cameraTrack(): MediaStreamTrack | null {
    return this.localStream?.getVideoTracks()[0] ?? null;
  }

  /** Replaces the local camera (null = off) and tells the peers (unless only the camera changed, `announce` false). */
  private setCameraTrack(track: MediaStreamTrack | null, announce = true): void {
    const audio = this.localStream?.getAudioTracks() ?? [];
    // A new stream object, so the preview <video> picks up the change.
    this.localStream = new MediaStream(track ? [...audio, track] : audio);
    void this.syncVideoSenders();
    this.events.onLocalStream(this.localStream);
    if (announce) this.socket.emit('call:camera', { on: track !== null });
  }

  /** Puts the camera and the screen share on every connection's video slots. */
  private async syncVideoSenders(): Promise<void> {
    await Promise.all([...this.peers.values()].map((peer) => this.syncPeerVideo(peer.pc)));
  }

  private async syncPeerVideo(pc: RTCPeerConnection): Promise<void> {
    const [camera, screen] = this.videoTransceivers(pc);
    const set = (t: RTCRtpTransceiver | undefined, track: MediaStreamTrack | null) =>
      t && t.sender.track !== track ? t.sender.replaceTrack(track).catch(() => {}) : undefined;
    if (screen) {
      await Promise.all([set(camera, this.cameraTrack()), set(screen, this.screenTrack)]);
    } else {
      await set(camera, this.screenTrack ?? this.cameraTrack()); // older peer: one slot, the share wins
    }
  }

  private toggleTracks(tracks: MediaStreamTrack[]): boolean {
    if (tracks.length === 0) return false;
    const enabled = !tracks[0].enabled;
    tracks.forEach((t) => (t.enabled = enabled));
    return enabled;
  }

  /** The video slots in negotiation order: [camera, screen share] (just the camera with an older peer). */
  private videoTransceivers(pc: RTCPeerConnection): RTCRtpTransceiver[] {
    return pc.getTransceivers().filter((t) => t.receiver.track.kind === 'video' && t.currentDirection !== 'stopped');
  }

  private bindSocket(): void {
    this.socket.on('call:incoming', ({ callId, roomId, from, video, participants }) => {
      if (this.info.state !== 'idle') return; // Server guards this; be defensive anyway.
      this.setInfo({ ...IDLE, state: 'incoming', callId, roomId, video, participants, incomingFrom: from });
      this.events.onIncoming(from, video, participants, roomId);
    });

    this.socket.on('call:cancelled', ({ callId, reason }) => {
      if (this.info.state !== 'incoming' || callId !== this.info.callId) return;
      // Picked up or declined on another of our devices: not a missed call.
      const elsewhere = reason.endsWith('on another device');
      this.events.onNotice(
        elsewhere ? `Call from ${this.info.incomingFrom} ${reason}.` : `Missed call from ${this.info.incomingFrom} (${reason}).`,
      );
      this.cleanup();
    });

    this.socket.on('call:update', ({ callId, roomId, participants, invited, away }) => {
      if (this.info.state !== 'in-call' || callId !== this.info.callId) return;
      const others = participants.filter((p) => p !== this.selfId);
      // Keep our own `video` choice: in call rooms each person picks camera or audio-only.
      this.setInfo({ ...this.info, roomId, participants: others, invited, away: away ?? [] });
    });

    this.socket.on('call:rejoinable', (call) => {
      if (call.until === 0) {
        if (this.rejoinCall?.callId === call.callId) this.setRejoinable(null);
        if (this.dropped?.callId === call.callId) this.dropped = null;
        return;
      }
      this.setRejoinable(call);
      // We only dropped out (connection lost): go straight back in, as we were.
      const dropped = this.dropped;
      this.dropped = null;
      if (dropped?.callId === call.callId && this.info.state === 'idle') void this.rejoin(dropped.video);
    });

    this.socket.on('call:peer-joined', ({ callId, userId }) => {
      if (callId !== this.info.callId) return;
      this.events.onNotice(`${userId} joined the call.`, 'success');
      // Let the newcomer know we're sharing (their offer to us will arrive shortly).
      if (this.screenTrack) this.socket.emit('call:screen', { sharing: true });
      if (!this.isCameraOn) this.socket.emit('call:camera', { on: false });
    });

    this.socket.on('call:elsewhere', (call) => {
      // While we're in it here, the call isn't "elsewhere" (a late update after moving it here).
      this.setElsewhere(call && call.callId === this.info.callId && this.info.state === 'in-call' ? null : call);
    });

    // We moved this call to another of our devices: drop out here without leaving it.
    this.socket.on('call:moved', ({ callId }) => {
      if (callId !== this.info.callId || this.info.state !== 'in-call') return;
      this.events.onNotice('Your call moved to another device.');
      this.cleanup();
    });

    // Someone switched devices: their new device sends us an offer next.
    this.socket.on('call:peer-moved', ({ callId, userId }) => {
      if (callId !== this.info.callId) return;
      this.removePeer(userId);
      this.events.onNotice(`${userId} switched devices.`);
      if (this.screenTrack) this.socket.emit('call:screen', { sharing: true });
      if (!this.isCameraOn) this.socket.emit('call:camera', { on: false });
    });

    this.socket.on('call:peer-left', ({ callId, userId, reason }) => {
      if (callId !== this.info.callId) return;
      this.events.onNotice(reason === 'disconnected' ? `${userId} disconnected.` : `${userId} left the call.`);
      this.removePeer(userId);
    });

    this.socket.on('call:rejected', ({ callId, from, reason }) => {
      if (callId !== this.info.callId) return;
      const text =
        reason === 'declined' ? `${from} declined the call.`
        : reason === 'no answer' ? `${from} did not answer.`
        : `${from} is unavailable (${reason}).`;
      this.events.onNotice(text);
    });

    this.socket.on('call:ended', ({ callId }) => {
      if (callId !== this.info.callId) return;
      this.events.onNotice('Call ended.');
      this.cleanup();
    });

    this.socket.on('call:screen', ({ from, sharing }) => {
      if (!this.peers.has(from) && !this.info.participants.includes(from)) return;
      this.events.onPeerScreen(from, sharing);
    });

    this.socket.on('call:camera', ({ from, on }) => {
      if (!this.peers.has(from) && !this.info.participants.includes(from)) return;
      this.events.onPeerCamera(from, on);
    });

    this.socket.on('webrtc:offer', async ({ from, sdp }) => {
      if (this.info.state !== 'in-call') return;
      const peer = this.peers.get(from) ?? this.createPeer(from, false);
      try {
        await peer.pc.setRemoteDescription(sdp);
        // Keep our video slot send-capable even without a camera, for screen sharing.
        for (const t of peer.pc.getTransceivers()) {
          if (t.receiver.track.kind === 'video' && !t.sender.track && t.direction === 'recvonly') {
            t.direction = 'sendrecv';
          }
        }
        await this.syncPeerVideo(peer.pc); // e.g. we're sharing already: the screen goes in its slot
        await this.flushPendingIce(peer);
        const answer = await peer.pc.createAnswer();
        await peer.pc.setLocalDescription(answer);
        this.socket.emit('webrtc:answer', { to: from, sdp: { type: 'answer', sdp: answer.sdp ?? '' } });
      } catch (err) {
        console.error(`Could not answer ${from}`, err);
        this.events.onNotice(`Could not connect to ${from}.`, 'error');
        this.removePeer(from);
      }
    });

    this.socket.on('webrtc:answer', async ({ from, sdp }) => {
      const peer = this.peers.get(from);
      if (!peer) return;
      try {
        await peer.pc.setRemoteDescription(sdp);
        await this.flushPendingIce(peer);
      } catch (err) {
        console.error(`Bad answer from ${from}`, err);
        this.removePeer(from);
      }
    });

    this.socket.on('webrtc:ice', async ({ from, candidate }) => {
      const peer = this.peers.get(from);
      if (!peer) return;
      if (!peer.pc.remoteDescription) {
        peer.pendingIce.push(candidate);
        return;
      }
      await this.addIce(peer, candidate);
    });
  }

  private async connectTo(peerId: string): Promise<void> {
    const peer = this.createPeer(peerId, true);
    try {
      const offer = await peer.pc.createOffer();
      await peer.pc.setLocalDescription(offer);
      this.socket.emit('webrtc:offer', { to: peerId, sdp: { type: 'offer', sdp: offer.sdp ?? '' } });
    } catch (err) {
      console.error(`Could not call ${peerId}`, err);
      this.events.onNotice(`Could not connect to ${peerId}.`, 'error');
      this.removePeer(peerId);
    }
  }

  private createPeer(peerId: string, isOfferer: boolean): Peer {
    this.removePeer(peerId);
    const pc = new RTCPeerConnection({ iceServers: this.iceServers });
    const peer: Peer = { id: peerId, pc, pendingIce: [], stream: new MediaStream(), screenStream: null, isOfferer, restarts: 0 };
    this.peers.set(peerId, peer);

    const local = this.localStream ?? new MediaStream();
    this.localStream?.getAudioTracks().forEach((track) => pc.addTrack(track, local));
    const camera = this.cameraTrack();
    if (camera) pc.addTrack(camera, local); // the first video slot: the camera

    if (isOfferer) {
      // Still ask to receive audio we cannot send (no mic).
      if (!this.hasLocalTrack('audio')) pc.addTransceiver('audio', { direction: 'recvonly' });
      // Always negotiate video (even for voice calls), so cameras can be turned on later…
      if (!camera) pc.addTransceiver('video', { direction: 'sendrecv' });
      // …and a second slot for a screen share, shown next to the camera.
      pc.addTransceiver(this.screenTrack ?? 'video', { direction: 'sendrecv' });
    }

    pc.onicecandidate = ({ candidate }) => {
      if (candidate) this.socket.emit('webrtc:ice', { to: peerId, candidate: candidate.toJSON() as IceCandidate });
    };

    pc.ontrack = ({ track, transceiver }) => {
      // The second video slot carries their screen share.
      if (track.kind === 'video' && this.videoTransceivers(pc).indexOf(transceiver) === 1) {
        peer.screenStream = new MediaStream([track]);
        this.events.onPeerScreenStream(peerId, peer.screenStream);
        return;
      }
      if (!peer.stream.getTracks().includes(track)) peer.stream.addTrack(track);
      this.events.onPeerStream(peerId, peer.stream);
    };

    pc.onconnectionstatechange = () => {
      if (this.peers.get(peerId) !== peer) return;
      const state = pc.connectionState;
      clearTimeout(peer.restartTimer);
      if (state === 'connected') {
        peer.restarts = 0;
      } else if (state === 'disconnected' && peer.isOfferer) {
        // Usually a brief network hiccup that heals itself; restart ICE only if it doesn't.
        peer.restartTimer = setTimeout(() => void this.restartIce(peer), DISCONNECT_GRACE_MS);
      } else if (state === 'failed' && peer.isOfferer && peer.restarts < MAX_ICE_RESTARTS) {
        void this.restartIce(peer);
        this.events.onPeerConnectionState(peerId, 'disconnected'); // shown as "Reconnecting…"
        return;
      } else if (state === 'failed' && peer.isOfferer) {
        this.events.onNotice(`Connection to ${peerId} failed. A TURN server may be needed.`, 'error');
      }
      this.events.onPeerConnectionState(peerId, state);
    };

    this.events.onPeerStream(peerId, peer.stream);
    return peer;
  }

  /** Renegotiates with fresh ICE candidates (e.g. after switching from Wi-Fi to mobile data). */
  private async restartIce(peer: Peer): Promise<void> {
    if (this.peers.get(peer.id) !== peer || peer.pc.signalingState !== 'stable') return;
    if (!this.socket.connected || peer.pc.connectionState === 'connected') return;
    peer.restarts++;
    try {
      const offer = await peer.pc.createOffer({ iceRestart: true });
      if (this.peers.get(peer.id) !== peer) return;
      await peer.pc.setLocalDescription(offer);
      this.socket.emit('webrtc:offer', { to: peer.id, sdp: { type: 'offer', sdp: offer.sdp ?? '' } });
    } catch (err) {
      console.warn(`ICE restart with ${peer.id} failed`, err);
    }
  }

  private removePeer(peerId: string): void {
    const peer = this.peers.get(peerId);
    if (!peer) return;
    this.peers.delete(peerId);
    clearTimeout(peer.restartTimer);
    peer.pc.onicecandidate = peer.pc.ontrack = peer.pc.onconnectionstatechange = null;
    peer.pc.close();
    this.events.onPeerRemoved(peerId);
  }

  private async flushPendingIce(peer: Peer): Promise<void> {
    const queued = peer.pendingIce;
    peer.pendingIce = [];
    for (const candidate of queued) await this.addIce(peer, candidate);
  }

  private async addIce(peer: Peer, candidate: RTCIceCandidateInit): Promise<void> {
    try {
      await peer.pc.addIceCandidate(candidate);
    } catch (err) {
      console.warn('Failed to add ICE candidate', err);
    }
  }

  private async acquireMedia(video: boolean): Promise<MediaStream | null> {
    if (!navigator.mediaDevices?.getUserMedia) {
      this.events.onNotice('Camera/mic need HTTPS or localhost. You will only receive media.', 'error');
      return null;
    }
    try {
      return await navigator.mediaDevices.getUserMedia({ audio: true, video: video ? { facingMode: { ideal: this.facing } } : false });
    } catch (err) {
      if (video) {
        try {
          const audioOnly = await navigator.mediaDevices.getUserMedia({ audio: true });
          this.events.onNotice('Camera unavailable — continuing with audio only.');
          return audioOnly;
        } catch {
          /* fall through */
        }
      }
      console.warn('getUserMedia failed', err);
      this.events.onNotice('No access to microphone/camera. You will only receive media.', 'error');
      return null;
    }
  }

  private setLocalStream(stream: MediaStream | null): void {
    this.localStream = stream;
    this.events.onLocalStream(stream);
  }

  private setInfo(info: CallInfo): void {
    this.info = info;
    this.events.onStateChange({ ...info, participants: [...info.participants], invited: [...info.invited] });
  }

  private cleanup(): void {
    this.session++;
    this.accepting = false;
    stopNativeScreen(); // also a share still waiting at Android's prompt
    if (this.screenTrack) {
      this.screenTrack.onended = null;
      this.screenTrack.stop();
      this.screenTrack = null;
      this.events.onLocalScreen(null);
    }
    for (const peerId of [...this.peers.keys()]) this.removePeer(peerId);
    this.localStream?.getTracks().forEach((t) => t.stop());
    this.localStream = null;
    this.events.onLocalStream(null);
    this.setInfo({ ...IDLE });
  }
}
