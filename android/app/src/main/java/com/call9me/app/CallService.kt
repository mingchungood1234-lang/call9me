package com.call9me.app

import android.Manifest
import android.annotation.SuppressLint
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.content.pm.ServiceInfo
import android.net.wifi.WifiManager
import android.os.Build
import android.os.IBinder
import android.os.PowerManager
import androidx.core.app.NotificationManagerCompat
import androidx.core.app.ServiceCompat
import androidx.core.content.ContextCompat
import androidx.core.content.IntentCompat

/**
 * Keeps a call going when the app is in the background, the screen is off, or the app is
 * swiped away: a foreground service (microphone, and camera for video calls) holding the
 * process, the CPU and Wi-Fi awake, with an "ongoing call" notification and a Hang up button.
 * The call itself runs in the page (WebRTC), kept alive by WebViewHolder.
 */
class CallService : Service() {
    companion object {
        private const val EXTRA_TITLE = "title"
        private const val EXTRA_VIDEO = "video"
        private const val ACTION_SCREEN = "com.call9me.app.SCREEN"
        private const val EXTRA_RESULT_CODE = "resultCode"
        private const val EXTRA_RESULT_DATA = "resultData"
        private var instance: CallService? = null

        val running: Boolean get() = instance != null

        /** Starts the service, or updates its notification if it's running. */
        fun start(context: Context, title: String, video: Boolean) {
            val current = instance
            if (current != null) {
                current.update(title, video)
                return
            }
            // A foreground service for the mic/camera needs that permission first (Android 14+);
            // MainActivity calls this again once the call's permissions are granted.
            if (types(context, video) == 0 && Build.VERSION.SDK_INT >= 34) return
            val intent = Intent(context, CallService::class.java).putExtra(EXTRA_TITLE, title).putExtra(EXTRA_VIDEO, video)
            try {
                ContextCompat.startForegroundService(context, intent)
            } catch (e: Exception) {
                // Not allowed from the background (Android 12+): the call still runs while the app is open.
            }
        }

        /**
         * The user agreed to share their screen (`resultCode`/`data` from the system prompt): the
         * service takes the mediaProjection type, which Android requires before the capture starts.
         */
        fun startScreen(context: Context, title: String, video: Boolean, resultCode: Int, data: Intent) {
            val intent = Intent(context, CallService::class.java)
                .setAction(ACTION_SCREEN)
                .putExtra(EXTRA_TITLE, title)
                .putExtra(EXTRA_VIDEO, video)
                .putExtra(EXTRA_RESULT_CODE, resultCode)
                .putExtra(EXTRA_RESULT_DATA, data)
            try {
                ContextCompat.startForegroundService(context, intent)
            } catch (e: Exception) {
                WebViewHolder.command("screenShare", "error")
            }
        }

        /** Screen sharing ended (ScreenShare.stop): drop the mediaProjection type. */
        fun screenStopped(context: Context) {
            instance?.onScreenStopped()
        }

        fun stop(context: Context) {
            context.stopService(Intent(context, CallService::class.java))
        }

        private fun granted(context: Context, permission: String) =
            ContextCompat.checkSelfPermission(context, permission) == PackageManager.PERMISSION_GRANTED

        private fun types(context: Context, video: Boolean, sharing: Boolean = false): Int {
            if (Build.VERSION.SDK_INT < 29) return 0
            var types = if (sharing) ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PROJECTION else 0
            if (Build.VERSION.SDK_INT < 30) return types
            if (granted(context, Manifest.permission.RECORD_AUDIO)) types = types or ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE
            if (video && granted(context, Manifest.permission.CAMERA)) types = types or ServiceInfo.FOREGROUND_SERVICE_TYPE_CAMERA
            return types
        }
    }

    private var title = ""
    private var video = false
    private var sharing = false
    private val since = System.currentTimeMillis()
    private var wakeLock: PowerManager.WakeLock? = null
    private var wifiLock: WifiManager.WifiLock? = null

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        title = intent?.getStringExtra(EXTRA_TITLE) ?: getString(R.string.ongoingCall)
        video = intent?.getBooleanExtra(EXTRA_VIDEO, false) ?: false
        val screen = if (intent?.action == ACTION_SCREEN) {
            IntentCompat.getParcelableExtra(intent, EXTRA_RESULT_DATA, Intent::class.java)
        } else {
            null
        }
        sharing = screen != null
        if (!foreground()) {
            if (screen != null) WebViewHolder.command("screenShare", "error")
            sharing = false
            // Still a call to keep going? Then the service stays (as it was, without the screen).
            if (instance == null || !foreground()) stopSelf()
            return START_NOT_STICKY
        }
        instance = this
        holdLocks()
        if (screen != null) {
            val resultCode = intent!!.getIntExtra(EXTRA_RESULT_CODE, 0)
            if (!ScreenShare.start(this, resultCode, screen)) {
                WebViewHolder.command("screenShare", "error")
                onScreenStopped()
            }
        }
        return START_NOT_STICKY
    }

    /** (Re)enters the foreground with the types the call needs right now. @return success. */
    private fun foreground(): Boolean = try {
        ServiceCompat.startForeground(
            this,
            Notifications.ONGOING_ID,
            Notifications.ongoingCall(this, title, video, since, sharing),
            types(this, video, sharing),
        )
        true
    } catch (e: Exception) {
        false
    }

    private fun onScreenStopped() {
        if (!sharing) return
        sharing = false
        // Without a microphone or camera there's nothing left to run in the foreground for.
        if (!foreground()) stopSelf()
    }

    @SuppressLint("MissingPermission")
    private fun update(title: String, video: Boolean) {
        if (title == this.title && video == this.video) return
        this.title = title
        this.video = video
        val manager = NotificationManagerCompat.from(this)
        if (manager.areNotificationsEnabled()) {
            manager.notify(Notifications.ONGOING_ID, Notifications.ongoingCall(this, title, video, since, sharing))
        }
    }

    @Suppress("DEPRECATION")
    private fun holdLocks() {
        if (wakeLock == null) {
            wakeLock = (getSystemService(POWER_SERVICE) as PowerManager)
                .newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "call9me:call")
                .apply { acquire(4 * 60 * 60 * 1000L) }
        }
        if (wifiLock == null) {
            val mode = if (Build.VERSION.SDK_INT >= 29) WifiManager.WIFI_MODE_FULL_LOW_LATENCY else WifiManager.WIFI_MODE_FULL_HIGH_PERF
            wifiLock = (applicationContext.getSystemService(WIFI_SERVICE) as WifiManager)
                .createWifiLock(mode, "call9me:call")
                .apply { acquire() }
        }
    }

    override fun onDestroy() {
        instance = null
        ScreenShare.stop() // the call is over
        wakeLock?.let { if (it.isHeld) it.release() }
        wifiLock?.let { if (it.isHeld) it.release() }
        wakeLock = null
        wifiLock = null
        super.onDestroy()
    }
}
