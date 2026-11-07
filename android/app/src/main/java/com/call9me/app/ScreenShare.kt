package com.call9me.app

import android.content.Context
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.PixelFormat
import android.hardware.display.DisplayManager
import android.hardware.display.VirtualDisplay
import android.media.ImageReader
import android.media.projection.MediaProjection
import android.media.projection.MediaProjectionManager
import android.os.Handler
import android.os.HandlerThread
import android.os.Looper
import android.os.SystemClock
import android.util.Base64
import android.util.DisplayMetrics
import android.view.Display
import android.webkit.WebView
import androidx.webkit.JavaScriptReplyProxy
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import java.io.ByteArrayOutputStream
import kotlin.math.max
import kotlin.math.min

/**
 * Screen sharing, which the WebView can't do (it has no getDisplayMedia): Android's own screen
 * capture (MediaProjection: the system "Start sharing?" prompt, whole screen or one app) feeds
 * JPEG frames to the page, which turns them into a video track for the call
 * (src/client/lib/nativeScreen.ts). Frames go over a WebMessage channel (`window.call9meScreen`)
 * as binary; the page acks each one, so a slow page gets fewer frames instead of growing lag.
 *
 * Page → app: Bridge.startScreenShare / stopScreenShare. App → page: call9meNative.screenShare(status).
 * The capture needs a foreground service of type mediaProjection: CallService starts it here.
 */
object ScreenShare {
    /** Longest side of the shared picture, in pixels. */
    private const val MAX_EDGE = 1280
    /** At most ~15 frames a second. */
    private const val MIN_FRAME_MS = 66L
    /** A frame the page hasn't acked in this long is taken as lost (page busy or reloaded). */
    private const val ACK_TIMEOUT_MS = 1_000L
    private const val JPEG_QUALITY = 70

    private val main = Handler(Looper.getMainLooper())
    private var appContext: Context? = null
    private var projection: MediaProjection? = null
    private var display: VirtualDisplay? = null
    private var reader: ImageReader? = null
    private var thread: HandlerThread? = null
    private var worker: Handler? = null
    private var displayListener: DisplayManager.DisplayListener? = null
    private var size = Size(0, 0, 0)

    /** The page's end of the frame channel (set when the page says "hello"). */
    @Volatile
    private var replyProxy: JavaScriptReplyProxy? = null
    private var binary = false

    // Worker thread only.
    private var awaitingAckSince = 0L
    private var lastFrameAt = 0L
    private var pullScheduled = false
    private var bitmap: Bitmap? = null
    private val jpeg = ByteArrayOutputStream(256 * 1024)

    private data class Size(val width: Int, val height: Int, val dpi: Int)

    val active: Boolean get() = projection != null

    /** This WebView can take the frames (Android System WebView 2021 or newer). */
    fun supported(): Boolean = WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)

    /** Adds `window.call9meScreen` to our site's pages. Call before the first page loads. */
    fun install(view: WebView) {
        if (!supported()) return
        binary = WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_ARRAY_BUFFER)
        WebViewCompat.addWebMessageListener(view, "call9meScreen", setOf(Site.base)) { _, message, origin, isMainFrame, proxy ->
            if (!isMainFrame || !Site.isOwn(origin)) return@addWebMessageListener
            when (message.data) {
                "hello" -> replyProxy = proxy
                "ack" -> if (proxy === replyProxy) worker?.post {
                    awaitingAckSince = 0L
                    schedulePull(0L)
                }
            }
        }
    }

    /** Starts capturing with the user's consent (from MediaProjectionManager). Main thread. */
    fun start(context: Context, resultCode: Int, data: Intent): Boolean {
        stop()
        val manager = context.getSystemService(MediaProjectionManager::class.java) ?: return false
        val mp = try {
            manager.getMediaProjection(resultCode, data)
        } catch (e: Exception) {
            null
        } ?: return false

        val app = context.applicationContext
        val t = HandlerThread("call9me-screen").apply { start() }
        val h = Handler(t.looper)
        appContext = app
        projection = mp
        thread = t
        worker = h
        awaitingAckSince = 0L
        lastFrameAt = 0L
        pullScheduled = false

        // Android 14+ requires the callback before the virtual display. It fires when the user
        // stops sharing from the system (status bar chip, lock screen, another app taking over).
        mp.registerCallback(object : MediaProjection.Callback() {
            override fun onStop() {
                main.post { if (projection === mp) stop() }
            }
        }, main)

        size = measure(app)
        val r = newReader(size, h)
        reader = r
        display = try {
            mp.createVirtualDisplay(
                "call9me-screen", size.width, size.height, size.dpi,
                DisplayManager.VIRTUAL_DISPLAY_FLAG_AUTO_MIRROR, r.surface, null, h,
            )
        } catch (e: Exception) {
            null
        }
        if (display == null) {
            stop()
            return false
        }

        // Follow rotation: the shared picture turns with the phone.
        val listener = object : DisplayManager.DisplayListener {
            override fun onDisplayChanged(displayId: Int) {
                if (displayId == Display.DEFAULT_DISPLAY) resize()
            }
            override fun onDisplayAdded(displayId: Int) {}
            override fun onDisplayRemoved(displayId: Int) {}
        }
        app.getSystemService(DisplayManager::class.java)?.registerDisplayListener(listener, h)
        displayListener = listener

        WebViewHolder.command("screenShare", "started")
        return true
    }

    /** Stops capturing (if sharing) and tells the page and the call service. Main thread. */
    fun stop() {
        val mp = projection ?: return
        projection = null
        val app = appContext
        displayListener?.let { app?.getSystemService(DisplayManager::class.java)?.unregisterDisplayListener(it) }
        displayListener = null
        display?.release()
        display = null
        try {
            mp.stop()
        } catch (e: Exception) {
            // Already stopped.
        }
        val r = reader
        val t = thread
        val h = worker
        reader = null
        thread = null
        worker = null
        h?.post {
            r?.close()
            bitmap?.recycle()
            bitmap = null
            t?.quitSafely()
        }
        WebViewHolder.command("screenShare", "ended")
        if (app != null) CallService.screenStopped(app)
    }

    // ---- Capture (worker thread) ----

    @Suppress("DEPRECATION")
    private fun measure(context: Context): Size {
        val metrics = DisplayMetrics()
        context.getSystemService(DisplayManager::class.java)?.getDisplay(Display.DEFAULT_DISPLAY)?.getRealMetrics(metrics)
        val w = max(metrics.widthPixels, 2)
        val h = max(metrics.heightPixels, 2)
        val scale = min(1f, MAX_EDGE.toFloat() / max(w, h))
        // Even sizes: video encoders want them.
        val width = ((w * scale).toInt() / 2) * 2
        val height = ((h * scale).toInt() / 2) * 2
        return Size(max(width, 2), max(height, 2), max((metrics.densityDpi * scale).toInt(), 1))
    }

    private fun newReader(size: Size, handler: Handler): ImageReader =
        ImageReader.newInstance(size.width, size.height, PixelFormat.RGBA_8888, 2).apply {
            setOnImageAvailableListener({ schedulePull(0L) }, handler)
        }

    private fun resize() {
        val app = appContext ?: return
        val d = display ?: return
        val h = worker ?: return
        val next = measure(app)
        if (next == size) return
        size = next
        val old = reader
        val r = newReader(next, h)
        reader = r
        d.resize(next.width, next.height, next.dpi)
        d.surface = r.surface
        old?.close()
    }

    /** Takes the newest picture when the page is ready for one and the frame rate allows. */
    private fun schedulePull(delay: Long) {
        val h = worker ?: return
        if (pullScheduled) return
        pullScheduled = true
        h.postDelayed({
            pullScheduled = false
            pull()
        }, delay)
    }

    private fun pull() {
        val r = reader ?: return
        val proxy = replyProxy ?: return
        val now = SystemClock.uptimeMillis()
        if (awaitingAckSince != 0L && now - awaitingAckSince < ACK_TIMEOUT_MS) {
            schedulePull(ACK_TIMEOUT_MS - (now - awaitingAckSince)) // the ack usually comes first
            return
        }
        val wait = MIN_FRAME_MS - (now - lastFrameAt)
        if (wait > 0) {
            schedulePull(wait)
            return
        }
        val image = try {
            r.acquireLatestImage()
        } catch (e: Exception) {
            null
        } ?: return

        val bytes = try {
            image.use {
                val plane = it.planes[0]
                val pixelStride = plane.pixelStride
                val rowWidth = plane.rowStride / pixelStride // rows may be padded
                var bmp = bitmap
                if (bmp == null || bmp.width != rowWidth || bmp.height != it.height) {
                    bmp?.recycle()
                    bmp = Bitmap.createBitmap(rowWidth, it.height, Bitmap.Config.ARGB_8888)
                    bitmap = bmp
                }
                bmp.copyPixelsFromBuffer(plane.buffer)
                val frame = if (rowWidth == it.width) bmp else Bitmap.createBitmap(bmp, 0, 0, it.width, it.height)
                jpeg.reset()
                frame.compress(Bitmap.CompressFormat.JPEG, JPEG_QUALITY, jpeg)
                if (frame !== bmp) frame.recycle()
                jpeg.toByteArray()
            }
        } catch (e: Exception) {
            return
        }

        lastFrameAt = now
        awaitingAckSince = now
        val asBinary = binary
        main.post {
            if (projection == null || replyProxy !== proxy) return@post
            try {
                if (asBinary) proxy.postMessage(bytes) else proxy.postMessage(Base64.encodeToString(bytes, Base64.NO_WRAP))
            } catch (e: Exception) {
                // The page went away.
            }
        }
    }
}
