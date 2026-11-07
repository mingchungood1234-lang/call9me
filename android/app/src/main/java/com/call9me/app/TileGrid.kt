package com.call9me.app

import android.annotation.SuppressLint
import android.content.Context
import android.graphics.Color
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.text.TextUtils
import android.util.TypedValue
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.widget.FrameLayout
import android.widget.TextView
import org.webrtc.EglBase
import org.webrtc.RendererCommon
import org.webrtc.SurfaceViewRenderer
import org.webrtc.VideoTrack
import kotlin.math.ceil
import kotlin.math.max
import kotlin.math.min

/**
 * One person's video (or their screen share) on the call screen: the picture, or their initial
 * when there's none, their name, and "Connecting…" while the connection isn't up.
 */
@SuppressLint("ViewConstructor")
class Tile(
    context: Context,
    eglContext: EglBase.Context?,
    val key: String,
    /** Screen shares are shown whole (letterboxed); cameras fill the tile. */
    val isScreen: Boolean,
    /** Our own camera: drawn above other videos (it can float over them). */
    val isLocal: Boolean,
) : FrameLayout(context) {
    private val renderer = SurfaceViewRenderer(context)
    private val avatar = TextView(context)
    private val name = TextView(context)
    private val status = TextView(context)
    private var track: VideoTrack? = null
    private var mirrored = false
    private var released = false

    init {
        setBackgroundResource(R.drawable.bg_tile)
        clipToOutline = true
        renderer.init(eglContext, null)
        renderer.setEnableHardwareScaler(true)
        renderer.setScalingType(if (isScreen) RendererCommon.ScalingType.SCALE_ASPECT_FIT else RendererCommon.ScalingType.SCALE_ASPECT_FILL)
        if (isLocal) renderer.setZOrderMediaOverlay(true)
        renderer.visibility = View.GONE
        addView(renderer, LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.MATCH_PARENT))

        avatar.gravity = Gravity.CENTER
        avatar.setTextColor(Color.WHITE)
        avatar.typeface = Typeface.DEFAULT_BOLD
        addView(avatar, LayoutParams(0, 0, Gravity.CENTER))

        status.setTextColor(0xCCFFFFFF.toInt())
        status.setTextSize(TypedValue.COMPLEX_UNIT_SP, 13f)
        status.gravity = Gravity.CENTER
        addView(status, LayoutParams(LayoutParams.WRAP_CONTENT, LayoutParams.WRAP_CONTENT, Gravity.CENTER))

        name.setTextColor(Color.WHITE)
        name.setTextSize(TypedValue.COMPLEX_UNIT_SP, 13f)
        name.setBackgroundResource(R.drawable.bg_pill)
        name.maxLines = 1
        name.ellipsize = TextUtils.TruncateAt.END
        val pad = dp(8)
        name.setPadding(pad, dp(3), pad, dp(3))
        addView(name, LayoutParams(LayoutParams.WRAP_CONTENT, LayoutParams.WRAP_CONTENT, Gravity.BOTTOM or Gravity.START).apply {
            setMargins(pad, pad, pad, pad)
        })
    }

    /**
     * @param video the picture, or null to show the initial; `label` names the tile;
     * `statusText` shows over it (e.g. "Connecting…"), or "" for none.
     */
    fun bind(video: VideoTrack?, label: String, initial: String, statusText: String, mirror: Boolean) {
        if (released) return
        if (video !== track) {
            track?.let { old -> runCatching { old.removeSink(renderer) } }
            track = video
            if (video != null) {
                runCatching { video.addSink(renderer) }
            } else {
                renderer.clearImage()
            }
        }
        if (mirror != mirrored) {
            mirrored = mirror
            renderer.setMirror(mirror)
        }
        renderer.visibility = if (video != null) View.VISIBLE else View.GONE
        avatar.visibility = if (video != null) View.GONE else View.VISIBLE
        avatar.text = initial
        avatar.background = GradientDrawable().apply {
            shape = GradientDrawable.OVAL
            setColor(colorFor(key.substringBefore(':')))
        }
        name.text = label
        status.text = statusText
        status.visibility = if (statusText.isEmpty()) View.GONE else View.VISIBLE
    }

    override fun onSizeChanged(w: Int, h: Int, oldw: Int, oldh: Int) {
        super.onSizeChanged(w, h, oldw, oldh)
        // The initial scales with the tile: big on a full screen, small in a thumbnail.
        val size = (min(w, h) * 0.38f).toInt().coerceIn(dp(28), dp(120))
        avatar.layoutParams = (avatar.layoutParams as LayoutParams).apply {
            width = size
            height = size
        }
        avatar.setTextSize(TypedValue.COMPLEX_UNIT_PX, size * 0.45f)
        name.visibility = if (min(w, h) < dp(72)) View.GONE else View.VISIBLE
        status.translationY = if (avatar.visibility == View.VISIBLE) size * 0.5f + dp(16) else 0f
    }

    fun release() {
        if (released) return
        released = true
        track?.let { old -> runCatching { old.removeSink(renderer) } }
        track = null
        renderer.release()
    }

    private fun dp(value: Int) = (value * resources.displayMetrics.density).toInt()

    private fun colorFor(id: String): Int {
        val hue = (id.fold(0) { acc, c -> (acc * 31 + c.code) and 0x7fffffff } % 360).toFloat()
        return Color.HSVToColor(floatArrayOf(hue, 0.55f, 0.72f))
    }
}

/**
 * Lays out the tiles for the phone's shape:
 * - a pinned tile (tapped, or a screen share) fills the space, with the others in a strip
 *   along the bottom (portrait) or the right (landscape);
 * - two people: the other person fills the screen, our camera floats in a corner;
 * - otherwise a grid with as many columns as gives the biggest tiles.
 * `insets` keep tiles clear of the top bar and the controls.
 */
class TileGrid(context: Context) : ViewGroup(context) {
    var pinnedKey: String? = null
        set(value) {
            field = value
            requestLayout()
        }

    /** Space to leave free: left, top, right, bottom (px). */
    var insets = intArrayOf(0, 0, 0, 0)
        set(value) {
            field = value
            requestLayout()
        }

    private val gap = (6 * resources.displayMetrics.density).toInt()

    val tiles: List<Tile> get() = (0 until childCount).map { getChildAt(it) as Tile }

    override fun onMeasure(widthMeasureSpec: Int, heightMeasureSpec: Int) {
        val w = MeasureSpec.getSize(widthMeasureSpec)
        val h = MeasureSpec.getSize(heightMeasureSpec)
        setMeasuredDimension(w, h)
        val boxes = layoutBoxes(w, h)
        tiles.forEachIndexed { i, tile ->
            val box = boxes[i]
            tile.measure(
                MeasureSpec.makeMeasureSpec(max(box[2] - box[0], 0), MeasureSpec.EXACTLY),
                MeasureSpec.makeMeasureSpec(max(box[3] - box[1], 0), MeasureSpec.EXACTLY),
            )
        }
    }

    override fun onLayout(changed: Boolean, l: Int, t: Int, r: Int, b: Int) {
        val boxes = layoutBoxes(r - l, b - t)
        tiles.forEachIndexed { i, tile ->
            val box = boxes[i]
            tile.layout(box[0], box[1], box[2], box[3])
        }
    }

    /** [left, top, right, bottom] for each tile, in child order. */
    private fun layoutBoxes(width: Int, height: Int): List<IntArray> {
        val all = tiles
        val n = all.size
        if (n == 0) return emptyList()
        val left = insets[0] + gap
        val top = insets[1] + gap
        val right = width - insets[2] - gap
        val bottom = height - insets[3] - gap
        val w = max(right - left, 1)
        val h = max(bottom - top, 1)
        val landscape = width > height
        val boxes = MutableList(n) { intArrayOf(0, 0, 0, 0) }

        val pinned = all.indexOfFirst { it.key == pinnedKey }.takeIf { it >= 0 }
            ?: all.indexOfFirst { it.isScreen }.takeIf { it >= 0 && n > 1 }

        // Two people, no screen share: them full screen (edge to edge), us floating in a corner.
        if (pinned == null && n == 2 && all.count { it.isLocal } == 1) {
            val local = all.indexOfFirst { it.isLocal }
            boxes[1 - local] = intArrayOf(0, 0, width, height)
            val small = (min(width, height) * 0.30f).toInt()
            val (fw, fh) = if (landscape) Pair(small * 4 / 3, small) else Pair(small, small * 4 / 3)
            boxes[local] = intArrayOf(right - fw, bottom - fh, right, bottom)
            return boxes
        }

        if (pinned != null && n > 1) {
            val others = (0 until n).filter { it != pinned }
            val strip = (min(w, h) * 0.24f).toInt()
            if (landscape) {
                boxes[pinned] = intArrayOf(left, top, right - strip - gap, bottom)
                val each = (h - gap * (others.size - 1)) / others.size
                val size = min(each, strip * 3 / 4)
                others.forEachIndexed { i, idx ->
                    val y = top + i * (size + gap)
                    boxes[idx] = intArrayOf(right - strip, y, right, y + size)
                }
            } else {
                boxes[pinned] = intArrayOf(left, top, right, bottom - strip - gap)
                val each = (w - gap * (others.size - 1)) / others.size
                val size = min(each, strip * 3 / 4)
                others.forEachIndexed { i, idx ->
                    val x = left + i * (size + gap)
                    boxes[idx] = intArrayOf(x, bottom - strip, x + size, bottom)
                }
            }
            return boxes
        }

        if (n == 1) {
            boxes[0] = intArrayOf(0, 0, width, height) // alone: edge to edge
            return boxes
        }

        // Grid: try every column count; keep the one whose tiles hold the biggest 4:3 / 3:4 picture.
        val aspect = if (landscape) 4f / 3f else 3f / 4f
        var bestCols = 1
        var bestArea = -1f
        for (cols in 1..n) {
            val rows = ceil(n / cols.toFloat()).toInt()
            val tw = (w - gap * (cols - 1)) / cols.toFloat()
            val th = (h - gap * (rows - 1)) / rows.toFloat()
            val pw = min(tw, th * aspect)
            val area = pw * (pw / aspect)
            if (area > bestArea) {
                bestArea = area
                bestCols = cols
            }
        }
        val cols = bestCols
        val rows = ceil(n / cols.toFloat()).toInt()
        val tw = (w - gap * (cols - 1)) / cols
        val th = (h - gap * (rows - 1)) / rows
        for (i in 0 until n) {
            val row = i / cols
            val inRow = if (row == rows - 1) n - row * cols else cols
            // Center a shorter last row.
            val offset = (w - (inRow * tw + (inRow - 1) * gap)) / 2
            val col = i % cols
            val x = left + offset + col * (tw + gap)
            val y = top + row * (th + gap)
            boxes[i] = intArrayOf(x, y, x + tw, y + th)
        }
        return boxes
    }
}
