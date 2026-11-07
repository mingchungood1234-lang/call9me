/**
 * The native Android app (android/, Kotlin). It shows this site in a WebView and adds what a
 * website can't do: ringing when the app is closed (Firebase push + a full-screen call screen),
 * and keeping calls going in the background (a foreground service).
 *
 * Page → app: `window.Call9meAndroid` (a JavaScript interface the app injects).
 * App → page: `window.call9meNative`, registered with {@link onNativeCommands}.
 */
export interface AndroidBridge {
  /** "unsupported" (no Firebase), "denied", "off" or "on". */
  pushStatus(): string;
  /** This install's Firebase token ("" if none yet). */
  pushToken(): string;
  /** Asks for notification permission and a token; answers with call9meNative.pushResult(). */
  enablePush(): void;
  /** "Turn notifications off": the app remembers it (the system permission is left alone). */
  disablePush(): void;
  /** Our call state, as JSON: { state, video, peers, roomId }. Starts/stops the background-call service. */
  callState(json: string): void;
  /** Light or dark theme, for the system bars. */
  setTheme(dark: boolean): void;
  // Screen sharing (src/client/lib/nativeScreen.ts). Missing in app versions before it.
  /** The app can share the screen here. */
  screenShareSupported?(): boolean;
  /** Shows Android's "Start sharing?" prompt; answers with call9meNative.screenShare(status). */
  startScreenShare?(): void;
  stopScreenShare?(): void;
  // Native calls (src/client/lib/nativeCall.ts). Missing in app versions before them.
  /** The app runs calls natively (its own WebRTC and call screen). */
  nativeCallsSupported?(): boolean;
  /** A message for the native call (JSON, see nativeCall.ts). */
  callMedia?(json: string): void;
}

/** Where a native screen share stands: started, refused at the prompt, failed, or stopped. */
export type NativeScreenStatus = 'started' | 'denied' | 'error' | 'ended';

/** What the app can ask the page to do. */
export interface NativeCommands {
  /** The user tapped Answer on the native call screen or notification. */
  answer(callId: string): void;
  /** Hang up (the ongoing-call notification's button). */
  hangUp(): void;
  /** The app went to the background (true) or came back (false). */
  background(away: boolean): void;
  /** Result of enablePush(): status, and the token when "on". */
  pushResult(status: string, token: string): void;
  /** Screen sharing started, was refused or failed, or ended (also from Android's own controls). */
  screenShare(status: NativeScreenStatus): void;
  /** A message from the native call (JSON, see nativeCall.ts). */
  callMedia(json: string): void;
}

declare global {
  interface Window {
    Call9meAndroid?: AndroidBridge;
    call9meNative?: Partial<NativeCommands>;
  }
}

export const nativeBridge: AndroidBridge | undefined = window.Call9meAndroid;

/** True inside the native Android app. */
export function inNativeApp(): boolean {
  return !!nativeBridge || /\bCall9meAndroid\//.test(navigator.userAgent);
}

/** Registers (or extends) the commands the app can call. */
export function onNativeCommands(commands: Partial<NativeCommands>): void {
  window.call9meNative = { ...window.call9meNative, ...commands };
}
