package com.call9me.app

import android.Manifest
import android.app.NotificationManager
import android.content.ActivityNotFoundException
import android.content.Intent
import android.content.pm.PackageManager
import android.content.res.Configuration
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.provider.Settings
import android.view.View
import android.view.ViewGroup
import android.view.WindowManager
import android.webkit.CookieManager
import android.webkit.PermissionRequest
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.widget.FrameLayout
import android.widget.Toast
import androidx.activity.OnBackPressedCallback
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.browser.customtabs.CustomTabColorSchemeParams
import androidx.browser.customtabs.CustomTabsIntent
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat
import androidx.core.splashscreen.SplashScreen.Companion.installSplashScreen
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat

/**
 * The app's screen: the Call9me site, edge to edge under native system bars that follow the
 * page's light/dark theme. Handles the call screen's Answer, links and notification taps,
 * camera/microphone/notification permissions, the file picker and the back button.
 */
class MainActivity : AppCompatActivity() {
    companion object {
        const val ACTION_ANSWER = "com.call9me.app.ANSWER"
        const val ACTION_OPEN_URL = "com.call9me.app.OPEN_URL"
        const val EXTRA_URL = "url"

        /** In the background (not in a call) this long, the page disconnects: calls then ring natively. */
        private const val QUIET_AFTER_MS = 15_000L
        private const val DARK = 0xFF0B0E1A.toInt()
        private const val LIGHT = 0xFFF3F5FB.toInt()
    }

    private lateinit var root: View
    private lateinit var container: FrameLayout
    private lateinit var offline: View
    private val handler = Handler(Looper.getMainLooper())
    private var keepSplash = true
    private var started = false
    private var dark = false

    private var pendingWebPermission: PermissionRequest? = null
    private var fileCallback: ValueCallback<Array<Uri>>? = null

    private val goQuiet = Runnable {
        if (!WebViewHolder.inCall) {
            WebViewHolder.command("background", true)
            WebViewHolder.webView?.onPause()
        }
    }

    private val callPermissions = registerForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) { result ->
        val request = pendingWebPermission
        pendingWebPermission = null
        if (request != null) grantAllowed(request)
        if (result.values.any { !it }) Toast.makeText(this, R.string.permissionNeeded, Toast.LENGTH_LONG).show()
        WebViewHolder.retryCallService(applicationContext)
    }

    private val notificationPermission = registerForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        if (Build.VERSION.SDK_INT >= 33) {
            Prefs.setNotificationsDenied(
                this,
                !granted && !shouldShowRequestPermissionRationale(Manifest.permission.POST_NOTIFICATIONS),
            )
        }
        afterNotificationPermission(granted)
    }

    private val filePicker = registerForActivityResult(ActivityResultContracts.StartActivityForResult()) { result ->
        fileCallback?.onReceiveValue(WebChromeClient.FileChooserParams.parseResult(result.resultCode, result.data))
        fileCallback = null
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        val splash = installSplashScreen()
        super.onCreate(savedInstanceState)
        splash.setKeepOnScreenCondition { keepSplash }
        handler.postDelayed({ keepSplash = false }, 4_000)

        WindowCompat.setDecorFitsSystemWindows(window, false)
        setContentView(R.layout.activity_main)
        root = findViewById(R.id.root)
        container = findViewById(R.id.webContainer)
        offline = findViewById(R.id.offline)
        findViewById<View>(R.id.retry).setOnClickListener {
            offline.visibility = View.GONE
            WebViewHolder.webView?.reload()
        }
        // The page sits between the status bar, the navigation bar and the keyboard.
        ViewCompat.setOnApplyWindowInsetsListener(root) { _, insets ->
            val bars = insets.getInsets(
                WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout() or WindowInsetsCompat.Type.ime(),
            )
            container.setPadding(bars.left, bars.top, bars.right, bars.bottom)
            offline.setPadding(bars.left, bars.top, bars.right, bars.bottom)
            insets
        }
        applyTheme(systemDark())

        attachWebView()
        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                val webView = WebViewHolder.webView
                if (webView != null && webView.canGoBack()) webView.goBack() else moveTaskToBack(true)
            }
        })

        if (!handleIntent(intent) && WebViewHolder.webView?.url == null) WebViewHolder.load("/")
        if (WebViewHolder.inCall) onCallStateChanged(true)
    }

    private fun attachWebView() {
        val webView = WebViewHolder.obtain(this)
        webView.setBackgroundColor(if (dark) DARK else LIGHT)
        container.addView(webView, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
        if (WebViewHolder.firstPageShown) keepSplash = false
    }

    /** The page's process died: a fresh page (the call, if any, is lost). */
    fun recreateWebView() {
        CallService.stop(this)
        attachWebView()
        WebViewHolder.load("/app")
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        handleIntent(intent)
    }

    /** @return whether the intent chose what to show. */
    private fun handleIntent(intent: Intent?): Boolean {
        when (intent?.action) {
            ACTION_ANSWER -> {
                val callId = intent.getStringExtra(CallActionReceiver.EXTRA_CALL_ID) ?: return false
                Notifications.stopRinging(this, callId)
                showOverLockScreen(true)
                // A running app page answers itself; otherwise open it on that call.
                if (WebViewHolder.onAppPage()) WebViewHolder.command("answer", callId)
                else WebViewHolder.load("/app?answer=$callId")
                return true
            }
            ACTION_OPEN_URL -> {
                val url = intent.getStringExtra(EXTRA_URL) ?: return false
                if (!url.startsWith("/") && !Site.isOwn(url)) return false
                WebViewHolder.load(url)
                return true
            }
            Intent.ACTION_VIEW -> {
                val data = intent.data
                if (!Site.isOwn(data)) return false
                WebViewHolder.load(data.toString())
                return true
            }
        }
        return false
    }

    override fun onStart() {
        super.onStart()
        started = true
        handler.removeCallbacks(goQuiet)
        WebViewHolder.webView?.onResume()
        WebViewHolder.command("background", false)
    }

    override fun onStop() {
        started = false
        CookieManager.getInstance().flush()
        if (!isChangingConfigurations && !WebViewHolder.inCall) handler.postDelayed(goQuiet, QUIET_AFTER_MS)
        super.onStop()
    }

    override fun onDestroy() {
        handler.removeCallbacksAndMessages(null)
        pendingWebPermission?.deny()
        pendingWebPermission = null
        fileCallback?.onReceiveValue(null)
        fileCallback = null
        if (!isChangingConfigurations) WebViewHolder.release(this)
        super.onDestroy()
    }

    // ---- Calls ----

    fun onCallStateChanged(inCall: Boolean) {
        showOverLockScreen(inCall)
        if (inCall) window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        else window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        // The call ended while the app was in the background: go quiet as usual.
        if (!inCall && !started) {
            handler.removeCallbacks(goQuiet)
            handler.postDelayed(goQuiet, QUIET_AFTER_MS)
        }
    }

    /** Answering from the lock screen shows the call without unlocking; only during calls. */
    private fun showOverLockScreen(on: Boolean) {
        if (Build.VERSION.SDK_INT >= 27) {
            setShowWhenLocked(on)
            setTurnScreenOn(on)
        } else {
            @Suppress("DEPRECATION")
            val flags = WindowManager.LayoutParams.FLAG_SHOW_WHEN_LOCKED or WindowManager.LayoutParams.FLAG_TURN_SCREEN_ON
            if (on) window.addFlags(flags) else window.clearFlags(flags)
        }
    }

    // ---- Page events ----

    fun onPageShown() {
        keepSplash = false
        offline.visibility = View.GONE
    }

    fun showOffline() {
        keepSplash = false
        offline.visibility = View.VISIBLE
    }

    /** Status and navigation bars match the page's light or dark theme. */
    fun applyTheme(dark: Boolean) {
        this.dark = dark
        val color = if (dark) DARK else LIGHT
        root.setBackgroundColor(color)
        offline.setBackgroundColor(color)
        WebViewHolder.webView?.setBackgroundColor(color)
        WindowInsetsControllerCompat(window, root).apply {
            isAppearanceLightStatusBars = !dark
            isAppearanceLightNavigationBars = !dark
        }
    }

    private fun systemDark(): Boolean =
        (resources.configuration.uiMode and Configuration.UI_MODE_NIGHT_MASK) == Configuration.UI_MODE_NIGHT_YES

    // ---- Camera and microphone for the page ----

    private fun androidPermissionFor(resource: String): String? = when (resource) {
        PermissionRequest.RESOURCE_VIDEO_CAPTURE -> Manifest.permission.CAMERA
        PermissionRequest.RESOURCE_AUDIO_CAPTURE -> Manifest.permission.RECORD_AUDIO
        else -> null
    }

    private fun granted(permission: String) =
        ContextCompat.checkSelfPermission(this, permission) == PackageManager.PERMISSION_GRANTED

    fun requestWebPermissions(request: PermissionRequest) {
        val missing = request.resources.mapNotNull { androidPermissionFor(it) }.filter { !granted(it) }.distinct()
        if (missing.isEmpty()) {
            grantAllowed(request)
            return
        }
        pendingWebPermission?.deny()
        pendingWebPermission = request
        callPermissions.launch(missing.toTypedArray())
    }

    private fun grantAllowed(request: PermissionRequest) {
        val allowed = request.resources.filter { resource -> androidPermissionFor(resource)?.let { granted(it) } ?: false }
        if (allowed.isEmpty()) request.deny() else request.grant(allowed.toTypedArray())
    }

    fun openFileChooser(callback: ValueCallback<Array<Uri>>, params: WebChromeClient.FileChooserParams): Boolean {
        fileCallback?.onReceiveValue(null)
        fileCallback = callback
        return try {
            filePicker.launch(params.createIntent())
            true
        } catch (e: ActivityNotFoundException) {
            fileCallback = null
            false
        }
    }

    // ---- Notifications (the page's bell) ----

    fun enablePush() {
        if (!Push.available(this)) {
            WebViewHolder.command("pushResult", Push.status(this), "")
            return
        }
        if (Build.VERSION.SDK_INT >= 33 && !Push.permissionGranted(this)) {
            notificationPermission.launch(Manifest.permission.POST_NOTIFICATIONS)
        } else {
            afterNotificationPermission(true)
        }
    }

    private fun afterNotificationPermission(granted: Boolean) {
        if (!granted) {
            WebViewHolder.command("pushResult", Push.status(this), "")
            return
        }
        if (!NotificationManagerCompat.from(this).areNotificationsEnabled()) {
            openSettings(Settings.ACTION_APP_NOTIFICATION_SETTINGS)
            WebViewHolder.command("pushResult", "denied", "")
            return
        }
        Prefs.setPushOff(this, false)
        // Android 14+: the full-screen call screen needs this permission (off for some phones).
        if (Build.VERSION.SDK_INT >= 34 && !getSystemService(NotificationManager::class.java).canUseFullScreenIntent()) {
            openSettings(Settings.ACTION_MANAGE_APP_USE_FULL_SCREEN_INTENT)
        }
        Push.fetchToken(this) { token ->
            WebViewHolder.command("pushResult", if (token.isEmpty()) "unsupported" else Push.status(this), token)
        }
    }

    private fun openSettings(action: String) {
        val intent = Intent(action)
            .putExtra(Settings.EXTRA_APP_PACKAGE, packageName)
            .setData(Uri.fromParts("package", packageName, null))
        try {
            startActivity(intent)
        } catch (e: ActivityNotFoundException) {
            startActivity(Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.fromParts("package", packageName, null)))
        }
    }

    // ---- Links that leave the app ----

    /** Google sign-in: in a Custom Tab (Google blocks sign-in inside apps' WebViews). */
    fun openCustomTab(uri: Uri) {
        val colors = CustomTabColorSchemeParams.Builder().setToolbarColor(if (dark) DARK else LIGHT).build()
        try {
            CustomTabsIntent.Builder().setDefaultColorSchemeParams(colors).setShowTitle(true).build().launchUrl(this, uri)
        } catch (e: ActivityNotFoundException) {
            openExternal(uri)
        }
    }

    /** Other sites, mail, phone numbers and app links open in their own apps. */
    fun openExternal(uri: Uri) {
        val intent = if (uri.scheme == "intent") {
            try {
                Intent.parseUri(uri.toString(), Intent.URI_INTENT_SCHEME).apply {
                    // Never let a page start a specific (possibly private) component.
                    component = null
                    selector = null
                    addCategory(Intent.CATEGORY_BROWSABLE)
                }
            } catch (e: Exception) {
                return
            }
        } else {
            Intent(Intent.ACTION_VIEW, uri).addCategory(Intent.CATEGORY_BROWSABLE)
        }
        try {
            startActivity(intent)
        } catch (e: ActivityNotFoundException) {
            // Nothing can open it.
        }
    }
}
