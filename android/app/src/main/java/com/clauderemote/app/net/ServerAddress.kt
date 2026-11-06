package com.clauderemote.app.net

import okhttp3.HttpUrl
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull

/**
 * The server the user typed once: a MagicDNS name, a tailnet IP, or a full URL. Plain
 * http/ws over the tailnet by design (docs/android-app.md); `https://` is accepted for a
 * server behind `tailscale serve` and maps to wss.
 */
data class ServerAddress(val base: HttpUrl) {
    /** `http://host:port` with no trailing slash, as shown and stored. */
    val display: String get() = "${base.scheme}://${hostPort()}"

    fun http(path: String): HttpUrl = base.resolve(path.removePrefix("/")) ?: base

    /** The /ws endpoint, with `device` naming this install for push (f-cr85qn). */
    fun ws(deviceId: String? = null): String {
        val scheme = if (base.isHttps) "wss" else "ws"
        val query = if (deviceId != null) "?device=$deviceId" else ""
        return "$scheme://${hostPort()}/ws$query"
    }

    private fun hostPort(): String {
        val host = if (base.host.contains(':')) "[${base.host}]" else base.host
        return "$host:${base.port}"
    }

    companion object {
        const val DEFAULT_PORT = 4220

        /** Null when the input is not a usable address. */
        fun parse(input: String): ServerAddress? {
            val text = input.trim().trimEnd('/')
            if (text.isEmpty() || text.any { it.isWhitespace() }) return null
            if (text.endsWith(":") || (text.contains(":/") && !text.contains("://"))) return null
            val withScheme = if (text.contains("://")) text else "http://$text"
            val url = withScheme.toHttpUrlOrNull() ?: return null
            if (url.host.isEmpty()) return null
            // HttpUrl reports 80/443 for a URL with no port; claude-remote listens on 4220.
            val authority = withScheme.substringAfter("://").substringBefore('/')
            val explicitPort = Regex(""":(\d+)$""").containsMatchIn(authority.substringAfterLast(']'))
            val builder = url.newBuilder().encodedPath("/").query(null).fragment(null)
            if (!explicitPort) builder.port(DEFAULT_PORT)
            return ServerAddress(builder.build())
        }
    }
}
