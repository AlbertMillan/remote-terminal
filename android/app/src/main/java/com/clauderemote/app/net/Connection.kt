package com.clauderemote.app.net

import com.clauderemote.app.protocol.AuthSuccessPayload
import com.clauderemote.app.protocol.ClientType
import com.clauderemote.app.protocol.Envelope
import com.clauderemote.app.protocol.MessagePayload
import com.clauderemote.app.protocol.Protocol
import com.clauderemote.app.protocol.ServerType
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.withTimeoutOrNull
import kotlinx.serialization.json.JsonElement
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener

/**
 * The app's one WebSocket to the server's /ws.
 *
 * Every callback, listener and state change runs on [scope]'s dispatcher (the main thread in
 * the app), in the order the socket delivered them: the terminal emulator and Compose state
 * are both main-thread only, and terminal output must never be reordered or dropped.
 *
 * Recovery is the point (a phone sleeps, changes network, loses the tailnet): a dropped
 * socket retries with backoff for ever, [reconnectNow] skips the wait when the network comes
 * back, and [verify] pings a socket that only *looks* open after the screen was off, so a
 * dead one is replaced in seconds rather than at OkHttp's next ping timeout.
 */
class Connection(
    private val http: OkHttpClient,
    private val scope: CoroutineScope,
    private val retryDelaysMs: List<Long> = listOf(500, 1_000, 2_000, 4_000, 8_000, 15_000),
) {
    sealed interface State {
        data object Idle : State
        data class Connecting(val attempt: Int) : State
        data class Connected(val user: AuthSuccessPayload) : State
        /** Not connected; the next attempt is at [retryAtMs] (System.currentTimeMillis). */
        data class Waiting(val reason: String, val retryAtMs: Long) : State
    }

    private val _state = MutableStateFlow<State>(State.Idle)
    val state: StateFlow<State> = _state.asStateFlow()

    private val listeners = mutableListOf<(Envelope) -> Unit>()
    private val pending = HashMap<String, CompletableDeferred<Envelope?>>()
    private var socket: WebSocket? = null
    private var generation = 0
    private var url: String? = null
    private var attempt = 0
    private var retryJob: Job? = null
    private var nextId = 0L

    val isConnected: Boolean get() = _state.value is State.Connected

    /** Listen to every message; returns the unsubscribe. Called on [scope]'s dispatcher. */
    fun addListener(listener: (Envelope) -> Unit): () -> Unit {
        listeners += listener
        return { listeners -= listener }
    }

    fun connect(url: String) {
        this.url = url
        attempt = 0
        open()
    }

    fun disconnect() {
        url = null
        retryJob?.cancel()
        closeSocket("disconnect")
        _state.value = State.Idle
    }

    /** The network came back or the app returned: retry now instead of after the backoff. */
    fun reconnectNow() {
        if (url == null) return
        when (_state.value) {
            is State.Connected -> scope.launch { verify() }
            is State.Connecting -> Unit
            else -> {
                attempt = 0
                open()
            }
        }
    }

    /**
     * Ping the server; replace the socket when no pong comes back in [timeoutMs]. After the
     * screen was off the socket can look open while the tailnet path under it is gone.
     */
    suspend fun verify(timeoutMs: Long = 3_000): Boolean {
        if (!isConnected) return false
        val pong = request(ClientType.PING, null, timeoutMs)
        if (pong != null) return true
        if (url != null) {
            closeSocket("ping timeout")
            attempt = 0
            open()
        }
        return false
    }

    /** Send a message; returns its id, or null when there is no open socket. */
    fun send(type: String, payload: JsonElement? = null): String? {
        val ws = socket ?: return null
        val id = (++nextId).toString()
        val text = Protocol.json.encodeToString(Envelope.serializer(), Envelope(type, id, payload))
        return if (ws.send(text)) id else null
    }

    /** Send and await the reply carrying the same id; null on timeout or a dropped socket. */
    suspend fun request(type: String, payload: JsonElement? = null, timeoutMs: Long = 10_000): Envelope? {
        val id = send(type, payload) ?: return null
        val reply = CompletableDeferred<Envelope?>()
        pending[id] = reply
        return try {
            withTimeoutOrNull(timeoutMs) { reply.await() }
        } finally {
            pending.remove(id)
        }
    }

    private fun open() {
        val target = url ?: return
        retryJob?.cancel()
        closeSocket("reopen")
        val gen = ++generation
        attempt++
        _state.value = State.Connecting(attempt)
        val request = Request.Builder().url(target).build()
        socket = http.newWebSocket(request, object : WebSocketListener() {
            override fun onMessage(webSocket: WebSocket, text: String) {
                scope.launch { if (gen == generation) handle(text) }
            }

            override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
                webSocket.close(1000, null)
            }

            override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
                scope.launch { if (gen == generation) dropped(if (code == 4001) "Unauthorized" else "Disconnected") }
            }

            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                val why = when {
                    response?.code == 403 -> "Refused (403)"
                    else -> t.message ?: t.javaClass.simpleName
                }
                scope.launch { if (gen == generation) dropped(why) }
            }
        })
    }

    private fun handle(text: String) {
        val envelope = try {
            Protocol.json.decodeFromString(Envelope.serializer(), text)
        } catch (_: Exception) {
            return
        }
        when (envelope.type) {
            ServerType.AUTH_SUCCESS -> {
                val user = Protocol.decode<AuthSuccessPayload>(envelope.payload)
                    ?: AuthSuccessPayload("", "", "")
                attempt = 0
                _state.value = State.Connected(user)
            }
            ServerType.AUTH_FAILURE -> {
                val why = Protocol.decode<MessagePayload>(envelope.payload)?.message ?: "Unauthorized"
                closeSocket(why)
                dropped("Not authorized: $why")
            }
        }
        envelope.id?.let { pending.remove(it)?.complete(envelope) }
        for (listener in listeners.toList()) listener(envelope)
    }

    private fun dropped(reason: String) {
        socket = null
        generation++
        for (reply in pending.values) reply.complete(null)
        pending.clear()
        if (url == null) {
            _state.value = State.Idle
            return
        }
        val wait = retryDelaysMs[(attempt - 1).coerceIn(0, retryDelaysMs.lastIndex)]
        _state.value = State.Waiting(reason, System.currentTimeMillis() + wait)
        retryJob?.cancel()
        retryJob = scope.launch {
            delay(wait)
            open()
        }
    }

    private fun closeSocket(reason: String) {
        val ws = socket ?: return
        socket = null
        generation++
        ws.close(1000, reason.take(100))
        for (reply in pending.values) reply.complete(null)
        pending.clear()
    }
}
