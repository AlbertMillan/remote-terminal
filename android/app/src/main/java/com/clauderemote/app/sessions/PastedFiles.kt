package com.clauderemote.app.sessions

import android.content.ContentResolver
import android.net.Uri
import android.provider.OpenableColumns
import com.clauderemote.app.net.Api
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull
import okhttp3.MediaType
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.MediaType.Companion.toMediaTypeOrNull
import okhttp3.RequestBody
import okio.BufferedSink
import okio.source
import java.io.IOException
import java.net.URLEncoder

/**
 * A file (a photo, a PDF, anything) pasted, picked or shared into a session (Paste key,
 * Attach key, share sheet). The file is uploaded (`POST /api/sessions/:id/files?name=`, the
 * server's `sessions/uploads.ts`) and its saved path is pasted, never sent: Claude Code
 * attaches an image path as `[Image #N]` and reads any other file when it needs it.
 */
object PastedFiles {
    /** The server's upload cap; refused here before the upload rather than after. */
    const val MAX_BYTES = 20L * 1024 * 1024

    private val tooLarge get() = IOException("File is larger than ${MAX_BYTES / (1024 * 1024)} MB")

    /**
     * What to paste for a saved file: the path, quoted when it holds a space, and a trailing
     * space so the next word typed does not join it. As the web client's `pastedFilesText`.
     */
    fun pastedText(path: String): String = (if (path.any { it.isWhitespace() }) "\"$path\"" else path) + " "

    /** Several files in one paste: every path's text, in pick order. */
    fun joinPasted(paths: List<String>): String = paths.joinToString("") { pastedText(it) }

    /** The name shown to the user for [uri], or "file" when the provider gives none. */
    // On IO, as [body]: a cloud provider (Drive, OneDrive) can answer the query slowly, which
    // on the main thread would freeze the screen.
    suspend fun displayName(resolver: ContentResolver, uri: Uri): String = withContext(Dispatchers.IO) {
        val name = try {
            resolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)?.use { c ->
                if (c.moveToFirst() && !c.isNull(0)) c.getString(0) else null
            }
        } catch (_: Exception) {
            null
        }
        name?.takeIf { it.isNotBlank() } ?: "file"
    }

    /**
     * The upload body for [uri], streamed from the provider as OkHttp sends it, so the file is
     * never held in memory whole. Refuses up front when the provider states a size past
     * [MAX_BYTES], and mid-stream when it states none.
     */
    suspend fun body(resolver: ContentResolver, uri: Uri): RequestBody = withContext(Dispatchers.IO) {
        val size = resolver.query(uri, arrayOf(OpenableColumns.SIZE), null, null, null)?.use { c ->
            if (c.moveToFirst() && !c.isNull(0)) c.getLong(0) else null
        }
        if (size != null && size > MAX_BYTES) throw tooLarge
        val type = resolver.getType(uri)?.takeIf { it.isNotBlank() } ?: "application/octet-stream"
        StreamedBody(type.toMediaTypeOrNull() ?: "application/octet-stream".toMediaType()) {
            resolver.openInputStream(uri) ?: throw IOException("Can't read that file")
        }
    }

    /** Uploads [body] as [name] to [sessionId]; returns the text to paste. */
    suspend fun upload(api: Api, sessionId: String, name: String, body: RequestBody): String {
        // Ids are server-generated UUIDs; anything else must not reach the URL path.
        if (!Regex("^[\\w-]+$").matches(sessionId)) throw IOException("Unknown session")
        return pastedText(pathFrom(api.postBody("/api/sessions/$sessionId/files?name=${URLEncoder.encode(name, "UTF-8").replace("+", "%20")}", body)))
    }

    /** The server's `{ path }`; throws when the answer carries none. */
    fun pathFrom(answer: JsonElement): String =
        ((answer as? JsonObject)?.get("path") as? JsonPrimitive)?.contentOrNull?.takeIf { it.isNotBlank() }
            ?: throw IOException("The server saved no file")

    /** What a share intent carries: a plain-text share (a link, a note) or the files in it. */
    sealed interface Share<out T> {
        data object Text : Share<Nothing>
        data class Files<T>(val streams: List<T>) : Share<T>
    }

    /**
     * How MainActivity reads a share, from the intent's [action], [type], whether it has
     * EXTRA_TEXT ([hasText]) and its EXTRA_STREAM uris ([streams]). A text/plain share with
     * text is text (a browser sends a link as text and sometimes a thumbnail too); otherwise
     * the streams are files. Null when it carries nothing usable. Pure, so it needs no Intent.
     */
    fun <T> parseShare(action: String?, type: String?, hasText: Boolean, streams: List<T>): Share<T>? = when (action) {
        "android.intent.action.SEND" -> when {
            type?.startsWith("text/plain") == true && hasText -> Share.Text
            streams.isNotEmpty() -> Share.Files(streams.take(1))
            hasText -> Share.Text
            else -> null
        }
        "android.intent.action.SEND_MULTIPLE" -> if (streams.isNotEmpty()) Share.Files(streams) else null
        else -> null
    }

    /**
     * A body read from [open] on every send (OkHttp may resend after a failed connection),
     * with no stated length: the provider's size can be wrong or missing.
     */
    private class StreamedBody(private val type: MediaType, private val open: () -> java.io.InputStream) : RequestBody() {
        override fun contentType(): MediaType = type

        override fun writeTo(sink: BufferedSink) {
            open().source().use { source ->
                var total = 0L
                while (true) {
                    val n = source.read(sink.buffer, 64L * 1024)
                    if (n < 0) break
                    total += n
                    if (total > MAX_BYTES) throw tooLarge
                    sink.emitCompleteSegments()
                }
            }
        }
    }
}
