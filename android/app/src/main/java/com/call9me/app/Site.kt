package com.call9me.app

import android.content.Context
import android.net.Uri
import android.os.Handler
import android.os.Looper
import android.webkit.CookieManager
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.Executors

/** The Call9me site this app opens (set at build time: `npm run android:build -- --host …`). */
object Site {
    val host: String = BuildConfig.SITE_HOST
    val base: String = "https://$host"

    /** Added to the WebView's user agent: the site knows it runs in the app (no "get the app" page). */
    val userAgentTag: String = "Call9meAndroid/${BuildConfig.VERSION_NAME.substringBefore(' ')}"

    fun url(path: String): String = if (path.startsWith("http")) path else base + path

    fun isOwn(uri: Uri?): Boolean = uri != null && uri.scheme == "https" && uri.host.equals(host, ignoreCase = true)

    fun isOwn(url: String?): Boolean = url != null && isOwn(Uri.parse(url))
}

/** Small app settings. */
object Prefs {
    private fun prefs(context: Context) = context.getSharedPreferences("call9me", Context.MODE_PRIVATE)

    fun fcmToken(context: Context): String = prefs(context).getString("fcmToken", "") ?: ""
    fun setFcmToken(context: Context, token: String) = prefs(context).edit().putString("fcmToken", token).apply()

    /** The user turned notifications off in the app (the system permission is left alone). */
    fun pushOff(context: Context): Boolean = prefs(context).getBoolean("pushOff", false)
    fun setPushOff(context: Context, off: Boolean) = prefs(context).edit().putBoolean("pushOff", off).apply()

    /** Notification permission was refused for good ("Don't ask again"): only Settings can change it. */
    fun notificationsDenied(context: Context): Boolean = prefs(context).getBoolean("notifDenied", false)
    fun setNotificationsDenied(context: Context, denied: Boolean) =
        prefs(context).edit().putBoolean("notifDenied", denied).apply()
}

/** Calls the Call9me server as the signed-in user (the WebView's session cookie), off the main thread. */
object ServerApi {
    private val executor = Executors.newSingleThreadExecutor()
    private val main = Handler(Looper.getMainLooper())

    /** Must be called on the main thread (reads the WebView's cookies there). */
    fun post(path: String, body: JSONObject? = null, done: ((Boolean) -> Unit)? = null) {
        val cookie = try {
            CookieManager.getInstance().getCookie(Site.base)
        } catch (e: Exception) {
            null
        }
        executor.execute {
            val ok = try {
                val conn = URL(Site.url(path)).openConnection() as HttpURLConnection
                conn.requestMethod = "POST"
                conn.connectTimeout = 10_000
                conn.readTimeout = 10_000
                conn.setRequestProperty("Content-Type", "application/json")
                conn.setRequestProperty("User-Agent", Site.userAgentTag)
                if (cookie != null) conn.setRequestProperty("Cookie", cookie)
                conn.doOutput = true
                conn.outputStream.use { it.write((body ?: JSONObject()).toString().toByteArray()) }
                val code = conn.responseCode
                conn.disconnect()
                code in 200..299
            } catch (e: Exception) {
                false
            }
            if (done != null) main.post { done(ok) }
        }
    }
}
