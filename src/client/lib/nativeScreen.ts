import { nativeBridge, onNativeCommands, type NativeScreenStatus } from './nativeApp';

/**
 * Screen sharing in the Android app. Its WebView has no getDisplayMedia, so the app captures the
 * screen itself (Android's MediaProjection: the system prompt, whole screen or one app) and sends
 * JPEG frames over `window.call9meScreen` (android/…/ScreenShare.kt). Here they become an
 * ordinary video track, which CallManager sends like any screen share. Viewers can't tell the
 * difference.
 *
 * Each frame is acked once drawn, so the app never sends faster than this page can draw.
 */

/** The app's frame channel (a WebMessage listener object the app adds to our pages). */
interface ScreenChannel {
  postMessage(message: string): void;
  addEventListener(type: 'message', listener: (event: MessageEvent) => void): void;
}

/** Chrome's "breakout box" track source (not in TypeScript's DOM types yet). */
interface TrackGenerator extends MediaStreamTrack {
  readonly writable: WritableStream<VideoFrame>;
}
type TrackGeneratorConstructor = new (init: { kind: 'video' }) => TrackGenerator;

declare global {
  interface Window {
    call9meScreen?: ScreenChannel;
    MediaStreamTrackGenerator?: TrackGeneratorConstructor;
  }
}

/** Turns pictures into a video track. */
interface FrameSink {
  readonly track: MediaStreamTrack;
  draw(bitmap: ImageBitmap): void;
  /** Sends the last picture again (the app only sends frames when the screen changes). */
  repeat(): void;
  close(): void;
}

/** With MediaStreamTrackGenerator: frames go straight into the track. */
function generatorSink(Generator: TrackGeneratorConstructor): FrameSink {
  const track = new Generator({ kind: 'video' });
  const writer = track.writable.getWriter();
  let last: ImageBitmap | null = null;
  const write = (bitmap: ImageBitmap) => {
    const frame = new VideoFrame(bitmap, { timestamp: Math.round(performance.now() * 1000) });
    writer.write(frame).catch(() => frame.close());
  };
  return {
    track,
    draw(bitmap) {
      last?.close();
      last = bitmap;
      write(bitmap);
    },
    repeat() {
      if (last) write(last);
    },
    close() {
      last?.close();
      last = null;
      void writer.close().catch(() => {});
      track.stop();
    },
  };
}

/** Fallback: draw on a canvas and capture it. */
function canvasSink(): FrameSink {
  const canvas = document.createElement('canvas');
  canvas.width = 2;
  canvas.height = 2;
  const context = canvas.getContext('2d');
  const track = canvas.captureStream().getVideoTracks()[0];
  let last: ImageBitmap | null = null;
  const paint = (bitmap: ImageBitmap) => {
    if (canvas.width !== bitmap.width || canvas.height !== bitmap.height) {
      canvas.width = bitmap.width;
      canvas.height = bitmap.height;
    }
    context?.drawImage(bitmap, 0, 0);
  };
  return {
    track,
    draw(bitmap) {
      last?.close();
      last = bitmap;
      paint(bitmap);
    },
    repeat() {
      if (last) paint(last);
    },
    close() {
      last?.close();
      last = null;
      track.stop();
    },
  };
}

interface Share {
  sink: FrameSink;
  stream: MediaStream;
  started: boolean;
  lastFrameAt: number;
  repeatTimer: ReturnType<typeof setInterval>;
  /** Settles startNativeScreen() once the app answers. */
  settle: ((stream: MediaStream | null) => void) | null;
  onEnded: () => void;
}

/** A newcomer to the call gets a picture within this long, even if the screen is still. */
const REPEAT_MS = 1000;

let current: Share | null = null;
let listening = false;

/** True in an Android app that can share the screen. */
export function canShareNativeScreen(): boolean {
  try {
    return !!window.call9meScreen && typeof nativeBridge?.startScreenShare === 'function' && nativeBridge.screenShareSupported?.() === true;
  } catch {
    return false;
  }
}

/**
 * Asks Android to share the screen. Resolves with the screen's video once the user agrees, or
 * null if they don't (or it fails). `onEnded`: the share stopped from Android's side (its
 * notification, status bar or lock screen), so the call should stop sending it.
 */
export function startNativeScreen(onEnded: () => void): Promise<MediaStream | null> {
  const channel = window.call9meScreen;
  const bridge = nativeBridge;
  if (!channel || !bridge?.startScreenShare) return Promise.resolve(null);
  stopNativeScreen();
  listen(channel);

  const Generator = window.MediaStreamTrackGenerator;
  const sink = typeof Generator === 'function' && typeof VideoFrame === 'function' ? generatorSink(Generator) : canvasSink();
  return new Promise((resolve) => {
    const share: Share = {
      sink,
      stream: new MediaStream([sink.track]),
      started: false,
      lastFrameAt: 0,
      repeatTimer: setInterval(() => {
        if (share.started && performance.now() - share.lastFrameAt >= REPEAT_MS) {
          share.lastFrameAt = performance.now();
          sink.repeat();
        }
      }, REPEAT_MS),
      settle: resolve,
      onEnded,
    };
    current = share;
    channel.postMessage('hello'); // so the app knows where to send frames
    bridge.startScreenShare?.();
  });
}

/** Stops our screen share (the app stops capturing). Safe to call when not sharing. */
export function stopNativeScreen(): void {
  const share = current;
  if (!share) return;
  finish(share, null);
  nativeBridge?.stopScreenShare?.();
}

function finish(share: Share, result: MediaStream | null): void {
  if (current === share) current = null;
  clearInterval(share.repeatTimer);
  share.sink.close();
  share.settle?.(result);
  share.settle = null;
}

function listen(channel: ScreenChannel): void {
  if (listening) return;
  listening = true;
  channel.addEventListener('message', (event) => void onFrame(channel, event.data));
}

async function onFrame(channel: ScreenChannel, data: unknown): Promise<void> {
  try {
    const share = current;
    if (!share) return;
    const bytes = data instanceof ArrayBuffer ? data : typeof data === 'string' ? fromBase64(data) : null;
    if (!bytes) return;
    const bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/jpeg' }));
    if (current !== share) {
      bitmap.close();
      return;
    }
    share.lastFrameAt = performance.now();
    share.sink.draw(bitmap);
  } catch {
    // A bad frame: skip it.
  } finally {
    channel.postMessage('ack'); // ready for the next one
  }
}

function fromBase64(text: string): ArrayBuffer {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

function onStatus(status: NativeScreenStatus): void {
  const share = current;
  if (!share) return;
  if (status === 'started') {
    share.started = true;
    share.settle?.(share.stream);
    share.settle = null;
    return;
  }
  // Refused at the prompt or failed (before starting), or stopped from Android's side.
  const wasStarted = share.started;
  finish(share, null);
  if (wasStarted) share.onEnded();
}

onNativeCommands({ screenShare: onStatus });
