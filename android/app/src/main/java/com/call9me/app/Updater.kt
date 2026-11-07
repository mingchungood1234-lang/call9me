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
 * (/download/android/version, from `npm run android:build`). If that's newer, it offers to
 * update: the APK downloads straight into Android's installer, which asks the user to confirm
 * and replaces the app in place (same signing key, so nothing is lost).
 */
object Updater {
    /** Ask the site at most this often. */
    private const val CHECK_EVERY_MS = 60 * 60 * 1000L
    private const val ACTION_INSTALLED = "com.call9me.app.UPDATE_INSTALLED"

    private val executor = Executors.newSingleThreadExecutor()
    private val main = Handler(Looper.getMainLooper())
    private var lastCheck = 0L
    private var busy = false
    /** Waiting for the user to allow "Install unknown apps" in Settings. */
    private var awaitingPermission: Release? = null
    private var dialog: AlertDialog? = null

    private data class Release(val versionCode: Long, val versionName: String, val sizeMb: String)

    /** Called whenever the app comes to the front. */
    fun onAppShown(activity: MainActivity) {
        // Back from Settings with installs allowed: carry on with the update the user chose.
        awaitingPermission?.let { release ->
            awaitingPermission = null
            if (canInstall(activity)) download(activity, release)
            return
        }
        val now = System.currentTimeMillis()
        if (busy || WebViewHolder.inCall || now - lastCheck < CHECK_EVERY_MS) return
        busy = true
        executor.execute {
            val release = fetchRelease()
            main.post {
                busy = false
                if (release == null) return@post
                lastCheck = System.currentTimeMillis()
                if (release.versionCode > BuildConfig.VERSION_CODE && !activity.isFinishing && !activity.isDestroyed && !WebViewHolder.inCall) {
                    offer(activity, release)
                }
            }
        }
    }

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

    private fun offer(activity: MainActivity, release: Release) {
        if (dialog?.isShowing == true) return
        dialog = AlertDialog.Builder(activity)
            .setTitle(R.string.updateTitle)
            .setMessage(activity.getString(R.string.updateText, release.versionName, release.sizeMb))
            .setPositiveButton(R.string.updateNow) { _, _ -> install(activity, release) }
            .setNegativeButton(R.string.updateLater, null)
            .show()
    }

    private fun canInstall(context: Context): Boolean =
        Build.VERSION.SDK_INT < 26 || context.packageManager.canRequestPackageInstalls()

    private fun install(activity: MainActivity, release: Release) {
        if (!canInstall(activity)) {
            // Android 8+: the user allows this app to install apps once, in Settings.
            awaitingPermission = release
            Toast.makeText(activity, R.string.updateAllowInstall, Toast.LENGTH_LONG).show()
            activity.openSettings(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES)
            return
        }
        download(activity, release)
    }

    private fun download(activity: MainActivity, release: Release) {
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
                writeToInstaller(context) { percent -> main.post { progress.progress = percent } }
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

    /** Streams the APK from the site into an installer session and commits it. Worker thread. */
    private fun writeToInstaller(context: Context, onProgress: (Int) -> Unit) {
        val installer = context.packageManager.packageInstaller
        val params = PackageInstaller.SessionParams(PackageInstaller.SessionParams.MODE_FULL_INSTALL).apply {
            setAppPackageName(context.packageName)
            if (Build.VERSION.SDK_INT >= 33) setPackageSource(PackageInstaller.PACKAGE_SOURCE_DOWNLOADED_FILE)
        }
        val sessionId = installer.createSession(params)
        val session = installer.openSession(sessionId)
        try {
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

            val flags = PendingIntent.FLAG_UPDATE_CURRENT or (if (Build.VERSION.SDK_INT >= 31) PendingIntent.FLAG_MUTABLE else 0)
            val result = PendingIntent.getBroadcast(
                context,
                sessionId,
                Intent(context, InstallReceiver::class.java).setAction(ACTION_INSTALLED).setPackage(context.packageName),
                flags,
            )
            session.commit(result.intentSender)
            session.close()
        } catch (e: Exception) {
            session.abandon()
            throw e
        }
    }
}

/** The installer's answer: show its confirmation screen, or say the update failed. */
class InstallReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        when (intent.getIntExtra(PackageInstaller.EXTRA_STATUS, PackageInstaller.STATUS_FAILURE)) {
            PackageInstaller.STATUS_PENDING_USER_ACTION -> {
                val confirm = IntentCompat.getParcelableExtra(intent, Intent.EXTRA_INTENT, Intent::class.java) ?: return
                try {
                    context.startActivity(confirm.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
                } catch (e: Exception) {
                    Toast.makeText(context, R.string.updateFailed, Toast.LENGTH_LONG).show()
                }
            }
            PackageInstaller.STATUS_SUCCESS -> Unit // Android restarts the app as the new version.
            PackageInstaller.STATUS_FAILURE_ABORTED -> Unit // The user said no; asked again later.
            else -> Toast.makeText(context, R.string.updateFailed, Toast.LENGTH_LONG).show()
        }
    }
}
