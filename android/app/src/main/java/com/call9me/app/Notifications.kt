package com.call9me.app

import android.annotation.SuppressLint
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Canvas
import android.graphics.Paint
import android.graphics.PorterDuff
import android.graphics.PorterDuffXfermode
import android.graphics.Rect
import android.media.AudioAttributes
import android.media.AudioManager
import android.media.RingtoneManager
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.app.Person
import androidx.core.content.ContextCompat
import androidx.core.graphics.drawable.IconCompat
import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.ConcurrentHashMap

/** A call ringing on this phone (from a push while the app was closed or in the background). */
data class IncomingCall(
    val callId: String,
    val from: String,
    val video: Boolean,
    val detail: String,
    val avatar: Bitmap?,
)

object Notifications {
    const val CHANNEL_CALLS = "incoming_calls_v1"
    const val CHANNEL_ONGOING = "ongoing_call"
    const val CHANNEL_MESSAGES = "messages"

    private const val RING_TAG = "ring:"
    private const val RING_ID = 1
    const val ONGOING_ID = 2
    private const val MESSAGE_ID = 3
    /** How long a call rings, as on the server (offlineRingTimeoutMs). */
    private const val RING_MS = 45_000L

    /** Calls ringing right now, by call ID (the call screen reads them). */
    val ringing = ConcurrentHashMap<String, IncomingCall>()

    fun createChannels(context: Context) {
        if (Build.VERSION.SDK_INT < 26) return
        val manager = context.getSystemService(NotificationManager::class.java)
        val ringtone = RingtoneManager.getDefaultUri(RingtoneManager.TYPE_RINGTONE)
        val calls = NotificationChannel(CHANNEL_CALLS, context.getString(R.string.channelCalls), NotificationManager.IMPORTANCE_HIGH).apply {
            description = context.getString(R.string.channelCallsDescription)
            setSound(
                ringtone,
                AudioAttributes.Builder()
                    .setUsage(AudioAttributes.USAGE_NOTIFICATION_RINGTONE)
                    .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
                    .build(),
            )
            enableVibration(true)
            vibrationPattern = longArrayOf(0, 800, 600, 800, 600)
            lockscreenVisibility = Notification.VISIBILITY_PUBLIC
            setBypassDnd(false)
        }
        val ongoing = NotificationChannel(CHANNEL_ONGOING, context.getString(R.string.channelOngoing), NotificationManager.IMPORTANCE_LOW).apply {
            description = context.getString(R.string.channelOngoingDescription)
            setSound(null, null)
        }
        val messages = NotificationChannel(CHANNEL_MESSAGES, context.getString(R.string.channelMessages), NotificationManager.IMPORTANCE_HIGH).apply {
            description = context.getString(R.string.channelMessagesDescription)
        }
        manager.createNotificationChannels(listOf(calls, ongoing, messages))
    }

    // ---- Incoming calls ----

    /** Rings: a call-style notification with Answer/Decline and the full-screen call screen. */
    fun showIncomingCall(context: Context, call: IncomingCall) {
        ringing[call.callId] = call
        val person = person(call.from, call.avatar)
        val answer = answerIntent(context, call.callId)
        val decline = PendingIntent.getBroadcast(
            context,
            call.callId.hashCode(),
            Intent(context, CallActionReceiver::class.java)
                .setAction(CallActionReceiver.ACTION_DECLINE)
                .putExtra(CallActionReceiver.EXTRA_CALL_ID, call.callId),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        val fullScreen = PendingIntent.getActivity(
            context,
            call.callId.hashCode(),
            Intent(context, IncomingCallActivity::class.java)
                .putExtra(CallActionReceiver.EXTRA_CALL_ID, call.callId)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_NO_USER_ACTION),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        val title = context.getString(if (call.video) R.string.incomingVideoCall else R.string.incomingVoiceCall)
        val builder = NotificationCompat.Builder(context, CHANNEL_CALLS)
            .setSmallIcon(R.drawable.ic_notification)
            .setColor(ContextCompat.getColor(context, R.color.brand))
            .setContentTitle(call.from)
            .setContentText(call.detail.ifEmpty { title })
            .setLargeIcon(call.avatar)
            .setCategory(NotificationCompat.CATEGORY_CALL)
            .setPriority(NotificationCompat.PRIORITY_MAX)
            .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
            .setOngoing(true)
            .setAutoCancel(false)
            .setTimeoutAfter(RING_MS)
            .setContentIntent(fullScreen)
            .setFullScreenIntent(fullScreen, true)
            // Android 7 (no channels): ring and vibrate from here.
            .setSound(RingtoneManager.getDefaultUri(RingtoneManager.TYPE_RINGTONE), AudioManager.STREAM_RING)
            .setVibrate(longArrayOf(0, 800, 600, 800, 600))
        val notification = try {
            builder.setStyle(NotificationCompat.CallStyle.forIncomingCall(person, decline, answer).setIsVideo(call.video)).build()
        } catch (e: Exception) {
            // Some devices refuse call-style notifications: plain buttons instead.
            builder.setStyle(null)
                .addAction(R.drawable.ic_call_end, context.getString(R.string.decline), decline)
                .addAction(R.drawable.ic_call, context.getString(R.string.answer), answer)
                .build()
        }
        // Keep ringing (the ringtone loops) until answered, declined or timed out.
        notification.flags = notification.flags or Notification.FLAG_INSISTENT
        notify(context, RING_TAG + call.callId, RING_ID, notification)
    }

    /** The call stopped ringing (answered, declined, cancelled): silence it and close the call screen. */
    fun stopRinging(context: Context, callId: String) {
        ringing.remove(callId)
        NotificationManagerCompat.from(context).cancel(RING_TAG + callId, RING_ID)
        IncomingCallActivity.finishFor(callId)
    }

    fun answerIntent(context: Context, callId: String): PendingIntent = PendingIntent.getActivity(
        context,
        callId.hashCode() + 1,
        Intent(context, MainActivity::class.java)
            .setAction(MainActivity.ACTION_ANSWER)
            .putExtra(CallActionReceiver.EXTRA_CALL_ID, callId)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP),
        PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
    )

    // ---- Messages, missed calls, friend requests ----

    fun showMessage(context: Context, type: String, title: String, body: String, tag: String, url: String, avatar: Bitmap?) {
        val open = PendingIntent.getActivity(
            context,
            tag.hashCode(),
            Intent(context, MainActivity::class.java)
                .setAction(MainActivity.ACTION_OPEN_URL)
                .putExtra(MainActivity.EXTRA_URL, url)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        val notification = NotificationCompat.Builder(context, CHANNEL_MESSAGES)
            .setSmallIcon(R.drawable.ic_notification)
            .setColor(ContextCompat.getColor(context, R.color.brand))
            .setContentTitle(title)
            .setContentText(body)
            .setStyle(NotificationCompat.BigTextStyle().bigText(body))
            .setLargeIcon(avatar)
            .setCategory(if (type == "missed-call") NotificationCompat.CATEGORY_MISSED_CALL else NotificationCompat.CATEGORY_MESSAGE)
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setAutoCancel(true)
            .setContentIntent(open)
            .build()
        notify(context, tag, MESSAGE_ID, notification)
    }

    // ---- Ongoing call (CallService) ----

    fun ongoingCall(context: Context, title: String, video: Boolean, since: Long): Notification {
        val open = PendingIntent.getActivity(
            context,
            0,
            Intent(context, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        val hangUp = PendingIntent.getBroadcast(
            context,
            0,
            Intent(context, CallActionReceiver::class.java).setAction(CallActionReceiver.ACTION_HANG_UP),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        val builder = NotificationCompat.Builder(context, CHANNEL_ONGOING)
            .setSmallIcon(R.drawable.ic_notification)
            .setColor(ContextCompat.getColor(context, R.color.brand))
            .setContentTitle(title)
            .setContentText(context.getString(R.string.ongoingCallText))
            .setCategory(NotificationCompat.CATEGORY_CALL)
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setWhen(since)
            .setUsesChronometer(true)
            .setShowWhen(true)
            .setContentIntent(open)
        return try {
            builder.setStyle(NotificationCompat.CallStyle.forOngoingCall(person(title, null), hangUp).setIsVideo(video)).build()
        } catch (e: Exception) {
            builder.setStyle(null).addAction(R.drawable.ic_call_end, context.getString(R.string.hangUp), hangUp).build()
        }
    }

    // ---- Helpers ----

    private fun person(name: String, avatar: Bitmap?): Person = Person.Builder()
        .setName(name)
        .setImportant(true)
        .apply { if (avatar != null) setIcon(IconCompat.createWithBitmap(avatar)) }
        .build()

    @SuppressLint("MissingPermission") // checked: notifications may be off, then nothing is shown
    private fun notify(context: Context, tag: String, id: Int, notification: Notification) {
        val manager = NotificationManagerCompat.from(context)
        if (!manager.areNotificationsEnabled()) return
        try {
            manager.notify(tag, id, notification)
        } catch (e: SecurityException) {
            // Permission revoked meanwhile.
        }
    }

    /** A user's profile picture from the site, round, for notifications (null if none or slow). */
    fun loadAvatar(path: String?): Bitmap? {
        if (path.isNullOrEmpty()) return null
        return try {
            val conn = URL(Site.url(path)).openConnection() as HttpURLConnection
            conn.connectTimeout = 3_000
            conn.readTimeout = 3_000
            val bitmap = conn.inputStream.use { BitmapFactory.decodeStream(it) }
            conn.disconnect()
            bitmap?.let { circle(it) }
        } catch (e: Exception) {
            null
        }
    }

    private fun circle(source: Bitmap): Bitmap {
        val size = minOf(source.width, source.height, 256)
        val output = Bitmap.createBitmap(size, size, Bitmap.Config.ARGB_8888)
        val canvas = Canvas(output)
        val paint = Paint(Paint.ANTI_ALIAS_FLAG)
        canvas.drawCircle(size / 2f, size / 2f, size / 2f, paint)
        paint.xfermode = PorterDuffXfermode(PorterDuff.Mode.SRC_IN)
        val side = minOf(source.width, source.height)
        val src = Rect((source.width - side) / 2, (source.height - side) / 2, (source.width + side) / 2, (source.height + side) / 2)
        canvas.drawBitmap(source, src, Rect(0, 0, size, size), paint)
        return output
    }
}
