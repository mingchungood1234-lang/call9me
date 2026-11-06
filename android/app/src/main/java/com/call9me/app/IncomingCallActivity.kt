package com.call9me.app

import android.content.Intent
import android.os.Build
import android.os.Bundle
import android.view.View
import android.view.WindowManager
import android.widget.ImageView
import android.widget.TextView
import androidx.appcompat.app.AppCompatActivity
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import java.lang.ref.WeakReference

/**
 * Native full-screen incoming call (also over the lock screen): caller, Answer and Decline.
 * The ringtone comes from the call notification (Notifications.showIncomingCall).
 */
class IncomingCallActivity : AppCompatActivity() {
    companion object {
        private var current: WeakReference<IncomingCallActivity>? = null

        /** That call stopped ringing: close its screen. */
        fun finishFor(callId: String) {
            current?.get()?.let { if (it.callId == callId) it.finish() }
        }
    }

    private var callId = ""

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        if (Build.VERSION.SDK_INT >= 27) {
            setShowWhenLocked(true)
            setTurnScreenOn(true)
        } else {
            @Suppress("DEPRECATION")
            window.addFlags(WindowManager.LayoutParams.FLAG_SHOW_WHEN_LOCKED or WindowManager.LayoutParams.FLAG_TURN_SCREEN_ON)
        }
        WindowCompat.setDecorFitsSystemWindows(window, false)
        setContentView(R.layout.activity_incoming_call)
        val root = findViewById<View>(R.id.callRoot)
        val basePadding = intArrayOf(root.paddingLeft, root.paddingTop, root.paddingRight, root.paddingBottom)
        ViewCompat.setOnApplyWindowInsetsListener(root) { view, insets ->
            val bars = insets.getInsets(WindowInsetsCompat.Type.systemBars())
            view.setPadding(basePadding[0] + bars.left, basePadding[1] + bars.top, basePadding[2] + bars.right, basePadding[3] + bars.bottom)
            insets
        }

        findViewById<View>(R.id.answerBtn).setOnClickListener {
            startActivity(
                Intent(this, MainActivity::class.java)
                    .setAction(MainActivity.ACTION_ANSWER)
                    .putExtra(CallActionReceiver.EXTRA_CALL_ID, callId)
                    .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP),
            )
            finish()
        }
        findViewById<View>(R.id.declineBtn).setOnClickListener {
            sendBroadcast(
                Intent(this, CallActionReceiver::class.java)
                    .setAction(CallActionReceiver.ACTION_DECLINE)
                    .putExtra(CallActionReceiver.EXTRA_CALL_ID, callId),
            )
            finish()
        }
        show(intent)
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        show(intent)
    }

    private fun show(intent: Intent) {
        callId = intent.getStringExtra(CallActionReceiver.EXTRA_CALL_ID).orEmpty()
        val call = Notifications.ringing[callId]
        if (call == null) {
            // Already over (answered elsewhere, cancelled, timed out).
            finish()
            return
        }
        current = WeakReference(this)
        findViewById<TextView>(R.id.callKind).setText(if (call.video) R.string.incomingVideoCall else R.string.incomingVoiceCall)
        findViewById<TextView>(R.id.callerName).text = call.from
        findViewById<TextView>(R.id.callDetail).text = call.detail
        val avatar = findViewById<ImageView>(R.id.avatar)
        val letter = findViewById<TextView>(R.id.avatarLetter)
        if (call.avatar != null) {
            avatar.setImageBitmap(call.avatar)
            avatar.visibility = View.VISIBLE
            letter.visibility = View.GONE
        } else {
            letter.text = call.from.take(1).uppercase()
            letter.visibility = View.VISIBLE
            avatar.visibility = View.GONE
        }
    }

    override fun onDestroy() {
        if (current?.get() === this) current = null
        super.onDestroy()
    }
}
