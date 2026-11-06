package com.clauderemote.app.data

import android.content.Context
import com.clauderemote.app.net.ServerAddress
import java.util.UUID

/** The few things the app remembers: the server, this install's id, the last session. */
class Settings(context: Context) {
    private val prefs = context.getSharedPreferences("claude-remote", Context.MODE_PRIVATE)

    var server: ServerAddress?
        get() = prefs.getString(KEY_SERVER, null)?.let { ServerAddress.parse(it) }
        set(value) = prefs.edit().putString(KEY_SERVER, value?.display).apply()

    /** Names this install to the server for push (f-cr85qn); random, never the hardware id. */
    val deviceId: String
        get() = prefs.getString(KEY_DEVICE, null) ?: UUID.randomUUID().toString().also {
            prefs.edit().putString(KEY_DEVICE, it).apply()
        }

    var lastSessionId: String?
        get() = prefs.getString(KEY_LAST_SESSION, null)
        set(value) = prefs.edit().putString(KEY_LAST_SESSION, value).apply()

    var fontSizeSp: Int
        get() = prefs.getInt(KEY_FONT, 12)
        set(value) = prefs.edit().putInt(KEY_FONT, value).apply()

    private companion object {
        const val KEY_SERVER = "server"
        const val KEY_DEVICE = "deviceId"
        const val KEY_LAST_SESSION = "lastSession"
        const val KEY_FONT = "fontSizeSp"
    }
}
