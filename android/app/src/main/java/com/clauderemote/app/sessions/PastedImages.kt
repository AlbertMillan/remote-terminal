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
import okhttp3.RequestBody
import okio.BufferedSink
import okio.source
import java.io.IOException

/**
 * An image pasted, picked or shared into a session (Paste key, Image key, share sheet).
 * Claude Code reads images from the clipboard of the PC it runs on, which the phone cannot
 * reach, so the image is uploaded (`POST /api/sessions/:id/images`, the server's
 * `sessions/pasted-images.ts`) and its saved path is pasted: Claude Code attaches a pasted
 * image path as `[Image #N]`.
 */
object PastedImages {
    /** The server's `MAX_IMAGE_BYTES`; refused here before the upload rather than after. */
    const val MAX_BYTES = 20L * 1024 * 1024

    private val tooLarge get() = IOException("Image is larger than ${MAX_BYTES / (1024 * 1024)} MB")

    /**
     * What to paste for a saved image: the path, quoted when it holds a space, and a trailing
     * space so the next word typed does not join it. As the web client's `pastedImageText`.
     */
    fun pastedText(path: String): String = (if (path.any { it.isWhitespace() }) "\"$path\"" else path) + " "

    /**
     * The upload body for [uri], streamed from the provider as OkHttp sends it, so the image is
     * never held in memory whole. Refuses up front when the provider states a size past
     * [MAX_BYTES], and mid-stream when it states none.
     */
    suspend fun body(resolver: ContentResolver, uri: Uri): RequestBody = withContext(Dispatchers.IO) {
        val size = resolver.query(uri, arrayOf(OpenableColumns.SIZE), null, null, null)?.use { c ->
            if (c.moveToFirst() && !c.isNull(0)) c.getLong(0) else null
        }
        if (size != null && size > MAX_BYTES) throw tooLarge
        val type = resolver.getType(uri)?.takeIf { it.startsWith("image/") } ?: "image/png"
        StreamedBody(type.toMediaType()) {
            resolver.openInputStream(uri) ?: throw IOException("Can't read that image")
        }
    }

    /** Uploads [body] to [sessionId]; returns the text to paste. */
    suspend fun upload(api: Api, sessionId: String, body: RequestBody): String {
        // Ids are server-generated UUIDs; anything else must not reach the URL path.
        if (!Regex("^[\\w-]+$").matches(sessionId)) throw IOException("Unknown session")
        return pastedText(pathFrom(api.postBody("/api/sessions/$sessionId/images", body)))
    }

    /** The server's `{ path }`; throws when the answer carries none. */
    fun pathFrom(answer: JsonElement): String =
        ((answer as? JsonObject)?.get("path") as? JsonPrimitive)?.contentOrNull?.takeIf { it.isNotBlank() }
            ?: throw IOException("The server saved no image")

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
