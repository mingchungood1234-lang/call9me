package com.call9me.app

import android.annotation.SuppressLint
import android.content.Context
import android.content.MutableContextWrapper
import android.graphics.Bitmap
import android.net.Uri
import android.os.Handler
import android.os.Looper
import android.view.View
import android.view.ViewGroup
import android.webkit.CookieManager
import android.webkit.JavascriptInterface
import android.webkit.PermissionRequest
import android.webkit.RenderProcessGoneDetail
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.webkit.WebSettingsCompat
import androidx.webkit.WebViewFeature
import org.json.JSONObject

/**
 * Owns the WebView that shows the Call9me site. It is kept apart from MainActivity so a call
 * (WebRTC in the page) survives the activity going away: the app in the background, the
 * screen off, or the app swiped from recents while CallService keeps the process alive.
 */
@SuppressLint("StaticFieldLeak") // holds the application context while no activity is attached
object WebViewHolder {
    var webView: WebView? = null
        private set
    private var wrapper: MutableContextWrapper? = null

    /** The visible activity, if any (permission prompts, file picker, custom tabs need it). */
    var activity: MainActivity? = null
        private set

    /** The page reports it's in a call (see Bridge.callState). */
    @Volatile
    var inCall = false
        private set

    /** Current page URL; the JavaScript bridge only answers our own site. */
    @Volatile
    var pageUrl: String? = null
        private set

    /** The first page has been shown (the splash screen can go). */
    var firstPageShown = false
        private set

    /** Title and kind of the current call, for the ongoing-call notification. */
    private var callTitle = ""
    private var callVideo = false

    fun obtain(activity: MainActivity): WebView {
        this.activity = activity
        webView?.let { existing ->
            wrapper?.baseContext = activity
            (existing.parent as? ViewGroup)?.removeView(existing)
            return existing
        }
        val context = MutableContextWrapper(activity)
        val view = WebView(context)
        configure(view, activity.applicationContext)
        wrapper = context
        webView = view
        return view
    }

    /** The activity is going away: keep the page while in a call, otherwise free it. */
    fun release(activity: MainActivity) {
        if (this.activity !== activity) return
        this.activity = null
        webView?.let { (it.parent as? ViewGroup)?.removeView(it) }
        wrapper?.baseContext = activity.applicationContext
        if (!inCall) destroy()
    }

    fun destroy() {
        webView?.apply {
            stopLoading()
            destroy()
        }
        webView = null
        wrapper = null
        firstPageShown = false
        pageUrl = null
    }

    fun load(url: String) {
        webView?.loadUrl(Site.url(url))
    }

    /** The page is the signed-in app (it handles commands such as answer). */
    fun onAppPage(): Boolean = Site.isOwn(pageUrl) && Uri.parse(pageUrl).path == "/app"

    /**
     * Calls `window.call9meNative.<name>(…args)` in the page (see src/client/lib/nativeApp.ts).
     * Strings are quoted; booleans and numbers go as they are. @return false without a page.
     */
    fun command(name: String, vararg args: Any): Boolean {
        val view = webView ?: return false
        val list = args.joinToString(",") { if (it is String) JSONObject.quote(it) else it.toString() }
        view.evaluateJavascript(
            "window.call9meNative&&window.call9meNative.$name&&window.call9meNative.$name($list)",
            null,
        )
        return true
    }

    /** The page's call state changed (JSON from the page: state, video, peers, roomId). */
    fun onCallState(context: Context, json: String) {
        val info = try {
            JSONObject(json)
        } catch (e: Exception) {
            return
        }
        val nowInCall = info.optString("state") == "in-call"
        inCall = nowInCall
        if (nowInCall) {
            val room = if (info.isNull("roomId")) "" else info.optString("roomId")
            val peers = info.optJSONArray("peers")
            val names = (0 until (peers?.length() ?: 0)).map { peers!!.optString(it) }.filter { it.isNotEmpty() }
            callTitle = when {
                room.isNotEmpty() -> "Call room #$room"
                names.isNotEmpty() -> names.joinToString(", ")
                else -> context.getString(R.string.ongoingCall)
            }
            callVideo = info.optBoolean("video")
            CallService.start(context, callTitle, callVideo)
        } else {
            CallService.stop(context)
        }
        activity?.onCallStateChanged(nowInCall)
        // The call ended after the app was swiped away: nothing is left to show.
        if (!nowInCall && activity == null) destroy()
    }

    /** Permissions for the call were just granted: the background-call service can start now. */
    fun retryCallService(context: Context) {
        if (inCall) CallService.start(context, callTitle, callVideo)
    }

    @SuppressLint("SetJavaScriptEnabled", "JavascriptInterface")
    private fun configure(view: WebView, appContext: Context) {
        view.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            // Call audio/video and the ringtone play without a tap first.
            mediaPlaybackRequiresUserGesture = false
            setSupportZoom(false)
            builtInZoomControls = false
            displayZoomControls = false
            allowFileAccess = false
            allowContentAccess = false
            mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
            setSupportMultipleWindows(false)
            userAgentString = "$userAgentString ${Site.userAgentTag}"
        }
        // The page has its own light/dark themes: never let the WebView darken it.
        if (WebViewFeature.isFeatureSupported(WebViewFeature.ALGORITHMIC_DARKENING)) {
            WebSettingsCompat.setAlgorithmicDarkeningAllowed(view.settings, false)
        }
        CookieManager.getInstance().apply {
            setAcceptCookie(true)
            setAcceptThirdPartyCookies(view, false)
        }
        view.overScrollMode = View.OVER_SCROLL_NEVER
        view.isVerticalScrollBarEnabled = false
        view.addJavascriptInterface(Bridge(appContext), "Call9meAndroid")
        view.webViewClient = Client()
        view.webChromeClient = Chrome()
        view.setDownloadListener { url, _, _, _, _ -> activity?.openExternal(Uri.parse(url)) }
    }

    private class Client : WebViewClient() {
        override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
            if (!request.isForMainFrame) return false
            val uri = request.url
            if (Site.isOwn(uri)) {
                // Google refuses sign-in inside an app: it continues in a Custom Tab (real browser),
                // which hands the session back to the app at /auth/app.
                if (uri.path?.startsWith("/auth/google/continue") == true) {
                    activity?.openCustomTab(uri)
                    return true
                }
                // The download page and APK make no sense inside the app.
                return uri.path == "/download/android" || uri.path == "/get-app"
            }
            if (uri.scheme == "blob" || uri.scheme == "data" || uri.scheme == "about") return false
            activity?.openExternal(uri)
            return true
        }

        override fun onPageStarted(view: WebView, url: String?, favicon: Bitmap?) {
            pageUrl = url
        }

        override fun onPageFinished(view: WebView, url: String?) {
            pageUrl = url
            firstPageShown = true
            activity?.onPageShown()
            CookieManager.getInstance().flush()
        }

        override fun onReceivedError(view: WebView, request: WebResourceRequest, error: WebResourceError) {
            if (request.isForMainFrame) activity?.showOffline()
        }

        override fun onRenderProcessGone(view: WebView, detail: RenderProcessGoneDetail): Boolean {
            // The page's process crashed or was killed: start over instead of crashing the app.
            val current = activity
            if (webView === view) {
                (view.parent as? ViewGroup)?.removeView(view)
                view.destroy()
                webView = null
                wrapper = null
                firstPageShown = false
                inCall = false
            }
            current?.recreateWebView()
            return true
        }
    }

    private class Chrome : WebChromeClient() {
        override fun onPermissionRequest(request: PermissionRequest) {
            if (!Site.isOwn(request.origin)) {
                request.deny()
                return
            }
            val current = activity
            if (current != null) current.requestWebPermissions(request) else request.deny()
        }

        override fun onShowFileChooser(
            webView: WebView,
            filePathCallback: ValueCallback<Array<Uri>>,
            fileChooserParams: FileChooserParams,
        ): Boolean = activity?.openFileChooser(filePathCallback, fileChooserParams) ?: false
    }
}

/**
 * `window.Call9meAndroid` in the page (src/client/lib/nativeApp.ts). Called on a WebView
 * thread; anything touching UI moves to the main thread. Only our own site may use it.
 */
class Bridge(private val context: Context) {
    private val main = Handler(Looper.getMainLooper())

    private fun trusted() = Site.isOwn(WebViewHolder.pageUrl)

    @JavascriptInterface
    fun pushStatus(): String = if (trusted()) Push.status(context) else "unsupported"

    @JavascriptInterface
    fun pushToken(): String = if (trusted()) Prefs.fcmToken(context) else ""

    @JavascriptInterface
    fun enablePush() {
        if (!trusted()) return
        main.post {
            val activity = WebViewHolder.activity
            if (activity != null) activity.enablePush() else WebViewHolder.command("pushResult", Push.status(context), "")
        }
    }

    @JavascriptInterface
    fun disablePush() {
        if (trusted()) Prefs.setPushOff(context, true)
    }

    @JavascriptInterface
    fun callState(json: String) {
        if (trusted()) main.post { WebViewHolder.onCallState(context, json) }
    }

    @JavascriptInterface
    fun setTheme(dark: Boolean) {
        if (trusted()) main.post { WebViewHolder.activity?.applyTheme(dark) }
    }
}
