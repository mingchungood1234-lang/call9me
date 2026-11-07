package com.call9me.app

import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.pm.PackageInstaller
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.provider.Settings
import android.view.Gravity
import android.widget.LinearLayout
import android.widget.ProgressBar
import android.widget.TextView
import android.widget.Toast
import androidx.appcompat.app.AlertDialog
import androidx.core.content.IntentCompat
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.Executors

/**
 * In-app updates. The site's pages update by themselves; this is for the app around them (new
 * native features). When the app opens, it asks the site which version it offers
 * (/download/android/version, from `npm run android:build`) and, if that's newer:
 *
 * - Usually (Android 12+, installs from Call9me already allowed): nothing to tap. The update
 *   downloads quietly and installs when the user leaves the app (never during a call); the next
 *   time they open it, it's the new version. Should Android still want a confirmation, a
 *   notification "Update ready" asks for it instead of interrupting.
 * - Otherwise (the first update, or Android 11 and older): a dialog offers Update. Android then
 *   asks once to allow installs from Call9me, and confirms the install.
 *
 * The APK goes straight into Android's installer, which replaces the app in place (same signing
 * key, so nothing is lost).
 */
object Updater {
    /** Ask the site at most this often. */
    private const val CHECK_EVERY_MS = 60 * 60 * 1000L
    private const val ACTION_INSTALLED = "com.call9me.app.UPDATE_INSTALLED"

    private val executor = Executors.newSingleThreadExecutor()
    private val main = Handler(Looper.getMainLooper())
    private var lastCheck = 0L
    private var busy = false
    private var cleanedUp = false
    /** Waiting for the user to allow "Install unknown apps" in Settings. */
    private var awaitingPermission: Release? = null
    private var dialog: AlertDialog? = null
    /** A downloaded update waiting for the user to leave the app (installer session ID). */
    private var ready: Ready? = null

    /** The app is on screen (installs wait until it isn't). */
    @Volatile
    var appVisible = false
        private set

    private data class Release(val versionCode: Long, val versionName: String, val sizeMb: String)
    private data class Ready(val sessionId: Int, val versionCode: Long)

    /** Called whenever the app comes to the front. */
    fun onAppShown(activity: MainActivity) {
        appVisible = true
        val context = activity.applicationContext
        if (!cleanedUp) {
            cleanedUp = true
            abandonLeftovers(context) // from before the app was last closed
        }
        // Back from Settings with installs allowed: carry on with the update the user chose.
        awaitingPermission?.let { release ->
            awaitingPermission = null
            if (canInstall(activity)) downloadNow(activity, release)
            return
        }
        val now = System.currentTimeMillis()
        if (busy || ready != null || WebViewHolder.inCall || now - lastCheck < CHECK_EVERY_MS) return
        busy = true
        executor.execute {
            val release = fetchRelease()
            main.post {
                busy = false
                if (release == null) return@post
                lastCheck = System.currentTimeMillis()
                if (release.versionCode <= BuildConfig.VERSION_CODE) return@post
                if (canUpdateSilently(context)) {
                    downloadQuietly(context, release)
                } else if (!activity.isFinishing && !activity.isDestroyed && !WebViewHolder.inCall) {
                    offer(activity, release)
                }
            }
        }
    }

    /** The app left the screen: a good moment to install a waiting update. */
    fun onAppHidden(context: Context) {
        appVisible = false
        installIfIdle(context)
    }

    /** Installs a downloaded update if the app is out of sight and not in a call. */
    fun installIfIdle(context: Context) {
        val update = ready ?: return
        if (appVisible || WebViewHolder.inCall) return
        ready = null
        val app = context.applicationContext
        executor.execute {
            try {
                val installer = app.packageManager.packageInstaller
                installer.openSession(update.sessionId).use { it.commit(resultIntent(app, update.sessionId)) }
            } catch (e: Exception) {
                lastCheck = 0L // try again next time the app opens
            }
        }
    }

    /** Android 12+ lets an app update itself without asking, once installs from it are allowed. */
    private fun canUpdateSilently(context: Context): Boolean = Build.VERSION.SDK_INT >= 31 && canInstall(context)

    private fun canInstall(context: Context): Boolean =
        Build.VERSION.SDK_INT < 26 || context.packageManager.canRequestPackageInstalls()

    private fun fetchRelease(): Release? = try {
        val conn = URL(Site.url("/download/android/version")).openConnection() as HttpURLConnection
        conn.connectTimeout = 10_000
        conn.readTimeout = 10_000
        conn.setRequestProperty("User-Agent", Site.userAgentTag)
        val json = if (conn.responseCode == 200) conn.inputStream.bufferedReader().use { it.readText() } else null
        conn.disconnect()
        json?.let {
            val info = JSONObject(it)
            Release(
                info.optLong("versionCode"),
                info.optString("versionName").substringBefore(' '),
                "%.1f".format(info.optLong("size") / 1024.0 / 1024.0),
            )
        }
    } catch (e: Exception) {
        null
    }

    // ---- Quiet updates ----

    private fun downloadQuietly(context: Context, release: Release) {
        busy = true
        executor.execute {
            val sessionId = try {
                writeSession(context, silent = true) {}
            } catch (e: Exception) {
                null
            }
            main.post {
                busy = false
                if (sessionId == null) {
                    lastCheck = 0L
                    return@post
                }
                ready = Ready(sessionId, release.versionCode)
                installIfIdle(context) // already left the app while it downloaded?
            }
        }
    }

    /** Drops update downloads that were never installed (e.g. the app was closed first). */
    private fun abandonLeftovers(context: Context) {
        val installer = context.packageManager.packageInstaller
        for (session in installer.mySessions) {
            try {
                installer.abandonSession(session.sessionId)
            } catch (e: Exception) {
                // Already gone.
            }
        }
    }

    // ---- Updates the user asked for ----

    private fun offer(activity: MainActivity, release: Release) {
        if (dialog?.isShowing == true) return
        dialog = AlertDialog.Builder(activity)
            .setTitle(R.string.updateTitle)
            .setMessage(activity.getString(R.string.updateText, release.versionName, release.sizeMb))
            .setPositiveButton(R.string.updateNow) { _, _ -> install(activity, release) }
            .setNegativeButton(R.string.updateLater, null)
            .show()
    }

    private fun install(activity: MainActivity, release: Release) {
        if (!canInstall(activity)) {
            // Android 8+: the user allows this app to install apps once, in Settings.
            awaitingPermission = release
            Toast.makeText(activity, R.string.updateAllowInstall, Toast.LENGTH_LONG).show()
            activity.openSettings(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES)
            return
        }
        downloadNow(activity, release)
    }

    /** Downloads with a progress dialog, then Android asks to confirm (and offers "Open" after). */
    private fun downloadNow(activity: MainActivity, @Suppress("UNUSED_PARAMETER") release: Release) {
        if (busy) return
        busy = true
        val progress = ProgressBar(activity, null, android.R.attr.progressBarStyleHorizontal).apply { max = 100 }
        val label = TextView(activity).apply { setText(R.string.updateDownloading) }
        val pad = (20 * activity.resources.displayMetrics.density).toInt()
        val layout = LinearLayout(activity).apply {
            orientation = LinearLayout.VERTICAL
            gravity = Gravity.CENTER_VERTICAL
            setPadding(pad, pad, pad, pad / 2)
            addView(label)
            addView(progress)
        }
        val shown = AlertDialog.Builder(activity)
            .setTitle(activity.getString(R.string.updateTitle))
            .setView(layout)
            .setCancelable(false)
            .show()
        val context = activity.applicationContext

        executor.execute {
            val ok = try {
                val sessionId = writeSession(context, silent = false) { percent -> main.post { progress.progress = percent } }
                context.packageManager.packageInstaller.openSession(sessionId).use { it.commit(resultIntent(context, sessionId)) }
                true
            } catch (e: Exception) {
                false
            }
            main.post {
                busy = false
                try {
                    shown.dismiss()
                } catch (e: Exception) {
                    // The activity went away.
                }
                if (!ok) Toast.makeText(context, R.string.updateFailed, Toast.LENGTH_LONG).show()
                // On success Android shows "Do you want to install this update?" (InstallReceiver).
            }
        }
    }

    // ---- Installer ----

    /** Streams the APK from the site into a new installer session. @return its ID. Worker thread. */
    private fun writeSession(context: Context, silent: Boolean, onProgress: (Int) -> Unit): Int {
        val installer = context.packageManager.packageInstaller
        val params = PackageInstaller.SessionParams(PackageInstaller.SessionParams.MODE_FULL_INSTALL).apply {
            setAppPackageName(context.packageName)
            if (Build.VERSION.SDK_INT >= 33) setPackageSource(PackageInstaller.PACKAGE_SOURCE_DOWNLOADED_FILE)
            if (silent && Build.VERSION.SDK_INT >= 31) {
                setRequireUserAction(PackageInstaller.SessionParams.USER_ACTION_NOT_REQUIRED)
            }
        }
        val sessionId = installer.createSession(params)
        try {
            installer.openSession(sessionId).use { session ->
                val conn = URL(Site.url("/download/android")).openConnection() as HttpURLConnection
                conn.connectTimeout = 15_000
                conn.readTimeout = 30_000
                conn.setRequestProperty("User-Agent", Site.userAgentTag)
                if (conn.responseCode != 200) throw IllegalStateException("HTTP ${conn.responseCode}")
                val total = conn.contentLengthLong
                conn.inputStream.use { input ->
                    session.openWrite("call9me.apk", 0, total).use { output ->
                        val buffer = ByteArray(64 * 1024)
                        var done = 0L
                        var lastPercent = -1
                        while (true) {
                            val n = input.read(buffer)
                            if (n < 0) break
                            output.write(buffer, 0, n)
                            done += n
                            val percent = if (total > 0) (done * 100 / total).toInt() else 0
                            if (percent != lastPercent) {
                                lastPercent = percent
                                onProgress(percent)
                            }
                        }
                        session.fsync(output)
                    }
                }
                conn.disconnect()
            }
            return sessionId
        } catch (e: Exception) {
            try {
                installer.abandonSession(sessionId)
            } catch (ignored: Exception) {
            }
            throw e
        }
    }

    private fun resultIntent(context: Context, sessionId: Int) = PendingIntent.getBroadcast(
        context,
        sessionId,
        Intent(context, InstallReceiver::class.java).setAction(ACTION_INSTALLED).setPackage(context.packageName),
        PendingIntent.FLAG_UPDATE_CURRENT or (if (Build.VERSION.SDK_INT >= 31) PendingIntent.FLAG_MUTABLE else 0),
    ).intentSender
}

/** The installer's answer: confirm (on screen, or via a notification), or say it failed. */
class InstallReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        when (intent.getIntExtra(PackageInstaller.EXTRA_STATUS, PackageInstaller.STATUS_FAILURE)) {
            PackageInstaller.STATUS_PENDING_USER_ACTION -> {
                val confirm = IntentCompat.getParcelableExtra(intent, Intent.EXTRA_INTENT, Intent::class.java) ?: return
                if (!Updater.appVisible) {
                    // Not now, in the middle of something else: the user installs it when they like.
                    Notifications.showUpdateReady(context, confirm)
                    return
                }
                try {
                    context.startActivity(confirm.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
                } catch (e: Exception) {
                    Notifications.showUpdateReady(context, confirm)
                }
            }
            PackageInstaller.STATUS_SUCCESS -> Unit // Android restarts the app as the new version.
            PackageInstaller.STATUS_FAILURE_ABORTED -> Unit // The user said no; asked again later.
            else -> if (Updater.appVisible) Toast.makeText(context, R.string.updateFailed, Toast.LENGTH_LONG).show()
        }
    }
}
