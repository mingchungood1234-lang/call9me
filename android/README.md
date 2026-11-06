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

Commit `public/downloads/` and deploy as usual (`docker compose up -d --build`). Android visitors then see:

- A **Get the Android app** button on the sign-in page.
- A card in place of the "Add to Home Screen" hint.
- **Get the Android app** in the profile menu.

None of these show inside the app itself.

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
