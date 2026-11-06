package com.clauderemote.app.net

import com.clauderemote.app.protocol.Protocol
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.JsonPrimitive
import okhttp3.Call
import okhttp3.Callback
import okhttp3.HttpUrl
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import java.io.IOException
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException

/** A non-2xx answer; [message] is the server's `error`/`message` field when it sent one. */
class ApiException(val status: Int, message: String) : IOException(message)

/**
 * The server's /api routes (the ones the web client uses; the app adds none of its own
 * except push registration). Unauthenticated on the tailnet, like the web client's.
 */
class Api(private val http: OkHttpClient, private val address: () -> ServerAddress?) {
    private val jsonType = "application/json; charset=utf-8".toMediaType()

    suspend fun get(path: String, query: Map<String, String> = emptyMap()): JsonElement =
        call(Request.Builder().url(url(path, query)).get().build())

    suspend fun post(path: String, body: JsonElement = JsonObject(emptyMap())): JsonElement =
        call(Request.Builder().url(url(path)).post(body.toString().toRequestBody(jsonType)).build())

    suspend fun delete(path: String, body: JsonElement = JsonObject(emptyMap())): JsonElement =
        call(Request.Builder().url(url(path)).delete(body.toString().toRequestBody(jsonType)).build())

    private fun url(path: String, query: Map<String, String> = emptyMap()): HttpUrl {
        val base = address() ?: throw IOException("No server configured")
        val builder = base.http(path).newBuilder()
        for ((k, v) in query) builder.addQueryParameter(k, v)
        return builder.build()
    }

    private suspend fun call(request: Request): JsonElement = suspendCancellableCoroutine { cont ->
        val call = http.newCall(request)
        cont.invokeOnCancellation { call.cancel() }
        call.enqueue(object : Callback {
            override fun onFailure(call: Call, e: IOException) {
                if (cont.isActive) cont.resumeWithException(e)
            }

            override fun onResponse(call: Call, response: Response) {
                response.use {
                    val text = it.body?.string().orEmpty()
                    val json = try {
                        if (text.isBlank()) JsonNull else Protocol.json.parseToJsonElement(text)
                    } catch (_: Exception) {
                        JsonNull
                    }
                    if (!cont.isActive) return
                    if (it.isSuccessful) {
                        cont.resume(json)
                    } else {
                        val obj = json as? JsonObject
                        val msg = ((obj?.get("error") ?: obj?.get("message")) as? JsonPrimitive)?.contentOrNull
                            ?: "HTTP ${it.code}"
                        cont.resumeWithException(ApiException(it.code, msg))
                    }
                }
            }
        })
    }
}
