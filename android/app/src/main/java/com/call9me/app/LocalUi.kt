package com.call9me.app

import android.content.Context
import android.net.Uri
import android.os.Handler
import android.os.Looper
import android.webkit.CookieManager
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import java.io.ByteArrayInputStream
import java.io.File
import java.io.InputStream
import java.net.HttpURLConnection
import java.net.URL
import java.security.MessageDigest
import java.util.concurrent.Executors
import java.util.concurrent.Future
import java.util.concurrent.TimeUnit

/**
 * Shows the site's UI from the phone instead of waiting for the network, so opening the app
 * never sits on a blank screen:
 *
 * - **Front end** (`/css/…`, `/js/…`): shipped inside the APK (`assets/web/`, copied by
 *   `npm run android:build`) and kept on disk. A URL's `?v=<build>` must match, so a newer
 *   deploy is fetched once from the server, stored, and then served locally too.
 * - **Fonts** (Google Fonts): stored on disk after the first load.
 * - **The app page** (`/app`): the last copy the server sent for *this* session cookie shows
 *   at once, and a fresh copy is fetched in the background for next time (which also refreshes
 *   the session cookie, as loading `/app` does). A different or missing session never sees it.
 *
 * Everything else (the API, the socket, pictures, other pages) goes to the server as before.
 * Called on WebView background threads.
 */
object LocalUi {
    private const val SESSION_COOKIE = "c9m_sid"
    private const val SHELL_PATH = "/app"
    private const val FONT_REFRESH_MS = 7L * 24 * 3600 * 1000
    /** A reload right after a cached page waits this long for the fresh copy. */
    private const val SHELL_WAIT_S = 3L

    private lateinit var appContext: Context
    private lateinit var dir: File
    private val io = Executors.newFixedThreadPool(2)
    private val lock = Any()

    /** The WebView's user agent (with the app tag), so the server answers as it does for the page. */
    @Volatile
    var userAgent: String = Site.userAgentTag

    /** The front-end build shipped in the APK (assets/web/version.txt); "" if none. */
    private val bundledVersion: String by lazy {
        try {
            appContext.assets.open("web/version.txt").bufferedReader().use { it.readText().trim() }
        } catch (e: Exception) {
            ""
        }
    }

    /** The background refresh of the app page, if one is running. */
    @Volatile
    private var shellRefresh: Future<*>? = null

    fun init(context: Context) {
        appContext = context.applicationContext
        dir = File(appContext.noBackupFilesDir, "localui").apply { mkdirs() }
    }

    /**
     * The site's cookies, read on the main thread. CookieManager must never be called from
     * shouldInterceptRequest: it can wait on the very network stack that is waiting for us,
     * and the page then never loads (a white screen, then "app isn't responding").
     */
    @Volatile
    private var cookieHeader: String? = null
    private val main = Handler(Looper.getMainLooper())

    /** Main thread: takes a fresh copy of the site's cookies (after each page load, and at start). */
    fun snapshotCookies() {
        cookieHeader = try {
            CookieManager.getInstance().getCookie(Site.base)
        } catch (e: Exception) {
            null
        }
    }

    /** Main thread: a page finished loading. The app page from the server (e.g. just after sign-in) is kept for next time. */
    fun onPageLoaded(url: String?) {
        snapshotCookies()
        if (!::dir.isInitialized || !Site.isOwn(url) || Uri.parse(url).path != SHELL_PATH) return
        val sid = sessionId() ?: return
        if (!hasShell(sid)) refreshShell()
    }

    private fun hasShell(sid: String): Boolean =
        synchronized(lock) { shellFile.exists() && shellKeyFile.exists() && shellKeyFile.readText() == sha1(sid) }

    /** Where the app starts: straight on the app page when it can show at once, else the site's start. Main thread. */
    fun startPath(): String {
        if (!::dir.isInitialized) return "/"
        snapshotCookies()
        val sid = sessionId() ?: return "/"
        return if (hasShell(sid)) SHELL_PATH else "/"
    }

    /** WebViewClient / ServiceWorkerClient hook: a local response, or null to use the network. */
    fun intercept(request: WebResourceRequest, mainFrame: Boolean): WebResourceResponse? {
        if (!::dir.isInitialized || request.method != "GET") return null
        val uri = request.url
        return try {
            when {
                Site.isOwn(uri) && mainFrame && uri.path == SHELL_PATH -> shell()
                Site.isOwn(uri) && isFrontEnd(uri.path) -> frontEnd(uri)
                uri.scheme == "https" && (uri.host == "fonts.googleapis.com" || uri.host == "fonts.gstatic.com") -> font(uri)
                else -> null
            }
        } catch (e: Exception) {
            null // anything unexpected: the network, as before
        }
    }

    // ---- The app page ----

    private fun sessionId(): String? {
        val cookies = cookieHeader ?: return null
        return cookies.split(';').map { it.trim() }
            .firstOrNull { it.startsWith("$SESSION_COOKIE=") }
            ?.substringAfter('=')
            ?.takeIf { it.isNotEmpty() }
    }

    private val shellFile get() = File(dir, "app.html")
    private val shellKeyFile get() = File(dir, "app.key")

    /** The stored app page, if it belongs to the current session. */
    private fun cachedShell(): ByteArray? {
        val sid = sessionId() ?: return null
        synchronized(lock) {
            if (!shellFile.exists() || !shellKeyFile.exists()) return null
            if (shellKeyFile.readText() != sha1(sid)) return null
            return shellFile.readBytes()
        }
    }

    private fun shell(): WebResourceResponse? {
        // A reload just after a cached page (e.g. "Update"): wait for the fresh copy.
        shellRefresh?.let { running ->
            try {
                running.get(SHELL_WAIT_S, TimeUnit.SECONDS)
            } catch (e: Exception) {
                // Too slow or failed: decide with what's there.
            }
        }
        val cached = cachedShell()
        refreshShell()
        if (cached == null) return null // first time with this session: the server shows it
        return html(cached)
    }

    /** Fetches the app page as the page itself would, keeping it for next time. */
    private fun refreshShell() {
        val sid = sessionId() ?: return
        synchronized(lock) {
            if (shellRefresh?.isDone == false) return
            shellRefresh = io.submit(Runnable { fetchShell(sid) })
        }
    }

    private fun fetchShell(sid: String) {
        val cookie = cookieHeader ?: return
        val conn = URL(Site.url(SHELL_PATH)).openConnection() as HttpURLConnection
        try {
            conn.instanceFollowRedirects = false
            conn.connectTimeout = 10_000
            conn.readTimeout = 15_000
            conn.setRequestProperty("Cookie", cookie)
            conn.setRequestProperty("User-Agent", userAgent)
            conn.setRequestProperty("Accept", "text/html")
            val code = conn.responseCode
            // The server refreshes the session cookie on the app page; keep that (on the main thread).
            val setCookies = conn.headerFields.entries
                .filter { it.key.equals("Set-Cookie", ignoreCase = true) }
                .flatMap { it.value }
            if (setCookies.isNotEmpty()) {
                main.post {
                    try {
                        val cookies = CookieManager.getInstance()
                        setCookies.forEach { cookies.setCookie(Site.base, it) }
                        cookies.flush()
                    } catch (e: Exception) {
                        // Keep the old cookie; the page refreshes it too.
                    }
                    snapshotCookies()
                }
            }
            if (code == 200) {
                val body = conn.inputStream.use { it.readBytes() }
                synchronized(lock) {
                    writeAtomically(shellFile, body)
                    shellKeyFile.writeText(sha1(sid))
                }
            } else if (code in 300..399 || code == 401 || code == 403) {
                forgetShell() // signed out, expired or elsewhere: never show the stored page again
            }
        } finally {
            conn.disconnect()
        }
    }

    fun forgetShell() {
        synchronized(lock) {
            shellFile.delete()
            shellKeyFile.delete()
        }
    }

    private fun html(body: ByteArray) = WebResourceResponse(
        "text/html", "utf-8", 200, "OK",
        mapOf("Cache-Control" to "no-store"),
        ByteArrayInputStream(body),
    )

    // ---- Front end: CSS and JavaScript ----

    private fun isFrontEnd(path: String?): Boolean =
        path != null && !path.contains("..") && (path.startsWith("/js/") || path.startsWith("/css/")) &&
            (path.endsWith(".js") || path.endsWith(".css"))

    private fun frontEnd(uri: Uri): WebResourceResponse? {
        val path = uri.path ?: return null
        val version = uri.getQueryParameter("v")
        // Chunk names carry a content hash, so any copy is the right one; other files need the build to match.
        val immutable = path.startsWith("/js/chunks/")
        if (!immutable && version == null) return null
        val mime = if (path.endsWith(".css")) "text/css" else "text/javascript"

        if (immutable || version == bundledVersion) {
            bundled(path)?.let { return stream(mime, it) }
        }
        val key = uri.toString()
        stored(key)?.let { return stream(mime, it.inputStream()) }
        val body = download(key) ?: return null
        store(key, body)
        return stream(mime, ByteArrayInputStream(body))
    }

    private fun bundled(path: String): InputStream? = try {
        appContext.assets.open("web$path")
    } catch (e: Exception) {
        null
    }

    // ---- Fonts ----

    private fun font(uri: Uri): WebResourceResponse? {
        val key = uri.toString()
        val css = uri.host == "fonts.googleapis.com"
        val mime = if (css) "text/css" else when {
            key.contains(".woff2") -> "font/woff2"
            key.contains(".woff") -> "font/woff"
            key.contains(".ttf") -> "font/ttf"
            else -> return null
        }
        val file = stored(key)
        if (file != null) {
            // Font files never change; the stylesheet is checked again once a week.
            if (css && System.currentTimeMillis() - file.lastModified() > FONT_REFRESH_MS) {
                io.execute { download(key)?.let { store(key, it) } }
            }
            return stream(mime, file.inputStream(), cors = true)
        }
        // Not stored yet: never hold the page up on Google. The WebView fetches it as usual
        // (from its own cache when it can), and a copy is kept for next time.
        io.execute { download(key)?.let { store(key, it) } }
        return null
    }

    // ---- Storage ----

    /** One file per path (without the query), so a new build replaces the old copy. */
    private fun entry(key: String): Pair<File, File> {
        val name = sha1(key.substringBefore('?'))
        return File(dir, "$name.bin") to File(dir, "$name.url")
    }

    private fun stored(key: String): File? {
        val (data, url) = entry(key)
        synchronized(lock) {
            return if (data.exists() && url.exists() && url.readText() == key) data else null
        }
    }

    private fun store(key: String, body: ByteArray) {
        val (data, url) = entry(key)
        synchronized(lock) {
            writeAtomically(data, body)
            url.writeText(key)
        }
    }

    private fun download(url: String): ByteArray? {
        val conn = URL(url).openConnection() as HttpURLConnection
        return try {
            conn.connectTimeout = 10_000
            conn.readTimeout = 20_000
            conn.setRequestProperty("User-Agent", userAgent)
            if (conn.responseCode == 200) conn.inputStream.use { it.readBytes() } else null
        } catch (e: Exception) {
            null
        } finally {
            conn.disconnect()
        }
    }

    private fun stream(mime: String, body: InputStream, cors: Boolean = false): WebResourceResponse {
        val headers = mutableMapOf("Cache-Control" to "no-cache")
        if (cors) headers["Access-Control-Allow-Origin"] = "*"
        return WebResourceResponse(mime, "utf-8", 200, "OK", headers, body)
    }

    private fun writeAtomically(target: File, body: ByteArray) {
        val tmp = File(target.parentFile, target.name + ".tmp")
        tmp.writeBytes(body)
        if (!tmp.renameTo(target)) {
            target.delete()
            tmp.renameTo(target)
        }
    }

    private fun sha1(text: String): String =
        MessageDigest.getInstance("SHA-1").digest(text.toByteArray()).joinToString("") { "%02x".format(it) }
}
