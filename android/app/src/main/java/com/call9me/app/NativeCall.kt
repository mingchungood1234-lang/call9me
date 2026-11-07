package com.call9me.app

import android.Manifest
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.hardware.display.DisplayManager
import android.media.projection.MediaProjection
import android.os.Handler
import android.os.Looper
import android.util.DisplayMetrics
import android.view.Display
import androidx.core.content.ContextCompat
import kotlinx.coroutines.MainScope
import kotlinx.coroutines.launch
import kotlinx.coroutines.suspendCancellableCoroutine
import org.json.JSONArray
import org.json.JSONObject
import org.webrtc.AudioSource
import org.webrtc.AudioTrack
import org.webrtc.Camera1Enumerator
import org.webrtc.Camera2Enumerator
import org.webrtc.CameraEnumerator
import org.webrtc.CameraVideoCapturer
import org.webrtc.DataChannel
import org.webrtc.DefaultVideoDecoderFactory
import org.webrtc.DefaultVideoEncoderFactory
import org.webrtc.EglBase
import org.webrtc.IceCandidate
import org.webrtc.MediaConstraints
import org.webrtc.MediaStream
import org.webrtc.MediaStreamTrack
import org.webrtc.PeerConnection
import org.webrtc.PeerConnectionFactory
import org.webrtc.RtpReceiver
import org.webrtc.RtpTransceiver
import org.webrtc.ScreenCapturerAndroid
import org.webrtc.SdpObserver
import org.webrtc.SessionDescription
import org.webrtc.SurfaceTextureHelper
import org.webrtc.VideoSource
import org.webrtc.VideoTrack
import org.webrtc.audio.JavaAudioDeviceModule
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException
import kotlin.math.max
import kotlin.math.min

/**
 * Native calls: the call's media in the app (Google's WebRTC), shown on CallActivity. The page
 * keeps the call's logic and the socket (CallManager + src/client/lib/nativeCall.ts) and relays
 * signaling; this mirrors CallManager's peer rules exactly, so browsers on the other end see
 * the same thing as from another browser:
 *
 * - one PeerConnection per other person (full mesh);
 * - whoever joins makes the offers; only the offerer restarts ICE;
 * - every connection has two send-capable video slots: [camera, screen share], switched with
 *   setTrack, no renegotiation; the second slot received is the peer's screen.
 *
 * Everything here runs on the main thread (WebRTC callbacks hop over to it).
 */
object NativeCall {
    /** Notified on the main thread; CallActivity redraws from the getters below. */
    interface Listener {
        fun onCallChanged()
        fun onNotice(message: String)
        fun onCallEnded()
    }

    class PeerView(
        val id: String,
        val camera: VideoTrack?,
        val screen: VideoTrack?,
        val cameraOn: Boolean,
        val sharing: Boolean,
        /** RTCPeerConnectionState as the page names it: new, connecting, connected, … */
        val state: String,
    )

    private class Peer(val id: String, val offerer: Boolean) {
        lateinit var pc: PeerConnection
        val pendingIce = mutableListOf<IceCandidate>()
        var remoteSet = false
        var camera: VideoTrack? = null
        var screen: VideoTrack? = null
        var state = "new"
        var restarts = 0
        var restartTask: Runnable? = null
    }

    private const val MAX_ICE_RESTARTS = 3
    private const val DISCONNECT_GRACE_MS = 4_000L
    private const val SCREEN_MAX_EDGE = 1920
    private const val SCREEN_FPS = 15

    private val main = Handler(Looper.getMainLooper())
    private val scope = MainScope()

    private var factory: PeerConnectionFactory? = null
    private var egl: EglBase? = null
    private var factoryFailed = false

    var listener: Listener? = null
        set(value) {
            field = value
            value?.onCallChanged()
        }

    /** A call is running natively. */
    var active = false
        private set
    /** Bumped on every stop, so late async steps of an old call do nothing. */
    private var generation = 0
    private var appContext: Context? = null
    private var iceServers: List<PeerConnection.IceServer> = emptyList()
    private var wantVideo = false

    private var audioSource: AudioSource? = null
    private var audioTrack: AudioTrack? = null
    var micOn = false
        private set

    private var cameraCapturer: CameraVideoCapturer? = null
    private var cameraHelper: SurfaceTextureHelper? = null
    private var cameraSource: VideoSource? = null
    var cameraTrack: VideoTrack? = null
        private set
    /** "user" (front, shown mirrored) or "environment". */
    var facing = "user"
        private set

    private var screenCapturer: ScreenCapturerAndroid? = null
    private var screenHelper: SurfaceTextureHelper? = null
    private var screenSource: VideoSource? = null
    private var screenTrack: VideoTrack? = null
    private var screenRotation: DisplayManager.DisplayListener? = null
    val sharing: Boolean get() = screenTrack != null

    private val peers = LinkedHashMap<String, Peer>()
    private val cameraOff = mutableSetOf<String>()
    private val peerSharing = mutableSetOf<String>()

    // From the page (CallManager): who's in the call.
    var roomId: String? = null
        private set
    var participants: List<String> = emptyList()
        private set
    var invited: List<String> = emptyList()
        private set
    var away: List<String> = emptyList()
        private set

    val eglContext: EglBase.Context? get() = egl?.eglBaseContext

    /** The phone can run calls natively (the WebRTC library loads). Any thread. */
    @Synchronized
    fun supported(context: Context): Boolean {
        if (factory != null) return true
        if (factoryFailed) return false
        return try {
            val app = context.applicationContext
            PeerConnectionFactory.initialize(PeerConnectionFactory.InitializationOptions.builder(app).createInitializationOptions())
            val base = EglBase.create()
            val adm = JavaAudioDeviceModule.builder(app)
                .setUseHardwareAcousticEchoCanceler(true)
                .setUseHardwareNoiseSuppressor(true)
                .createAudioDeviceModule()
            factory = PeerConnectionFactory.builder()
                .setAudioDeviceModule(adm)
                .setVideoEncoderFactory(DefaultVideoEncoderFactory(base.eglBaseContext, true, true))
                .setVideoDecoderFactory(DefaultVideoDecoderFactory(base.eglBaseContext))
                .createPeerConnectionFactory()
            egl = base
            true
        } catch (t: Throwable) {
            factoryFailed = true
            false
        }
    }

    // ---- From the page ----

    /** A message from the page (src/client/lib/nativeCall.ts). Main thread. */
    fun onPageMessage(context: Context, message: JSONObject) {
        val app = context.applicationContext
        appContext = app
        when (message.optString("op")) {
            "start" -> start(app, message)
            "stop" -> stop()
            "connect" -> if (active) connect(message.optString("peer"))
            "offer" -> if (active) onOffer(message.optString("from"), message.optString("sdp"))
            "answer" -> if (active) onAnswer(message.optString("from"), message.optString("sdp"))
            "ice" -> if (active) onIce(message.optString("from"), message.optJSONObject("candidate"))
            "removePeer" -> removePeer(message.optString("peer"))
            "peerScreen" -> {
                val peer = message.optString("peer")
                if (message.optBoolean("sharing")) peerSharing.add(peer) else peerSharing.remove(peer)
                changed()
            }
            "peerCamera" -> {
                val peer = message.optString("peer")
                if (message.optBoolean("on")) cameraOff.remove(peer) else cameraOff.add(peer)
                changed()
            }
            "info" -> {
                roomId = message.optString("roomId").takeIf { it.isNotEmpty() && !message.isNull("roomId") }
                participants = message.optJSONArray("participants").strings()
                invited = message.optJSONArray("invited").strings()
                away = message.optJSONArray("away").strings()
                changed()
            }
            "notice" -> listener?.onNotice(message.optString("message"))
            "mic" -> setMic(message.optBoolean("on"))
            "camera" -> setCamera(message.optBoolean("on"))
            "flip" -> flipCamera()
            "screen" -> if (message.optBoolean("on")) requestScreenShare() else stopScreen()
            "show" -> showCallScreen()
        }
    }

    private fun start(app: Context, message: JSONObject) {
        stop()
        val gen = ++generation
        active = true
        wantVideo = message.optBoolean("video")
        facing = if (message.optString("facing") == "environment") "environment" else "user"
        iceServers = parseIceServers(message.optJSONArray("iceServers"))

        val needed = mutableListOf(Manifest.permission.RECORD_AUDIO)
        if (wantVideo) needed += Manifest.permission.CAMERA
        val missing = needed.filter { !granted(app, it) }
        val activity = WebViewHolder.activity
        if (missing.isEmpty() || activity == null) {
            open(app, gen)
        } else {
            activity.requestCallPermissions(missing) { if (gen == generation) open(app, gen) }
        }
    }

    /** Opens the microphone and camera, then the call screen. */
    private fun open(app: Context, gen: Int) {
        val factory = if (supported(app)) factory else null
        if (factory != null && granted(app, Manifest.permission.RECORD_AUDIO)) {
            val source = factory.createAudioSource(MediaConstraints())
            audioSource = source
            audioTrack = factory.createAudioTrack("mic", source)
            micOn = true
        }
        if (wantVideo && granted(app, Manifest.permission.CAMERA)) startCamera(app)
        if (gen != generation) return
        AudioRouter.start(app, wantVideo)
        send(JSONObject().put("op", "started").put("state", state()))
        WebViewHolder.retryCallService(app) // the microphone/camera service types are allowed now
        showCallScreen()
    }

    /** Ends the call's media and closes the call screen. */
    fun stop() {
        if (!active) return
        active = false
        generation++
        stopScreen(notify = false)
        for (id in peers.keys.toList()) dropPeer(id)
        stopCamera()
        audioTrack?.dispose()
        audioSource?.dispose()
        audioTrack = null
        audioSource = null
        micOn = false
        cameraOff.clear()
        peerSharing.clear()
        roomId = null
        participants = emptyList()
        invited = emptyList()
        away = emptyList()
        appContext?.let { AudioRouter.stop(it) }
        listener?.onCallEnded()
    }

    // ---- From the call screen ----

    fun hangUp() {
        send(JSONObject().put("op", "hangUp"))
    }

    fun invite(userId: String) {
        send(JSONObject().put("op", "invite").put("to", userId))
    }

    fun setMic(on: Boolean) {
        val track = audioTrack ?: return
        track.setEnabled(on)
        micOn = on
        stateChanged()
    }

    fun setCamera(on: Boolean) {
        val app = appContext ?: return
        if (!active || on == (cameraTrack != null)) return
        if (!on) {
            stopCamera()
            stateChanged()
            return
        }
        if (granted(app, Manifest.permission.CAMERA)) {
            startCamera(app)
            stateChanged()
            return
        }
        val gen = generation
        WebViewHolder.activity?.requestCallPermissions(listOf(Manifest.permission.CAMERA)) {
            if (gen == generation && cameraTrack == null && granted(app, Manifest.permission.CAMERA)) {
                startCamera(app)
                stateChanged()
            }
        }
    }

    fun flipCamera() {
        val capturer = cameraCapturer ?: return
        capturer.switchCamera(object : CameraVideoCapturer.CameraSwitchHandler {
            override fun onCameraSwitchDone(isFrontCamera: Boolean) {
                main.post {
                    facing = if (isFrontCamera) "user" else "environment"
                    stateChanged()
                }
            }

            override fun onCameraSwitchError(errorDescription: String?) {
                main.post { listener?.onNotice("Could not switch the camera.") }
            }
        })
    }

    /** Android's "Start sharing?" prompt, from whichever screen is showing. */
    fun requestScreenShare() {
        if (!active || sharing) return
        val call = CallActivity.current
        if (call != null) call.requestScreenShare() else WebViewHolder.activity?.requestScreenShare()
    }

    fun showCallScreen() {
        val app = appContext ?: return
        if (!active || CallActivity.current != null) return
        val from = WebViewHolder.activity
        val intent = Intent(app, CallActivity::class.java)
        if (from != null) {
            from.startActivity(intent)
        } else {
            try {
                app.startActivity(intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
            } catch (e: Exception) {
                // Not allowed from the background; the call notification opens it.
            }
        }
    }

    // ---- Getters for the call screen ----

    val localScreenShared: Boolean get() = sharing

    fun peerViews(): List<PeerView> {
        val ids = LinkedHashSet<String>()
        ids += participants
        ids += peers.keys
        return ids.map { id ->
            val peer = peers[id]
            PeerView(
                id = id,
                camera = peer?.camera,
                screen = peer?.screen,
                cameraOn = id !in cameraOff,
                sharing = id in peerSharing && peer?.screen != null,
                state = peer?.state ?: "new",
            )
        }
    }

    val title: String
        get() = when {
            roomId != null -> "#$roomId"
            participants.isNotEmpty() -> participants.joinToString(", ")
            invited.isNotEmpty() -> invited.joinToString(", ")
            else -> appContext?.getString(R.string.ongoingCall) ?: ""
        }

    val status: String
        get() = when {
            participants.isEmpty() && away.isNotEmpty() -> "${away.joinToString(", ")} left · waiting for them to rejoin…"
            participants.isEmpty() && roomId != null -> "Waiting for others to join…"
            participants.isEmpty() && invited.isNotEmpty() -> "Ringing…"
            participants.isEmpty() -> "Starting call…"
            else -> buildString {
                append("${participants.size + 1} people")
                if (invited.isNotEmpty()) append(" · ringing ${invited.joinToString(", ")}")
            }
        }

    // ---- Camera ----

    private fun startCamera(app: Context): Boolean {
        val factory = factory ?: return false
        val context = eglContext ?: return false
        val enumerator: CameraEnumerator = if (Camera2Enumerator.isSupported(app)) Camera2Enumerator(app) else Camera1Enumerator(true)
        val names = enumerator.deviceNames
        val front = facing == "user"
        val name = names.firstOrNull { enumerator.isFrontFacing(it) == front } ?: names.firstOrNull() ?: return false
        val capturer = enumerator.createCapturer(name, null) ?: return false
        facing = if (enumerator.isFrontFacing(name)) "user" else "environment"
        val helper = SurfaceTextureHelper.create("call9me-camera", context)
        val source = factory.createVideoSource(false)
        capturer.initialize(helper, app, source.capturerObserver)
        capturer.startCapture(1280, 720, 30)
        cameraCapturer = capturer
        cameraHelper = helper
        cameraSource = source
        cameraTrack = factory.createVideoTrack("camera", source)
        syncVideoSenders()
        return true
    }

    private fun stopCamera() {
        val track = cameraTrack ?: return
        cameraTrack = null
        syncVideoSenders()
        changed() // the call screen lets go of the track first
        try {
            cameraCapturer?.stopCapture()
        } catch (e: InterruptedException) {
            // Stopping anyway.
        }
        cameraCapturer?.dispose()
        track.dispose()
        cameraSource?.dispose()
        cameraHelper?.dispose()
        cameraCapturer = null
        cameraSource = null
        cameraHelper = null
    }

    // ---- Screen sharing ----

    /** The user agreed to share; CallService has the mediaProjection type now. */
    fun startScreen(app: Context, permission: Intent): Boolean {
        val factory = factory ?: return false
        val context = eglContext ?: return false
        if (!active) return false
        stopScreen(notify = false)
        val capturer = ScreenCapturerAndroid(permission, object : MediaProjection.Callback() {
            override fun onStop() {
                main.post { stopScreen() } // stopped from Android's own controls
            }
        })
        val helper = SurfaceTextureHelper.create("call9me-screen", context)
        val source = factory.createVideoSource(true)
        return try {
            capturer.initialize(helper, app, source.capturerObserver)
            val (w, h) = screenSize(app)
            capturer.startCapture(w, h, SCREEN_FPS)
            screenCapturer = capturer
            screenHelper = helper
            screenSource = source
            screenTrack = factory.createVideoTrack("screen", source)
            watchRotation(app)
            syncVideoSenders()
            stateChanged()
            true
        } catch (e: Exception) {
            capturer.dispose()
            source.dispose()
            helper.dispose()
            false
        }
    }

    fun stopScreen(notify: Boolean = true) {
        val track = screenTrack ?: return
        screenTrack = null
        syncVideoSenders()
        changed()
        val app = appContext
        screenRotation?.let { app?.getSystemService(DisplayManager::class.java)?.unregisterDisplayListener(it) }
        screenRotation = null
        try {
            screenCapturer?.stopCapture()
        } catch (e: Exception) {
            // Already stopped.
        }
        screenCapturer?.dispose()
        track.dispose()
        screenSource?.dispose()
        screenHelper?.dispose()
        screenCapturer = null
        screenSource = null
        screenHelper = null
        if (app != null) CallService.screenStopped(app)
        if (notify) stateChanged()
    }

    @Suppress("DEPRECATION")
    private fun screenSize(app: Context): Pair<Int, Int> {
        val metrics = DisplayMetrics()
        app.getSystemService(DisplayManager::class.java)?.getDisplay(Display.DEFAULT_DISPLAY)?.getRealMetrics(metrics)
        val w = max(metrics.widthPixels, 2)
        val h = max(metrics.heightPixels, 2)
        val scale = min(1f, SCREEN_MAX_EDGE.toFloat() / max(w, h))
        return Pair(((w * scale).toInt() / 2) * 2, ((h * scale).toInt() / 2) * 2)
    }

    /** The shared picture turns with the phone. */
    private fun watchRotation(app: Context) {
        var last = screenSize(app)
        val listener = object : DisplayManager.DisplayListener {
            override fun onDisplayChanged(displayId: Int) {
                if (displayId != Display.DEFAULT_DISPLAY) return
                val size = screenSize(app)
                if (size == last) return
                last = size
                screenCapturer?.changeCaptureFormat(size.first, size.second, SCREEN_FPS)
            }
            override fun onDisplayAdded(displayId: Int) {}
            override fun onDisplayRemoved(displayId: Int) {}
        }
        app.getSystemService(DisplayManager::class.java)?.registerDisplayListener(listener, main)
        screenRotation = listener
    }

    // ---- Connections ----

    private fun createPeer(id: String, offerer: Boolean): Peer? {
        val factory = factory ?: return null
        dropPeer(id)
        val peer = Peer(id, offerer)
        val config = PeerConnection.RTCConfiguration(iceServers).apply {
            sdpSemantics = PeerConnection.SdpSemantics.UNIFIED_PLAN
        }
        val pc = factory.createPeerConnection(config, Observer(peer)) ?: return null
        peer.pc = pc
        peers[id] = peer

        val streams = listOf("local")
        audioTrack?.let { pc.addTrack(it, streams) }
        cameraTrack?.let { pc.addTrack(it, streams) } // the first video slot: the camera
        if (offerer) {
            // Still ask to receive audio we cannot send (no mic).
            if (audioTrack == null) {
                pc.addTransceiver(MediaStreamTrack.MediaType.MEDIA_TYPE_AUDIO, RtpTransceiver.RtpTransceiverInit(RtpTransceiver.RtpTransceiverDirection.RECV_ONLY))
            }
            // Always negotiate video (even for voice calls), so cameras can be turned on later…
            if (cameraTrack == null) {
                pc.addTransceiver(MediaStreamTrack.MediaType.MEDIA_TYPE_VIDEO, RtpTransceiver.RtpTransceiverInit(RtpTransceiver.RtpTransceiverDirection.SEND_RECV))
            }
            // …and a second slot for a screen share.
            val screen = screenTrack
            if (screen != null) {
                pc.addTransceiver(screen, RtpTransceiver.RtpTransceiverInit(RtpTransceiver.RtpTransceiverDirection.SEND_RECV))
            } else {
                pc.addTransceiver(MediaStreamTrack.MediaType.MEDIA_TYPE_VIDEO, RtpTransceiver.RtpTransceiverInit(RtpTransceiver.RtpTransceiverDirection.SEND_RECV))
            }
        }
        changed()
        return peer
    }

    private fun connect(id: String) {
        val peer = createPeer(id, offerer = true) ?: return
        scope.launch {
            try {
                val offer = peer.pc.create(offer = true, MediaConstraints())
                if (peers[id] !== peer) return@launch
                peer.pc.setLocal(offer)
                signal(id, "offer", offer.description)
            } catch (e: Exception) {
                if (peers[id] === peer) {
                    listener?.onNotice("Could not connect to $id.")
                    removePeer(id)
                }
            }
        }
    }

    private fun onOffer(from: String, sdp: String) {
        val peer = peers[from] ?: createPeer(from, offerer = false) ?: return
        scope.launch {
            try {
                peer.pc.setRemote(SessionDescription(SessionDescription.Type.OFFER, sdp))
                if (peers[from] !== peer) return@launch
                peer.remoteSet = true
                // Keep our video slots send-capable even without a camera, for screen sharing.
                for (t in videoTransceivers(peer.pc)) {
                    if (t.sender.track() == null && t.direction == RtpTransceiver.RtpTransceiverDirection.RECV_ONLY) {
                        t.setDirection(RtpTransceiver.RtpTransceiverDirection.SEND_RECV)
                    }
                }
                syncPeerVideo(peer.pc)
                flushIce(peer)
                val answer = peer.pc.create(offer = false, MediaConstraints())
                if (peers[from] !== peer) return@launch
                peer.pc.setLocal(answer)
                signal(from, "answer", answer.description)
            } catch (e: Exception) {
                if (peers[from] === peer) {
                    listener?.onNotice("Could not connect to $from.")
                    removePeer(from)
                }
            }
        }
    }

    private fun onAnswer(from: String, sdp: String) {
        val peer = peers[from] ?: return
        scope.launch {
            try {
                peer.pc.setRemote(SessionDescription(SessionDescription.Type.ANSWER, sdp))
                if (peers[from] !== peer) return@launch
                peer.remoteSet = true
                flushIce(peer)
            } catch (e: Exception) {
                if (peers[from] === peer) removePeer(from)
            }
        }
    }

    private fun onIce(from: String, json: JSONObject?) {
        val peer = peers[from] ?: return
        val candidate = json ?: return
        val ice = IceCandidate(candidate.optString("sdpMid"), candidate.optInt("sdpMLineIndex"), candidate.optString("candidate"))
        if (!peer.remoteSet) peer.pendingIce += ice else peer.pc.addIceCandidate(ice)
    }

    private fun flushIce(peer: Peer) {
        val queued = peer.pendingIce.toList()
        peer.pendingIce.clear()
        for (ice in queued) peer.pc.addIceCandidate(ice)
    }

    /** The page removed this peer (left, moved, failed). */
    private fun removePeer(id: String) {
        dropPeer(id)
        cameraOff.remove(id)
        peerSharing.remove(id)
        changed()
    }

    private fun dropPeer(id: String) {
        val peer = peers.remove(id) ?: return
        peer.restartTask?.let { main.removeCallbacks(it) }
        changed() // the call screen lets go of their video first
        peer.camera?.let { runCatching { it.dispose() } }
        peer.screen?.let { runCatching { it.dispose() } }
        runCatching { peer.pc.dispose() }
    }

    /** Puts the camera and the screen share on every connection's video slots. */
    private fun syncVideoSenders() {
        for (peer in peers.values) syncPeerVideo(peer.pc)
    }

    private fun syncPeerVideo(pc: PeerConnection) {
        val video = videoTransceivers(pc)
        val camera = video.getOrNull(0)
        val screen = video.getOrNull(1)
        if (screen != null) {
            camera?.sender?.setTrack(cameraTrack, false)
            screen.sender.setTrack(screenTrack, false)
        } else {
            camera?.sender?.setTrack(screenTrack ?: cameraTrack, false) // older peer: one slot, the share wins
        }
    }

    /** The video slots in negotiation order: [camera, screen share]. */
    private fun videoTransceivers(pc: PeerConnection): List<RtpTransceiver> =
        pc.transceivers.filter { it.mediaType == MediaStreamTrack.MediaType.MEDIA_TYPE_VIDEO && !it.isStopped }

    private fun onTrack(peer: Peer, transceiver: RtpTransceiver) {
        if (peers[peer.id] !== peer) return
        val track = transceiver.receiver.track() as? VideoTrack ?: return // audio plays by itself
        val mids = videoTransceivers(peer.pc).map { it.mid }
        if (transceiver.mid != null && mids.indexOf(transceiver.mid) == 1) peer.screen = track else peer.camera = track
        changed()
    }

    private fun onConnectionChange(peer: Peer, newState: PeerConnection.PeerConnectionState) {
        if (peers[peer.id] !== peer) return
        peer.restartTask?.let { main.removeCallbacks(it) }
        peer.restartTask = null
        var reported = newState.name.lowercase()
        when (newState) {
            PeerConnection.PeerConnectionState.CONNECTED -> peer.restarts = 0
            PeerConnection.PeerConnectionState.DISCONNECTED -> if (peer.offerer) {
                // Usually a brief network hiccup that heals itself; restart ICE only if it doesn't.
                val task = Runnable { restartIce(peer) }
                peer.restartTask = task
                main.postDelayed(task, DISCONNECT_GRACE_MS)
            }
            PeerConnection.PeerConnectionState.FAILED -> if (peer.offerer && peer.restarts < MAX_ICE_RESTARTS) {
                restartIce(peer)
                reported = "disconnected" // shown as "Reconnecting…"
            }
            else -> Unit
        }
        peer.state = reported
        send(JSONObject().put("op", "peerState").put("peer", peer.id).put("state", reported))
        changed()
    }

    /** Renegotiates with fresh ICE candidates (e.g. after switching from Wi-Fi to mobile data). */
    private fun restartIce(peer: Peer) {
        if (peers[peer.id] !== peer || peer.pc.signalingState() != PeerConnection.SignalingState.STABLE) return
        if (peer.pc.connectionState() == PeerConnection.PeerConnectionState.CONNECTED) return
        peer.restarts++
        scope.launch {
            try {
                val constraints = MediaConstraints().apply { mandatory.add(MediaConstraints.KeyValuePair("IceRestart", "true")) }
                val offer = peer.pc.create(offer = true, constraints)
                if (peers[peer.id] !== peer) return@launch
                peer.pc.setLocal(offer)
                signal(peer.id, "offer", offer.description)
            } catch (e: Exception) {
                // Tried; the next state change may try again.
            }
        }
    }

    private class Observer(private val peer: Peer) : PeerConnection.Observer {
        override fun onIceCandidate(candidate: IceCandidate) {
            val json = JSONObject()
                .put("candidate", candidate.sdp)
                .put("sdpMid", candidate.sdpMid)
                .put("sdpMLineIndex", candidate.sdpMLineIndex)
            main.post { if (peers[peer.id] === peer) send(JSONObject().put("op", "signal").put("to", peer.id).put("kind", "ice").put("candidate", json)) }
        }

        override fun onTrack(transceiver: RtpTransceiver) {
            main.post { onTrack(peer, transceiver) }
        }

        override fun onConnectionChange(newState: PeerConnection.PeerConnectionState) {
            main.post { onConnectionChange(peer, newState) }
        }

        override fun onSignalingChange(state: PeerConnection.SignalingState) {}
        override fun onIceConnectionChange(state: PeerConnection.IceConnectionState) {}
        override fun onIceConnectionReceivingChange(receiving: Boolean) {}
        override fun onIceGatheringChange(state: PeerConnection.IceGatheringState) {}
        override fun onIceCandidatesRemoved(candidates: Array<out IceCandidate>) {}
        override fun onAddStream(stream: MediaStream) {}
        override fun onRemoveStream(stream: MediaStream) {}
        override fun onDataChannel(channel: DataChannel) {}
        override fun onRenegotiationNeeded() {}
        override fun onAddTrack(receiver: RtpReceiver, streams: Array<out MediaStream>) {}
    }

    // ---- Helpers ----

    private fun signal(to: String, kind: String, sdp: String) {
        send(JSONObject().put("op", "signal").put("to", to).put("kind", kind).put("sdp", sdp))
    }

    private fun state(): JSONObject = JSONObject()
        .put("audio", audioTrack != null)
        .put("mic", micOn)
        .put("camera", cameraTrack != null)
        .put("sharing", screenTrack != null)
        .put("facing", facing)

    private fun stateChanged() {
        send(JSONObject().put("op", "state").put("state", state()))
        changed()
    }

    private fun changed() {
        listener?.onCallChanged()
    }

    private fun send(message: JSONObject) {
        WebViewHolder.command("callMedia", message.toString())
    }

    private fun granted(context: Context, permission: String) =
        ContextCompat.checkSelfPermission(context, permission) == PackageManager.PERMISSION_GRANTED

    private fun parseIceServers(list: JSONArray?): List<PeerConnection.IceServer> {
        if (list == null) return emptyList()
        return (0 until list.length()).mapNotNull { i ->
            val server = list.optJSONObject(i) ?: return@mapNotNull null
            val urls = server.optJSONArray("urls").strings()
            if (urls.isEmpty()) return@mapNotNull null
            PeerConnection.IceServer.builder(urls)
                .setUsername(server.optString("username", ""))
                .setPassword(server.optString("credential", ""))
                .createIceServer()
        }
    }

    private fun JSONArray?.strings(): List<String> =
        if (this == null) emptyList() else (0 until length()).map { optString(it) }.filter { it.isNotEmpty() }

    private suspend fun PeerConnection.create(offer: Boolean, constraints: MediaConstraints): SessionDescription =
        suspendCancellableCoroutine { cont ->
            val observer = object : SdpObserver {
                override fun onCreateSuccess(description: SessionDescription) = cont.resume(description)
                override fun onCreateFailure(error: String?) = cont.resumeWithException(IllegalStateException(error))
                override fun onSetSuccess() {}
                override fun onSetFailure(error: String?) {}
            }
            if (offer) createOffer(observer, constraints) else createAnswer(observer, constraints)
        }

    private suspend fun PeerConnection.setLocal(description: SessionDescription) = setDescription(description, local = true)

    private suspend fun PeerConnection.setRemote(description: SessionDescription) = setDescription(description, local = false)

    private suspend fun PeerConnection.setDescription(description: SessionDescription, local: Boolean): Unit =
        suspendCancellableCoroutine { cont ->
            val observer = object : SdpObserver {
                override fun onCreateSuccess(description: SessionDescription) {}
                override fun onCreateFailure(error: String?) {}
                override fun onSetSuccess() = cont.resume(Unit)
                override fun onSetFailure(error: String?) = cont.resumeWithException(IllegalStateException(error))
            }
            if (local) setLocalDescription(observer, description) else setRemoteDescription(observer, description)
        }
}
