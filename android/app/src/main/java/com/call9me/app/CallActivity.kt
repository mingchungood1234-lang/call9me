package com.call9me.app

import android.app.PictureInPictureParams
import android.content.res.Configuration
import android.graphics.Color
import android.graphics.PorterDuff
import android.media.projection.MediaProjectionManager
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.text.InputType
import android.util.Rational
import android.util.TypedValue
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.view.WindowManager
import android.widget.EditText
import android.widget.FrameLayout
import android.widget.ImageButton
import android.widget.LinearLayout
import android.widget.TextView
import androidx.activity.OnBackPressedCallback
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AlertDialog
import androidx.appcompat.app.AppCompatActivity
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat

/**
 * The native call screen (calls run in NativeCall). Video tiles fill the screen (TileGrid lays
 * them out for portrait or landscape); a top bar shows who's in the call, and the controls sit
 * along the bottom in portrait or down the right side in landscape. Tap the video to hide or
 * show them; tap a tile to spotlight it. Leaving the app shrinks the call to picture-in-picture.
 * "Chat" (or back) goes to the rest of the app while the call continues; the call notification,
 * or the bar at the top of the app, comes back here.
 */
class CallActivity : AppCompatActivity(), NativeCall.Listener {
    companion object {
        /** The call screen while it's open. */
        var current: CallActivity? = null
            private set

        private const val HIDE_CONTROLS_MS = 6_000L
    }

    private val handler = Handler(Looper.getMainLooper())
    private lateinit var root: FrameLayout
    private lateinit var grid: TileGrid
    private lateinit var topBar: LinearLayout
    private lateinit var titleView: TextView
    private lateinit var statusView: TextView
    private lateinit var controls: LinearLayout
    private lateinit var noticeView: TextView

    private lateinit var micBtn: ImageButton
    private lateinit var camBtn: ImageButton
    private lateinit var flipBtn: ImageButton
    private lateinit var screenBtn: ImageButton
    private lateinit var speakerBtn: ImageButton
    private lateinit var hangUpBtn: ImageButton

    private val tiles = LinkedHashMap<String, Tile>()
    private var bars = intArrayOf(0, 0, 0, 0)
    private var controlsShown = true
    private var inPip = false

    private val hideControls = Runnable { if (hasVideo()) setControlsShown(false) }
    private val hideNotice = Runnable { noticeView.animate().alpha(0f).setDuration(250).withEndAction { noticeView.visibility = View.GONE } }

    private val screenConsent = registerForActivityResult(ActivityResultContracts.StartActivityForResult()) { result ->
        val data = result.data
        if (result.resultCode == RESULT_OK && data != null && NativeCall.active) {
            CallService.startScreen(applicationContext, WebViewHolder.callTitle, WebViewHolder.callVideo, result.resultCode, data)
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        if (!NativeCall.active) {
            finish()
            return
        }
        current = this
        WindowCompat.setDecorFitsSystemWindows(window, false)
        WindowInsetsControllerCompat(window, window.decorView).apply {
            isAppearanceLightStatusBars = false
            isAppearanceLightNavigationBars = false
        }
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        if (Build.VERSION.SDK_INT >= 27) {
            setShowWhenLocked(true)
            setTurnScreenOn(true)
        }

        root = FrameLayout(this).apply { setBackgroundColor(0xFF0B0E1A.toInt()) }
        grid = TileGrid(this)
        root.addView(grid, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
        grid.setOnClickListener { toggleControls() }

        buildTopBar()
        buildControls()
        buildNotice()
        setContentView(root)

        ViewCompat.setOnApplyWindowInsetsListener(root) { _, insets ->
            val b = insets.getInsets(WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout())
            bars = intArrayOf(b.left, b.top, b.right, b.bottom)
            placeBars()
            insets
        }

        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() = minimize()
        })
        NativeCall.listener = this
        scheduleHide()
    }

    override fun onDestroy() {
        handler.removeCallbacksAndMessages(null)
        if (current === this) current = null
        if (NativeCall.listener === this) NativeCall.listener = null
        for (tile in tiles.values) tile.release()
        tiles.clear()
        WebViewHolder.activity?.updateCallBar()
        super.onDestroy()
    }

    // ---- Layout ----

    private fun buildTopBar() {
        topBar = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            setBackgroundColor(0x990B0E1A.toInt())
        }
        topBar.addView(iconButton(R.drawable.ic_chat, R.string.callChat) { minimize() })
        val texts = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(8), 0, dp(8), 0)
        }
        titleView = TextView(this).apply {
            setTextColor(Color.WHITE)
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 17f)
            paint.isFakeBoldText = true
            maxLines = 1
            ellipsize = android.text.TextUtils.TruncateAt.END
        }
        statusView = TextView(this).apply {
            setTextColor(0xB3FFFFFF.toInt())
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 13f)
            maxLines = 1
            ellipsize = android.text.TextUtils.TruncateAt.END
        }
        texts.addView(titleView)
        texts.addView(statusView)
        topBar.addView(texts, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f))
        topBar.addView(iconButton(R.drawable.ic_person_add, R.string.callAddPerson) { askInvite() })
        root.addView(topBar, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT, Gravity.TOP))
    }

    private fun buildControls() {
        controls = LinearLayout(this).apply { gravity = Gravity.CENTER }
        micBtn = iconButton(R.drawable.ic_mic, R.string.callMic) { NativeCall.setMic(!NativeCall.micOn) }
        camBtn = iconButton(R.drawable.ic_videocam, R.string.callCamera) { NativeCall.setCamera(NativeCall.cameraTrack == null) }
        flipBtn = iconButton(R.drawable.ic_switch_camera, R.string.callFlip) { NativeCall.flipCamera() }
        screenBtn = iconButton(R.drawable.ic_screen_share, R.string.callShareScreen) {
            if (NativeCall.sharing) NativeCall.stopScreen() else requestScreenShare()
        }
        speakerBtn = iconButton(R.drawable.ic_volume_up, R.string.callSpeaker) {
            AudioRouter.setSpeaker(this, !AudioRouter.speakerOn)
            render()
        }
        hangUpBtn = iconButton(R.drawable.ic_call_end, R.string.hangUp) { NativeCall.hangUp() }.apply {
            setBackgroundResource(R.drawable.bg_decline)
        }
        for (button in listOf(micBtn, camBtn, flipBtn, screenBtn, speakerBtn, hangUpBtn)) controls.addView(button)
        root.addView(controls)
    }

    private fun buildNotice() {
        noticeView = TextView(this).apply {
            setTextColor(Color.WHITE)
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 14f)
            setBackgroundResource(R.drawable.bg_pill)
            setPadding(dp(14), dp(8), dp(14), dp(8))
            gravity = Gravity.CENTER
            visibility = View.GONE
        }
        root.addView(noticeView, FrameLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT, Gravity.TOP or Gravity.CENTER_HORIZONTAL))
    }

    private fun landscape() = resources.configuration.orientation == Configuration.ORIENTATION_LANDSCAPE

    /** Bars along the edges for this orientation; the grid keeps clear of them while shown. */
    private fun placeBars() {
        val (l, t, r, b) = bars.toList()
        val size = dp(56)
        val gap = dp(10)
        topBar.setPadding(l + dp(4), t + dp(4), r + dp(4), dp(6))
        controls.removeAllViews()
        val buttons = listOf(micBtn, camBtn, flipBtn, screenBtn, speakerBtn, hangUpBtn)
        if (landscape()) {
            controls.orientation = LinearLayout.VERTICAL
            controls.setPadding(dp(8), t + dp(8), r + dp(12), b + dp(8))
            controls.layoutParams = FrameLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.MATCH_PARENT, Gravity.END)
            // Short screens: smaller buttons so all six fit.
            val fit = ((resources.displayMetrics.heightPixels - t - b - dp(16)) / buttons.size) - dp(6)
            val s = fit.coerceIn(dp(40), size)
            for (button in buttons) controls.addView(button, LinearLayout.LayoutParams(s, s).apply { setMargins(0, dp(3), 0, dp(3)) })
        } else {
            controls.orientation = LinearLayout.HORIZONTAL
            controls.setPadding(l + dp(8), dp(10), r + dp(8), b + dp(14))
            controls.layoutParams = FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT, Gravity.BOTTOM)
            val fit = (resources.displayMetrics.widthPixels - l - r - dp(16)) / buttons.size - gap
            val s = fit.coerceIn(dp(40), size)
            for (button in buttons) controls.addView(button, LinearLayout.LayoutParams(s, s).apply { setMargins(gap / 2, 0, gap / 2, 0) })
        }
        (noticeView.layoutParams as FrameLayout.LayoutParams).topMargin = t + dp(72)
        updateGridInsets()
    }

    private fun updateGridInsets() {
        if (inPip) {
            grid.insets = intArrayOf(0, 0, 0, 0)
            return
        }
        val (l, t, r, b) = bars.toList()
        if (!controlsShown) {
            grid.insets = intArrayOf(l, t, r, b)
            return
        }
        topBar.post {
            val top = topBar.height
            grid.insets = if (landscape()) {
                intArrayOf(l, top, controls.width.takeIf { it > 0 } ?: (r + dp(76)), b)
            } else {
                intArrayOf(l, top, r, controls.height.takeIf { it > 0 } ?: (b + dp(80)))
            }
        }
    }

    override fun onConfigurationChanged(newConfig: Configuration) {
        super.onConfigurationChanged(newConfig)
        placeBars()
    }

    // ---- NativeCall.Listener ----

    override fun onCallChanged() {
        if (!isFinishing) render()
    }

    override fun onNotice(message: String) {
        if (message.isEmpty() || inPip) return
        noticeView.text = message
        noticeView.alpha = 1f
        noticeView.visibility = View.VISIBLE
        handler.removeCallbacks(hideNotice)
        handler.postDelayed(hideNotice, 3_500)
    }

    override fun onCallEnded() {
        finish()
    }

    // ---- Rendering ----

    private fun render() {
        titleView.text = NativeCall.title
        statusView.text = NativeCall.status

        // The tiles we want, in order: other people's screens and cameras, then our own.
        val wanted = LinkedHashMap<String, () -> Unit>()
        val peers = NativeCall.peerViews()
        for (peer in peers) {
            if (peer.sharing) wanted["${peer.id}:screen"] = {}
            wanted["${peer.id}:camera"] = {}
        }
        if (NativeCall.localScreenShared) wanted["self:screen"] = {}
        wanted["self:camera"] = {}

        // Drop tiles that are gone (releasing their video first).
        for (key in tiles.keys.toList()) {
            if (key !in wanted) {
                val tile = tiles.remove(key) ?: continue
                tile.release()
                grid.removeView(tile)
                if (grid.pinnedKey == key) grid.pinnedKey = null
            }
        }
        // Add new ones, keeping the order: remove and re-add only if the order changed.
        val order = wanted.keys.toList()
        for (key in order) {
            if (key !in tiles) {
                val tile = Tile(this, NativeCall.eglContext, key, isScreen = key.endsWith(":screen"), isLocal = key == "self:camera")
                tile.setOnClickListener { onTileTapped(key) }
                tiles[key] = tile
            }
        }
        val current = grid.tiles.map { it.key }
        if (current != order) {
            grid.removeAllViews()
            for (key in order) grid.addView(tiles[key])
        }

        for (peer in peers) {
            val connecting = peer.state != "connected"
            val status = when (peer.state) {
                "connected" -> ""
                "disconnected", "failed" -> getString(R.string.callReconnecting)
                else -> getString(R.string.callConnecting)
            }
            tiles["${peer.id}:camera"]?.bind(
                video = if (peer.cameraOn && !connecting) peer.camera else null,
                label = peer.id,
                initial = peer.id.take(1).uppercase(),
                statusText = status,
                mirror = false,
            )
            tiles["${peer.id}:screen"]?.bind(peer.screen, getString(R.string.callTheirScreen, peer.id), "▣", "", mirror = false)
        }
        tiles["self:screen"]?.bind(null, getString(R.string.callYourScreen), "▣", getString(R.string.callSharingNote), mirror = false)
        tiles["self:camera"]?.bind(
            video = NativeCall.cameraTrack,
            label = getString(R.string.callYou),
            initial = getString(R.string.callYou).take(1),
            statusText = "",
            mirror = NativeCall.facing == "user",
        )

        renderControls()
        if (!hasVideo()) setControlsShown(true)
    }

    private fun renderControls() {
        val micOn = NativeCall.micOn
        micBtn.setImageResource(if (micOn) R.drawable.ic_mic else R.drawable.ic_mic_off)
        style(micBtn, if (micOn) Style.NORMAL else Style.ALERT)
        val camOn = NativeCall.cameraTrack != null
        camBtn.setImageResource(if (camOn) R.drawable.ic_videocam else R.drawable.ic_videocam_off)
        style(camBtn, if (camOn) Style.NORMAL else Style.ALERT)
        flipBtn.visibility = if (camOn) View.VISIBLE else View.GONE
        style(flipBtn, Style.NORMAL)
        style(screenBtn, if (NativeCall.sharing) Style.ON else Style.NORMAL)
        speakerBtn.setImageResource(if (AudioRouter.speakerOn) R.drawable.ic_volume_up else R.drawable.ic_volume_down)
        style(speakerBtn, if (AudioRouter.speakerOn) Style.ON else Style.NORMAL)
    }

    private enum class Style { NORMAL, ON, ALERT }

    private fun style(button: ImageButton, style: Style) {
        button.setBackgroundResource(
            when (style) {
                Style.NORMAL -> R.drawable.bg_ctrl
                Style.ON -> R.drawable.bg_ctrl_on
                Style.ALERT -> R.drawable.bg_ctrl_alert
            },
        )
        button.setColorFilter(if (style == Style.ON) 0xFF0B0E1A.toInt() else Color.WHITE, PorterDuff.Mode.SRC_IN)
    }

    private fun onTileTapped(key: String) {
        if (inPip) return
        if (tiles.size > 1) grid.pinnedKey = if (grid.pinnedKey == key) null else key
        setControlsShown(true)
        scheduleHide()
    }

    private fun hasVideo(): Boolean = tiles.values.any { it.isScreen } || NativeCall.peerViews().any { it.camera != null && it.cameraOn }

    // ---- Controls visibility ----

    private fun toggleControls() {
        setControlsShown(!controlsShown)
        if (controlsShown) scheduleHide()
    }

    private fun setControlsShown(shown: Boolean) {
        if (inPip) return
        controlsShown = shown
        val visibility = if (shown) View.VISIBLE else View.GONE
        topBar.visibility = visibility
        controls.visibility = visibility
        updateGridInsets()
    }

    private fun scheduleHide() {
        handler.removeCallbacks(hideControls)
        handler.postDelayed(hideControls, HIDE_CONTROLS_MS)
    }

    // ---- Actions ----

    /** Back to the rest of the app (chat, rooms) while the call continues. */
    private fun minimize() {
        finish()
    }

    fun requestScreenShare() {
        val manager = getSystemService(MediaProjectionManager::class.java) ?: return
        try {
            screenConsent.launch(manager.createScreenCaptureIntent())
        } catch (e: Exception) {
            onNotice(getString(R.string.callShareFailed))
        }
    }

    private fun askInvite() {
        val input = EditText(this).apply {
            hint = getString(R.string.callInviteHint)
            inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS
            maxLines = 1
        }
        val box = FrameLayout(this).apply {
            setPadding(dp(20), dp(8), dp(20), 0)
            addView(input)
        }
        AlertDialog.Builder(this)
            .setTitle(R.string.callAddPerson)
            .setView(box)
            .setPositiveButton(R.string.callInvite) { _, _ ->
                val id = input.text.toString().trim().lowercase()
                if (id.isNotEmpty()) NativeCall.invite(id)
            }
            .setNegativeButton(android.R.string.cancel, null)
            .show()
    }

    // ---- Picture-in-picture ----

    override fun onUserLeaveHint() {
        super.onUserLeaveHint()
        // Home pressed during a video call: keep watching in a small window.
        if (Build.VERSION.SDK_INT >= 26 && hasVideo() && !NativeCall.sharing) {
            try {
                val ratio = if (landscape()) Rational(16, 9) else Rational(9, 16)
                enterPictureInPictureMode(PictureInPictureParams.Builder().setAspectRatio(ratio).build())
            } catch (e: Exception) {
                // Not supported here.
            }
        }
    }

    override fun onPictureInPictureModeChanged(isInPictureInPictureMode: Boolean, newConfig: Configuration) {
        super.onPictureInPictureModeChanged(isInPictureInPictureMode, newConfig)
        inPip = isInPictureInPictureMode
        val visibility = if (inPip || !controlsShown) View.GONE else View.VISIBLE
        topBar.visibility = visibility
        controls.visibility = visibility
        noticeView.visibility = View.GONE
        updateGridInsets()
    }

    // ---- Helpers ----

    private fun iconButton(icon: Int, description: Int, onClick: () -> Unit): ImageButton = ImageButton(this).apply {
        setImageResource(icon)
        contentDescription = getString(description)
        setBackgroundResource(R.drawable.bg_ctrl)
        setColorFilter(Color.WHITE, PorterDuff.Mode.SRC_IN)
        scaleType = android.widget.ImageView.ScaleType.CENTER
        setPadding(dp(12), dp(12), dp(12), dp(12))
        layoutParams = LinearLayout.LayoutParams(dp(48), dp(48)).apply { setMargins(dp(4), 0, dp(4), 0) }
        setOnClickListener {
            onClick()
            scheduleHide()
        }
    }

    private fun dp(value: Int) = (value * resources.displayMetrics.density).toInt()
}
