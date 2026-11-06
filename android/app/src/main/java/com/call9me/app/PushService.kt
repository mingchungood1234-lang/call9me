package com.call9me.app

import com.google.firebase.messaging.FirebaseMessagingService
import com.google.firebase.messaging.RemoteMessage

/**
 * Pushes from the Call9me server (src/server/services/PushService.ts → Firebase): they arrive
 * even when the app is closed. Calls ring with a full-screen call screen; the rest are
 * ordinary notifications.
 */
class PushService : FirebaseMessagingService() {
    override fun onMessageReceived(message: RemoteMessage) {
        val data = message.data
        when (data["type"]) {
            "call" -> {
                val callId = data["callId"] ?: return
                // Already answered on this phone (e.g. the app is open in a call): don't ring.
                if (WebViewHolder.inCall) return
                val from = data["from"] ?: data["title"].orEmpty()
                Notifications.showIncomingCall(
                    this,
                    IncomingCall(
                        callId = callId,
                        from = from,
                        video = data["video"] == "1",
                        detail = data["body"].orEmpty(),
                        avatar = Notifications.loadAvatar(data["icon"]),
                    ),
                )
            }
            "call-end" -> data["callId"]?.let { id -> runOnMain { Notifications.stopRinging(this, id) } }
            else -> {
                val tag = data["tag"] ?: "general"
                // A missed call replaces that caller's ringing, if any is still showing.
                if (data["type"] == "missed-call") {
                    Notifications.ringing.values.filter { "call-${it.from}" == tag }.forEach {
                        runOnMain { Notifications.stopRinging(this, it.callId) }
                    }
                }
                Notifications.showMessage(
                    this,
                    type = data["type"].orEmpty(),
                    title = data["title"] ?: getString(R.string.appName),
                    body = data["body"].orEmpty(),
                    tag = tag,
                    url = data["url"] ?: "/app",
                    avatar = Notifications.loadAvatar(data["icon"]),
                )
            }
        }
    }

    override fun onNewToken(token: String) {
        Push.onNewToken(this, token)
    }

    private fun runOnMain(block: () -> Unit) {
        android.os.Handler(android.os.Looper.getMainLooper()).post(block)
    }
}
