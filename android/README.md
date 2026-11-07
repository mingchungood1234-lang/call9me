# Call9me for Android

A native Kotlin app for Call9me. Android visitors to the website are sent to download it.

The screens are the Call9me website shown inside the app, so the design matches the site, and every site deploy reaches the app straight away. Around them, the app adds native features a website can't offer:

| Feature | How |
|---|---|
| **Calls ring with the app closed**: a full-screen call screen (over the lock screen too) with Answer and Decline, the phone's ringtone and vibration | Firebase Cloud Messaging (FCM). See [Set up Firebase](#set-up-firebase) below. |
| **Calls continue in the background**: app minimised, screen off, or swiped from recents | A foreground service with an "ongoing call" notification and a **Hang up** button. |
| **Native look**: splash screen, edge-to-edge system bars that follow the page's light/dark theme, back button, no zoom | `MainActivity` |
| Camera, microphone, notification and file permissions | Android's own prompts |
| "Continue with Google" | Google blocks sign-in inside apps. It opens in a Chrome Custom Tab and hands the session back to the app. |
| Chat messages, missed calls and friend requests as notifications | FCM |
| **Native calls**: Android's own WebRTC, camera, microphone and speaker/earpiece/headset routing, on a native call screen that fits portrait and landscape (grid, spotlight a tile, your camera floating in one-to-one calls), picture-in-picture when you leave the app, "Back to chat" while the call continues | `NativeCall.kt` (media, the same peer rules as `CallManager.ts`, so browsers can't tell the difference), `CallActivity.kt` + `TileGrid.kt` (screen), `AudioRouter.kt`. The page keeps the call's logic and the socket; `src/client/lib/nativeCall.ts` relays signaling. |
| **Screen sharing**: Android's own "Start sharing?" prompt (whole screen or one app), keeps going while you use other apps, **Stop sharing** in the call notification | `ScreenShare.kt` (MediaProjection) sends frames to the page, which makes them a video track (`src/client/lib/nativeScreen.ts`). The WebView alone can't share the screen. |
| **Updates itself**: when the site has a newer APK, the app offers **Update** and installs it in place | `Updater.kt` checks `/download/android/version` when the app opens (at most hourly, never during a call). Android asks the user once to allow installs from Call9me, then confirms each update. |

When the app is in the background and not in a call, it disconnects from the server after 15 seconds, and calls then ring through FCM. This is the normal pattern for calling apps, and it saves battery.

## Code

| File | Purpose |
|---|---|
| `MainActivity.kt` | The screen: hosts the site, permissions, theme, links, Answer |
| `NativeCall.kt`, `CallActivity.kt`, `TileGrid.kt`, `AudioRouter.kt` | Native calls: media engine, call screen, video layout, audio routing |
| `WebViewHolder.kt` | Keeps the page (and the call) alive when the screen goes away; the JavaScript bridge `window.Call9meAndroid` |
| `CallService.kt` | Foreground service for background calls |
| `PushService.kt`, `Push.kt` | FCM: incoming calls, call cancelled, messages, token |
| `Notifications.kt` | Ringing call notification, ongoing call, messages |
| `IncomingCallActivity.kt` | Native full-screen incoming call |
| `CallActionReceiver.kt` | Decline and Hang up buttons |

On the web side, see `src/client/lib/nativeApp.ts` (bridge), `lib/push.ts` (`AndroidPush`), and on the server `services/Fcm.ts`, `models/FcmTokenModel.ts` and `services/PushService.ts`.

## Build it

You only need Docker. No Android Studio or Java is required.

```bash
npm run android:build                              # opens PUBLIC_URL from .env
npm run android:build -- --host call9me.com        # or name the domain
```

This writes `public/downloads/call9me.apk`, served at `/download/android`, and `public/downloads/android.json`. Commit both and deploy as usual. The package name and signing key are the same as before, so an installed copy updates in place.

## Set up Firebase

You need Firebase so calls ring with the app closed. Without it the app still works, but calls only ring while the app is open or was used in the last 15 seconds. The notification bell is hidden in that case.

1. Go to the [Firebase console](https://console.firebase.google.com) and create a project (free).
2. **Add app** → Android. Package name: `com.call9me.app`.
3. Download **`google-services.json`** into `android/app/`. It identifies your Firebase project and isn't secret, so it can be committed.
4. On the server, go to **Project settings → Service accounts → Generate new private key**. This JSON file **is secret**. Give it to the server in one of these ways:
   - Copy it to the data volume as `data/fcm-service-account.json`.
     For Docker: `docker cp key.json call9me:/app/data/fcm-service-account.json`, then restart.
   - Or set `FCM_SERVICE_ACCOUNT_FILE=/path/to/key.json`.
   - Or set `FCM_SERVICE_ACCOUNT=<the JSON, or base64 of it>` in `.env`.

   Then restart. The log shows `[fcm] Android push on (Firebase project …)`.
5. Run `npm run android:build` again and deploy.
6. In the app, tap the bell and allow notifications. On Android 14 and later, the app may also open a settings page so the full-screen call screen can appear; allow it there too.

## Android visitors

When an APK exists, Android browser tabs are sent to `/get-app` to download the app or open it, and Chrome isn't offered the website as a PWA. People who already added the PWA to their home screen are asked to switch each time they open it. The app adds `Call9meAndroid/<version>` to its user agent, so the site never sends the app itself to the download page.

## The signing key: back it up

The first build created `android/keystore/` (git-ignored) with the release key and its password. **Keep a private copy of it.** Every update must be signed with the same key, or phones refuse the update.

## Debugging

To see a crash, connect the phone with USB debugging on and run `adb logcat -s AndroidRuntime chromium Call9me`.
