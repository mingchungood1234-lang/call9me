import type { IceCandidate } from '../../shared/types';
import type { AppSocket } from './socket';

export type CallState = 'idle' | 'incoming' | 'in-call';

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
  /** Set while state is "incoming". */
  incomingFrom: string | null;
}

export interface CallEvents {
  onStateChange(info: CallInfo): void;
  /** `isScreen` is true while the local preview shows our own screen share. */
  onLocalStream(stream: MediaStream | null, isScreen: boolean): void;
  onPeerStream(peerId: string, stream: MediaStream): void;
  onPeerConnectionState(peerId: string, state: RTCPeerConnectionState): void;
  onPeerRemoved(peerId: string): void;
  onPeerScreen(peerId: string, sharing: boolean): void;
  onLocalScreen(sharing: boolean): void;
  onIncoming(from: string, video: boolean, participants: string[], roomId: string | null): void;
  onNotice(message: string, kind?: 'info' | 'success' | 'error'): void;
}

interface Peer {
  id: string;
  pc: RTCPeerConnection;
  pendingIce: RTCIceCandidateInit[];
  stream: MediaStream;
}

export const IDLE_CALL: CallInfo = {
  state: 'idle',
  callId: null,
  roomId: null,
  video: true,
  participants: [],
  invited: [],
  incomingFrom: null,
};
const IDLE = IDLE_CALL;

/** Screen capture exists only in desktop browsers; phones can view a share but not start one. */
export function canShareScreen(): boolean {
  return (
    typeof navigator.mediaDevices?.getDisplayMedia === 'function' &&
    !window.matchMedia('(pointer: coarse)').matches
  );
}

/**
 * Group calls as a full mesh: one RTCPeerConnection per other participant.
 *
 * Joining: whoever accepts an invite sends an offer to every existing participant,
 * so each pair has exactly one offerer (no glare). Every connection negotiates a
 * send-capable video transceiver (even voice calls), so a screen share can be
 * switched on later with `replaceTrack` and no renegotiation.
 */
export class CallManager {
  private info: CallInfo = { ...IDLE };
  private readonly peers = new Map<string, Peer>();
  private localStream: MediaStream | null = null;
  private screenTrack: MediaStreamTrack | null = null;
  /** Incremented on every cleanup so stale async continuations can bail out. */
  private session = 0;

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
    if (this.info.state === 'in-call') {
      this.socket.emit('call:invite', { to, video: this.info.video }, (res) => {
        if (!res.ok) this.events.onNotice(res.error, 'error');
        else if (res.offline) this.events.onNotice(`${res.to} is offline — ringing their device with a notification…`);
        else this.events.onNotice(`Ringing ${res.to}…`);
      });
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

    this.socket.emit('call:invite', { to, video }, (res) => {
      if (session !== this.session) {
        if (res.ok) this.socket.emit('call:leave');
        return;
      }
      if (!res.ok) {
        this.events.onNotice(res.error, 'error');
        this.cleanup();
        return;
      }
      this.setInfo({ ...this.info, callId: res.callId });
      if (res.offline) this.events.onNotice(`${res.to} is offline — ringing their device with a notification…`);
    });
  }

  /** Joins the call room with this ID (everyone using the same ID meets there). */
  async joinRoom(roomId: string, video: boolean): Promise<void> {
    if (this.info.state !== 'idle') {
      this.events.onNotice('Leave the current call first.', 'error');
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

    this.socket.emit('call:join-room', { roomId, video }, (res) => {
      if (session !== this.session) {
        if (res.ok) this.socket.emit('call:leave');
        return;
      }
      if (!res.ok) {
        this.events.onNotice(res.error, 'error');
        this.cleanup();
        return;
      }
      this.setInfo({ ...this.info, callId: res.callId, roomId: res.roomId, participants: res.participants });
      for (const peerId of res.participants) void this.connectTo(peerId);
    });
  }

  async acceptIncoming(): Promise<void> {
    const { state, callId, video } = this.info;
    if (state !== 'incoming' || !callId) return;
    const session = this.session;

    const stream = await this.acquireMedia(video);
    if (session !== this.session) {
      stream?.getTracks().forEach((t) => t.stop());
      return;
    }
    this.setLocalStream(stream);
    this.setInfo({ ...this.info, state: 'in-call', incomingFrom: null });

    this.socket.emit('call:accept', { callId }, (res) => {
      if (session !== this.session) {
        if (res.ok) this.socket.emit('call:leave');
        return;
      }
      if (!res.ok) {
        this.events.onNotice(res.error, 'error');
        this.cleanup();
        return;
      }
      this.setInfo({ ...this.info, participants: res.participants });
      for (const peerId of res.participants) void this.connectTo(peerId);
    });
  }

  rejectIncoming(reason = 'declined'): void {
    if (this.info.state !== 'incoming' || !this.info.callId) return;
    this.socket.emit('call:reject', { callId: this.info.callId, reason });
    this.cleanup();
  }

  hangUp(): void {
    if (this.info.state === 'idle') return;
    if (this.info.state === 'incoming') return this.rejectIncoming();
    if (this.info.callId) this.socket.emit('call:leave');
    this.cleanup();
  }

  /** Ends the call locally without notifying the server (e.g. after a disconnect). */
  reset(): void {
    if (this.info.state !== 'idle') this.cleanup();
  }

  /** @returns whether the microphone is now enabled. */
  toggleMic(): boolean {
    return this.toggleTracks(this.localStream?.getAudioTracks() ?? []);
  }

  /** @returns whether the camera is now enabled. */
  toggleCamera(): boolean {
    return this.toggleTracks(this.localStream?.getVideoTracks() ?? []);
  }

  hasLocalTrack(kind: 'audio' | 'video'): boolean {
    return (this.localStream?.getTracks().filter((t) => t.kind === kind).length ?? 0) > 0;
  }

  async startScreenShare(): Promise<void> {
    if (this.state !== 'in-call' || this.screenTrack) return;

    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
    } catch {
      return; // The user closed the picker.
    }
    const track = stream.getVideoTracks()[0];
    if (!track || this.state !== 'in-call') {
      stream.getTracks().forEach((t) => t.stop());
      return;
    }

    track.contentHint = 'detail';
    this.screenTrack = track;
    // Fires when the user presses the browser's own "Stop sharing" bar.
    track.onended = () => void this.stopScreenShare();
    await this.replaceOutgoingVideo(track);

    this.events.onLocalStream(stream, true);
    this.events.onLocalScreen(true);
    this.socket.emit('call:screen', { sharing: true });
  }

  async stopScreenShare(): Promise<void> {
    const track = this.screenTrack;
    if (!track) return;
    this.screenTrack = null;
    track.onended = null;
    track.stop();

    await this.replaceOutgoingVideo(this.cameraTrack());
    if (this.state !== 'idle') {
      this.events.onLocalStream(this.localStream, false);
      this.socket.emit('call:screen', { sharing: false });
    }
    this.events.onLocalScreen(false);
  }

  // ---- Internals ----

  private cameraTrack(): MediaStreamTrack | null {
    return this.localStream?.getVideoTracks()[0] ?? null;
  }

  private async replaceOutgoingVideo(track: MediaStreamTrack | null): Promise<void> {
    await Promise.all(
      [...this.peers.values()].map((peer) => this.videoSender(peer.pc)?.replaceTrack(track).catch(() => {})),
    );
  }

  private toggleTracks(tracks: MediaStreamTrack[]): boolean {
    if (tracks.length === 0) return false;
    const enabled = !tracks[0].enabled;
    tracks.forEach((t) => (t.enabled = enabled));
    return enabled;
  }

  private videoSender(pc: RTCPeerConnection): RTCRtpSender | undefined {
    return pc.getTransceivers().find((t) => t.receiver.track.kind === 'video' && t.currentDirection !== 'stopped')
      ?.sender;
  }

  private bindSocket(): void {
    this.socket.on('call:incoming', ({ callId, roomId, from, video, participants }) => {
      if (this.info.state !== 'idle') return; // Server guards this; be defensive anyway.
      this.setInfo({ ...IDLE, state: 'incoming', callId, roomId, video, participants, incomingFrom: from });
      this.events.onIncoming(from, video, participants, roomId);
    });

    this.socket.on('call:cancelled', ({ callId, reason }) => {
      if (this.info.state !== 'incoming' || callId !== this.info.callId) return;
      this.events.onNotice(`Missed call from ${this.info.incomingFrom} (${reason}).`);
      this.cleanup();
    });

    this.socket.on('call:update', ({ callId, roomId, participants, invited }) => {
      if (this.info.state !== 'in-call' || callId !== this.info.callId) return;
      const others = participants.filter((p) => p !== this.selfId);
      // Keep our own `video` choice: in call rooms each person picks camera or audio-only.
      this.setInfo({ ...this.info, roomId, participants: others, invited });
    });

    this.socket.on('call:peer-joined', ({ callId, userId }) => {
      if (callId !== this.info.callId) return;
      this.events.onNotice(`${userId} joined the call.`, 'success');
      // Let the newcomer know we're sharing (their offer to us will arrive shortly).
      if (this.screenTrack) this.socket.emit('call:screen', { sharing: true });
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
    const peer: Peer = { id: peerId, pc, pendingIce: [], stream: new MediaStream() };
    this.peers.set(peerId, peer);

    const local = this.localStream ?? new MediaStream();
    this.localStream?.getAudioTracks().forEach((track) => pc.addTrack(track, local));
    const outgoingVideo = this.screenTrack ?? this.cameraTrack();
    if (outgoingVideo) pc.addTrack(outgoingVideo, local);

    if (isOfferer) {
      // Still ask to receive audio we cannot send (no mic).
      if (!this.hasLocalTrack('audio')) pc.addTransceiver('audio', { direction: 'recvonly' });
      // Always negotiate video (even for voice calls) so anyone can share a screen later.
      if (!outgoingVideo) pc.addTransceiver('video', { direction: 'sendrecv' });
    }

    pc.onicecandidate = ({ candidate }) => {
      if (candidate) this.socket.emit('webrtc:ice', { to: peerId, candidate: candidate.toJSON() as IceCandidate });
    };

    pc.ontrack = ({ track }) => {
      if (!peer.stream.getTracks().includes(track)) peer.stream.addTrack(track);
      this.events.onPeerStream(peerId, peer.stream);
    };

    pc.onconnectionstatechange = () => {
      if (this.peers.get(peerId) !== peer) return;
      this.events.onPeerConnectionState(peerId, pc.connectionState);
      if (pc.connectionState === 'failed') {
        this.events.onNotice(`Connection to ${peerId} failed. A TURN server may be needed.`, 'error');
      }
    };

    this.events.onPeerStream(peerId, peer.stream);
    return peer;
  }

  private removePeer(peerId: string): void {
    const peer = this.peers.get(peerId);
    if (!peer) return;
    this.peers.delete(peerId);
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
      return await navigator.mediaDevices.getUserMedia({ audio: true, video });
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
    this.events.onLocalStream(stream, false);
  }

  private setInfo(info: CallInfo): void {
    this.info = info;
    this.events.onStateChange({ ...info, participants: [...info.participants], invited: [...info.invited] });
  }

  private cleanup(): void {
    this.session++;
    if (this.screenTrack) {
      this.screenTrack.onended = null;
      this.screenTrack.stop();
      this.screenTrack = null;
      this.events.onLocalScreen(false);
    }
    for (const peerId of [...this.peers.keys()]) this.removePeer(peerId);
    this.localStream?.getTracks().forEach((t) => t.stop());
    this.localStream = null;
    this.events.onLocalStream(null, false);
    this.setInfo({ ...IDLE });
  }
}
