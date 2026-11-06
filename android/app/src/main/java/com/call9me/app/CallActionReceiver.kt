package com.call9me.app

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

/** Notification buttons: Decline an incoming call, Hang up an ongoing one. */
class CallActionReceiver : BroadcastReceiver() {
    companion object {
        const val ACTION_DECLINE = "com.call9me.app.DECLINE"
        const val ACTION_HANG_UP = "com.call9me.app.HANG_UP"
        const val EXTRA_CALL_ID = "callId"
    }

    override fun onReceive(context: Context, intent: Intent) {
        when (intent.action) {
            ACTION_DECLINE -> {
                val callId = intent.getStringExtra(EXTRA_CALL_ID) ?: return
                Notifications.stopRinging(context, callId)
                // Tell the server (works with the app closed: it uses the app's session cookie).
                val pending = goAsync()
                ServerApi.post("/api/calls/$callId/decline") { pending.finish() }
            }
            ACTION_HANG_UP -> {
                if (!WebViewHolder.command("hangUp")) CallService.stop(context)
            }
        }
    }
}
