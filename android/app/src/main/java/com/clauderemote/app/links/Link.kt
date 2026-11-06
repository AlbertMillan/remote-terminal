package com.clauderemote.app.links

import java.net.URLDecoder
import java.net.URLEncoder

/**
 * Where a tap leads: a notification, a `claude-remote://` link from elsewhere, or a share.
 *
 *   claude-remote://session/<id>
 *   claude-remote://job/<id>
 *   claude-remote://project?cwd=<url-encoded folder>
 *
 * Parsing never throws; anything unknown is null and the app just opens.
 */
sealed interface Link {
    data class Session(val sessionId: String) : Link
    data class Job(val jobId: String) : Link
    data class Project(val cwd: String) : Link

    fun toUri(): String = when (this) {
        is Session -> "$SCHEME://session/${enc(sessionId)}"
        is Job -> "$SCHEME://job/${enc(jobId)}"
        is Project -> "$SCHEME://project?cwd=${enc(cwd)}"
    }

    companion object {
        const val SCHEME = "claude-remote"

        private val ID = Regex("^[A-Za-z0-9_-]{1,80}$")

        private fun enc(s: String) = URLEncoder.encode(s, "UTF-8").replace("+", "%20")
        private fun dec(s: String) = try { URLDecoder.decode(s.replace("+", "%2B"), "UTF-8") } catch (_: Exception) { null }

        fun parse(uri: String?): Link? {
            if (uri == null || !uri.startsWith("$SCHEME://")) return null
            val rest = uri.removePrefix("$SCHEME://")
            val path = rest.substringBefore('?').trimEnd('/')
            val query = rest.substringAfter('?', "")
            val kind = path.substringBefore('/')
            val arg = path.substringAfter('/', "").let { dec(it) }
            return when (kind) {
                "session" -> arg?.takeIf { ID.matches(it) }?.let { Session(it) }
                "job" -> arg?.takeIf { ID.matches(it) }?.let { Job(it) }
                "project" -> query.split('&')
                    .firstOrNull { it.startsWith("cwd=") }
                    ?.let { dec(it.removePrefix("cwd=")) }
                    ?.takeIf { it.isNotBlank() }
                    ?.let { Project(it) }
                else -> null
            }
        }

        /** The link a push's data names (server: src/server/push/push.ts). */
        fun fromPush(data: Map<String, String>): Link? = when (data["kind"]) {
            "session" -> data["sessionId"]?.let { Session(it) }
            "job" -> data["jobId"]?.let { Job(it) }
            "project" -> data["projectCwd"]?.let { Project(it) }
            else -> null
        }
    }
}
