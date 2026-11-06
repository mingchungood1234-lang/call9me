package com.call9me.app

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import android.os.Handler
import android.os.Looper
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat
import com.google.firebase.FirebaseApp
import com.google.firebase.messaging.FirebaseMessaging
import org.json.JSONObject

/**
 * Firebase Cloud Messaging: how calls reach the phone while the app is closed. Needs
 * android/app/google-services.json at build time and a Firebase service account on the server.
 */
object Push {
    private val main = Handler(Looper.getMainLooper())

    fun available(context: Context): Boolean =
        BuildConfig.FIREBASE && FirebaseApp.getApps(context).isNotEmpty()

    fun permissionGranted(context: Context): Boolean =
        Build.VERSION.SDK_INT < 33 ||
            ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) ==
            PackageManager.PERMISSION_GRANTED

    /** What the page's bell shows: "unsupported", "denied", "off" or "on". */
    fun status(context: Context): String {
        if (!available(context)) return "unsupported"
        if (!permissionGranted(context)) return if (Prefs.notificationsDenied(context)) "denied" else "off"
        if (!NotificationManagerCompat.from(context).areNotificationsEnabled()) return "denied"
        return if (Prefs.pushOff(context)) "off" else "on"
    }

    /** Fetches (or reuses) this install's token; `done` runs on the main thread ("" if none). */
    fun fetchToken(context: Context, done: ((String) -> Unit)? = null) {
        if (!available(context)) {
            done?.invoke("")
            return
        }
        try {
            FirebaseMessaging.getInstance().token.addOnCompleteListener { task ->
                val token = if (task.isSuccessful) task.result.orEmpty() else ""
                if (token.isNotEmpty()) Prefs.setFcmToken(context, token)
                main.post { done?.invoke(token.ifEmpty { Prefs.fcmToken(context) }) }
            }
        } catch (e: Exception) {
            done?.invoke(Prefs.fcmToken(context))
        }
    }

    /** Firebase rotated the token: tell the server (as the signed-in user) right away. */
    fun onNewToken(context: Context, token: String) {
        Prefs.setFcmToken(context, token)
        main.post {
            if (status(context) == "on") ServerApi.post("/api/push/android", JSONObject().put("token", token))
        }
    }
}
