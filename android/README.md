# Call9me for Android

An installable Android app (APK) for Call9me, offered to Android visitors on the website.

It's a **Trusted Web Activity**: the app opens your Call9me site full screen, using the phone's Chrome engine and without a browser bar. As a result:

- It has the same design as the website, and every site deploy reaches the app at once, with no APK update needed.
- Calls (camera, microphone, WebRTC) work exactly as in Chrome.
- Push notifications ring the phone even when the app is closed. They show up as Call9me's, with Answer and Decline buttons.
- "Continue with Google" works. Google blocks sign-in inside plain WebView apps.
- Call links such as `https://your-domain/app?call=room` open in the app.

It needs Chrome (or another browser that supports TWAs, such as Edge or Samsung Internet) on the phone, and almost every Android phone has one. Without one, it opens in a Custom Tab.

## Build it

You only need Docker. No Android Studio or Java is required.

```bash
npm run android:build                              # opens PUBLIC_URL from .env
npm run android:build -- --host call.example.com   # or name the domain
```

The first run takes a few minutes while it downloads the Android SDK into a Docker image. The build writes two files:

- `public/downloads/call9me.apk`: the app, served at **`/download/android`**
- `public/downloads/android.json`: its package name and signing-certificate fingerprint, served as **`/.well-known/assetlinks.json`**

Commit `public/downloads/` and deploy as usual (`docker compose up -d --build`). From then on, **Call9me on Android is the app only**:

- **Android browser tabs** go straight to **`/get-app`** before anything loads. That page has a download button, an **Open the app** button (keeping call links such as `/app?call=room`), install steps, and fixes for common install problems. A `/reset-pin` link from an email still works in the browser.
- **The website can't be installed as a PWA on Android.** Android visitors get a manifest that points to the app (`prefer_related_applications`), so Chrome stops offering "Install app". The site never shows its own "Add to Home Screen" hint there either.
- **Existing home-screen PWAs** show **Switch to the Call9me Android app** each time they're opened, with a step to remove the old icon. This prompt isn't a hard block. A web page can't reliably tell an old PWA from the app's own windows, and a window the app opens from a call notification must never be shut out.
- **Inside the app**, none of this appears. The app launches `https://your-domain/?twa=1`, and the page remembers that marker for the window. The `android-app://` referrer is a backup.

If you change this launch URL, rebuild the APK, and everyone needs the new version.

Check `https://your-domain/.well-known/assetlinks.json` after deploying. If it returns `[]`, Chrome shows a browser bar at the top of the app.

## The signing key: back it up

The first build creates `android/keystore/` (git-ignored) with the release key and its password.

- **Keep a private copy of it**, for example in a password manager. Every update must be signed with the same key. Otherwise phones refuse the update, and users must uninstall and reinstall.
- To build on another machine, copy `android/keystore/` there.

## Updating the app

You only need to rebuild the APK when something in `android/` changes, such as the icon, colours or the domain. Website changes reach the app on their own. Each build gets a higher version code, so a newly downloaded APK installs as an update.

## Settings

| What | Where |
|---|---|
| Domain | `PUBLIC_URL` in `.env`, or `--host` |
| Package name (default `com.call9me.app`) | `ANDROID_PACKAGE` env var when building and on the server. Changing it makes a different app. |
| Icons | `npm run icons` (scripts/generate-icons.js) |
| Status bar and splash colours | `app/src/main/res/values/colors.xml` |
| Extra certificate fingerprints, e.g. Google Play app signing | `ANDROID_CERT_SHA256` on the server |

To open the project in Android Studio, open the `android/` folder and pass `-PtwaHost=your-domain` in the Gradle settings (it defaults to `call.example.com`).
