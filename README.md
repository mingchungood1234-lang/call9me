# Call9me

Real-time group video and voice calls, screen sharing and public chat rooms. Calls use WebRTC. The backend is Node.js (Express and Socket.IO) laid out as MVC, and the frontend is TypeScript. It can be installed as a PWA, with push notifications.

## Quick start

```bash
npm install
npm run build
npm start            # http://localhost:3000
```

Development mode, with the server, client and service worker rebuilt as you edit:

```bash
npm run dev
```

To try it, open two or more browser windows (incognito counts as a separate person), sign in with a different ID in each, and call one from another.

## Docker (VPS)

```bash
cp .env.example .env          # fill in TURN_* (your coturn) etc.
docker compose up -d --build
docker compose logs -f        # check the "ICE servers:" line
```
The app listens on `127.0.0.1:3000`, so put an HTTPS reverse proxy in front of it. The proxy must forward WebSocket upgrades for `/socket.io/`. Accounts, push subscriptions and VAPID keys are kept in the `call9me-data` volume, so they survive rebuilds. To update after pulling new code, run `docker compose up -d --build` again.

## Features

- **Sign in with ID + PIN.** The ID is 3–20 English letters, digits or `_`, starting with a letter. The PIN is 4 digits. There is no email or SMS verification: the first sign-in with an ID creates it with that PIN, and later sign-ins must use the same PIN. Every five wrong PINs lock the ID, for longer each time (1 min, 5 min, 15 min, 1 h, 6 h, then 24 h); a day without wrong PINs resets this, and lockouts survive restarts. PINs are stored as salted scrypt hashes.
- **Sign in on several devices.** One ID can be open on up to 5 devices or tabs at once (`MAX_DEVICES_PER_USER`). Calls ring on all of them; the device that answers takes the call and the others stop ringing. Chats, rooms and friends stay in sync. Signing out only signs out that device.
- **Sign in with a QR code.** On the sign-in page, choose "Sign in with a QR code". On a device that's already signed in, open the profile menu → **Sign in another device** and scan the code with the camera, or type it in. You see which browser is asking before approving. Codes work once and expire after 2 minutes. The scanner is built into the app because an iPhone home-screen app doesn't share its sign-in with Safari.
- **Admin dashboard** at `/admin`, for the IDs in `ADMIN_IDS` (others get a 404). It asks for `ADMIN_PASSCODE` after signing in and locks again after 15 idle minutes. **Overview**: who's online, calls in progress, lockouts. **Users**: sign out everywhere, set a new PIN, lift a PIN lockout, suspend, delete (other admins are managed in `.env`). **Rooms**: every room including private ones, remove or ban members, clear chat history (the Public chat too), delete rooms. **Audit log**: every admin action and wrong passcode, in `data/admin-log.json`. Open it from the profile menu → Admin dashboard.
- **Rate limits.** Per IP address: 10 sign-ins per minute, 5 new IDs per hour, and limits on QR codes and ID lookups. Per user: limits on messages, invites, friend requests, shares and uploads. Behind a reverse proxy, set `TRUST_PROXY` so the real client address is used; otherwise everyone shares the proxy's limits.
- **Group calls.** Up to 8 people per call (configurable). Start a video or voice call, then add more people from the online list or by ID; anyone already in the call can add people. Unanswered invites ring for 30 seconds. Controls: mute, camera on/off, share screen and leave.
- **Full-screen calls.** A call covers the whole app; ⌄ minimizes it (a pill brings it back). Everyone, you included, gets an equal tile: two people split the screen in halves (side by side, or one above the other on an upright phone). Tap any tile to maximize it, with the others in a strip below; tap it again (or the grid button) to go back. **Flip** switches between the front and back camera mid-call.
- **Screen sharing like Discord.** A share is a tile of its own next to the sharer's camera (both stay on), marked Live. Others choose to watch: **Watch stream** maximizes it, **Stop watching** puts it back. People on an older version of the app see the share in place of the camera, as before.
- **Move a call to another device.** Signed in on a phone and a laptop? A call on one shows "Move call here" on the other: the call moves without hanging up, and the others only see "switched devices".
- **One minute to rejoin.** When someone leaves or drops out of a call, it waits a minute for them: they get a **Rejoin** button, and an app that only lost its connection rejoins by itself.
- **Call rooms.** In the Call panel, choose "Join a room" and enter a room ID. Everyone who joins the same ID is in the same group call, with no invites needed. A room stays open while anyone is in it, and you can share it as a link (`/app?call=<room>`). If you open the link while signed out, you're returned to it after signing in.
- **Screen sharing.** Available on desktop browsers. Phones can't capture their screen from a browser, so they can only watch a share, and while someone is sharing, a phone shows just the shared screen at full size. Viewers can't pause a share: call videos have no controls, and anything that pauses one (a tap, the iPhone full-screen player, media keys, or the app going to the background) starts it again.
- **Public chat rooms.** Join any room by its ID; everyone using the same ID is in the same room. Shows who is in the room and the last 100 messages.
- **Installable PWA and push notifications.** Notifications cover incoming calls, missed calls and new chat messages, and only appear when the app isn't on screen.
  - **Calls ring a closed app.** If the person called has notifications on, their device rings for 45 seconds even when the app is closed. The notification has Answer and Decline buttons on Android and desktop. Answering, or simply tapping the notification, opens the app and joins the call. Decline works without opening the app. If the phone locks while ringing, it keeps ringing instead of declining.
  - **Offline users can still be reached.** The people list also shows offline users who have notifications on, marked "Offline · rings their phone", and calling them rings their phone. Chat rooms keep sending notifications after the app is closed, until the user leaves the room or signs out. The app reopens the last chat room.
  - **Staying signed in.** Sign-in lasts 30 days and renews with use. Sessions are saved in `data/sessions.json` (only hashes of the tokens), so restarts and redeploys don't sign anyone out.
  - In the installed app, a banner asks users to turn on notifications if they haven't yet.
  - **No zooming in the installed app.** Pinch, double-tap and Ctrl/⌘ + zoom are disabled when Call9me runs as an installed app. In a normal browser tab, zoom still works for accessibility.
- **Phone layout.** On phones the app switches to a bottom tab bar (People / Call / Chat), with large touch targets, safe-area insets for notched screens, and a bottom-sheet incoming-call dialog. A landscape layout gives the video more room.
- **Android app.** On Android, Call9me is an app only. Browser tabs are sent to `/get-app` to download the APK from `/download/android` or open the app. Chrome isn't offered the PWA install, and old home-screen PWAs are asked to switch. The app is native Kotlin: calls ring with it closed on a full-screen call screen (Firebase), and continue in the background. The app opens the site full screen, with no browser bar, so every site update reaches it right away. Calls, push notifications that ring a closed app, and Google sign-in all work as on the web. Build it with `npm run android:build`; see [android/README.md](android/README.md).
- **Light and dark mode.** The app follows the system setting by default, and the toggle in the top bar remembers your choice.

## Structure

```
src/
  shared/                 Types + validation used by server and client (typed Socket.IO contract)
  server/                 Node.js backend (MVC)
    models/               UserModel (online users), CallModel (group calls), RoomModel (chat),
                          AccountModel (ID + PIN hash), SessionModel, PushSubscriptionModel
    controllers/          PageController, AuthController, UserController, PushController,
                          SignalingController (call lifecycle + WebRTC relay), ChatController
    services/PushService  Web Push sending (VAPID)
    middleware/session    Cookie session → user
    routes/, sockets/     Express routes, Socket.IO auth + wiring
  client/                 TypeScript frontend (bundled with esbuild → public/js)
    landing.ts            Sign-in page
    app.ts                Main page: users, call stage, chat, notifications, tabs
    sw.ts                 Service worker: push notifications, offline fallback
    lib/CallManager.ts    Mesh of RTCPeerConnections + screen sharing
    lib/ChatPanel.ts, lib/MobileTabs.ts, lib/push.ts, lib/theme.ts
views/                    EJS templates (the "V" in MVC)
public/                   CSS, manifest, icons (regenerate with `npm run icons`)
data/                     Accounts, push subscriptions, VAPID keys (git-ignored)
```

### How group calls work

Group calls are a full mesh: every participant has a direct WebRTC connection to every other participant.

1. The caller sends `call:invite`, and the server creates a call and rings the person invited.
2. That person accepts. The server replies with the list of current participants.
3. The newcomer sends an offer to each of them, so every pair has exactly one side making the offer.
4. Offers, answers and ICE candidates are passed on only between members of the same call.

Every connection also sets up a video channel that can send, even in voice calls. That lets screen sharing switch tracks with `replaceTrack`, without renegotiating the connection.

A mesh works well for small groups. Each person uploads one stream per other participant, so for calls much bigger than 6–8 people, use a media server (an SFU such as mediasoup or LiveKit) instead.

## Configuration

Copy `.env.example` to `.env` at the project root and fill it in. Variables set in the real environment (pm2, systemd, shell) override the file.

### Using your own coturn server

In `.env`:
```env
STUN_URLS=stun:turn.yourdomain.com:3478
TURN_URLS=turn:turn.yourdomain.com:3478?transport=udp,turn:turn.yourdomain.com:3478?transport=tcp,turns:turn.yourdomain.com:5349
TURN_USERNAME=call9me
TURN_PASSWORD=YourStrongPassword
```
The username and password must match a `user=call9me:YourStrongPassword` line in coturn's `/etc/turnserver.conf`, and coturn must have `lt-cred-mech` enabled. Restart Call9me after editing `.env`. The startup log prints the ICE servers in use, without the password.

| Env var                 | Default                    | Notes |
|-------------------------|----------------------------|-------|
| `PORT` / `HOST`         | `3000` / `0.0.0.0`         | |
| `STUN_URLS`             | Google public STUN         | Comma-separated. |
| `TURN_URLS` / `TURN_USERNAME` / `TURN_PASSWORD` | none | Your TURN server, for example coturn. Needed for users on strict NATs or mobile networks. |
| `ICE_SERVERS`           | none                       | Advanced: a full JSON array of `RTCIceServer` objects. If set, it overrides `STUN_URLS` and the `TURN_*` settings. |
| `MAX_CALL_PARTICIPANTS` | `8`                        | |
| `MAX_DEVICES_PER_USER`  | `5`                        | Devices (app tabs) one ID can be signed in on at the same time. |
| `ADMIN_IDS`             | none                       | Comma-separated admin IDs: they post in the Public chat and get `/admin`. |
| `ADMIN_PASSCODE`        | none                       | Unlocks the admin dashboard (12+ characters). Without it the dashboard stays off. |
| `DATA_DIR`              | `./data`                   | Where accounts, push subscriptions and VAPID keys are stored. |
| `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` | generated into `data/vapid.json` | Keep these stable: if they change, every existing push subscription stops working. |
| `VAPID_SUBJECT`         | `mailto:admin@call9me.local` | Set this to your own contact address. |
| `ANDROID_CERT_SHA256`   | none                       | Extra signing-certificate fingerprints (comma-separated `AA:BB:…`) for `/.well-known/assetlinks.json`, e.g. Google Play's app signing key. The APK's own fingerprint is added by `npm run android:build`. |

## Notes

- **HTTPS is required** for camera and microphone access, service workers and push notifications. `localhost` is the only exception. To use the app from phones, put it behind HTTPS, for example with a reverse proxy, a tunnel such as Cloudflare Tunnel or ngrok, or hosting.
- **iPhone and iPad:** push notifications only work after the user taps Share → **Add to Home Screen** and opens Call9me from the home screen (iOS 16.4 or later). The bell button explains this when it applies.
- **iPhone notifications not arriving?**
  1. Set `VAPID_SUBJECT=mailto:you@yourdomain.com` in `.env`. Apple rejects the default `@call9me.local` address, and the server warns about this at startup.
  2. Use iOS 16.4 or later, and add Call9me to the Home Screen.
  3. Turn notifications on from inside the installed app.
  4. Use the bell → **Send test notification**. It shows the answer from Apple's push server (`web.push.apple.com`). Rejected pushes are also logged as `[push] … rejected the push`.
  5. On the iPhone, check Settings → Notifications → Call9me, and Focus modes.
- Online users, calls and chat messages are kept in memory, so they reset when the server restarts. Accounts, sign-in sessions, push subscriptions and chat-room followers are stored in `data/` and survive restarts.
