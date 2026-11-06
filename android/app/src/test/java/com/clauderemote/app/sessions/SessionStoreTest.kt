package com.clauderemote.app.sessions

import com.clauderemote.app.data.SessionMemory
import com.clauderemote.app.net.Connection
import com.clauderemote.app.protocol.ClientType
import com.clauderemote.app.protocol.Envelope
import com.clauderemote.app.protocol.Protocol
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.asCoroutineDispatcher
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonPrimitive
import okhttp3.OkHttpClient
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import java.util.Collections
import java.util.concurrent.Executors
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.TimeUnit

/**
 * [SessionStore]'s recovery path against a scripted /ws: the open session is re-attached on
 * every connect, and one a server restart parked is stopped and offered for revive, never
 * left typing into a socket that is not attached to it.
 */
class SessionStoreTest {
    private lateinit var server: MockWebServer
    private val executor = Executors.newSingleThreadExecutor()
    private val scope = CoroutineScope(SupervisorJob() + executor.asCoroutineDispatcher())
    private val sockets = LinkedBlockingQueue<WebSocket>()
    private val received: MutableList<Envelope> = Collections.synchronizedList(mutableListOf())

    /** What the fake server says about s1: live before the "restart", parked after it. */
    @Volatile private var s1Live = true

    private val memory = object : SessionMemory {
        override var lastSessionId: String? = "s1"
    }

    private fun session(live: Boolean) = """{"id":"s1","name":"one","shell":"pwsh.exe","cwd":"C:\\p",
        "createdAt":"2026-11-06T10:00:00.000Z","lastAccessedAt":"2026-11-06T10:00:00.000Z",
        "status":"${if (live) "running" else "idle"}","cols":80,"rows":24,"attachable":$live,
        "categoryId":null,"sortOrder":0,"isFork":false,"claudeSessionId":null,"spawnedBy":null,
        "permissionMode":null,"access":null,"claudeName":null,"account":"work","accountWarning":null,
        "revivable":${!live}}""".replace("\n", "").replace("  ", "")

    private fun upgrade() = MockResponse().withWebSocketUpgrade(object : WebSocketListener() {
        override fun onOpen(webSocket: WebSocket, response: Response) {
            sockets += webSocket
            allSockets += webSocket
            webSocket.send("""{"type":"auth.success","payload":{"userId":"u","loginName":"me","displayName":"Me"}}""")
        }

        override fun onMessage(webSocket: WebSocket, text: String) {
            val env = Protocol.json.decodeFromString(Envelope.serializer(), text)
            received += env
            val id = env.id
            when (env.type) {
                ClientType.SESSION_LIST ->
                    webSocket.send("""{"type":"session.list","id":"$id","payload":{"sessions":[${session(s1Live)}]}}""")
                ClientType.SESSION_ATTACH -> webSocket.send(
                    if (s1Live) """{"type":"session.attached","id":"$id","payload":{"session":${session(true)},"scrollback":"hello"}}"""
                    else """{"type":"session.error","id":"$id","payload":{"message":"Session not found"}}""",
                )
                ClientType.SESSION_REVIVE -> {
                    s1Live = true
                    webSocket.send("""{"type":"session.created","id":"$id","payload":{"session":${session(true)}}}""")
                }
            }
        }

        override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
            webSocket.close(1000, null)
        }
    })

    /** Every server-side socket, so teardown can close the ones still open. */
    private val allSockets: MutableList<WebSocket> = Collections.synchronizedList(mutableListOf())

    @Before
    fun setUp() {
        server = MockWebServer()
        repeat(4) { server.enqueue(upgrade()) }
        server.start()
    }

    @After
    fun tearDown() {
        scope.cancel()
        executor.shutdownNow()
        allSockets.toList().forEach { runCatching { it.close(1001, null) } }
        server.shutdown()
    }

    private fun <T> onMain(block: () -> T): T = runBlocking { withContext(scope.coroutineContext) { block() } }

    private fun waitFor(what: String, check: () -> Boolean) {
        val deadline = System.currentTimeMillis() + 5_000
        while (System.currentTimeMillis() < deadline) {
            if (onMain(check)) return
            Thread.sleep(20)
        }
        throw AssertionError("timed out waiting for $what")
    }

    @Test
    fun aSessionParkedByARestartIsStoppedAndRevivedInPlace() {
        val connection = Connection(OkHttpClient(), scope, retryDelaysMs = listOf(50))
        val store = onMain { SessionStore(connection, memory, scope) }
        val shown = Collections.synchronizedList(mutableListOf<String>())
        scope.launch { store.messages.collect { shown += it } }
        onMain { connection.connect(server.url("/ws").toString()) }

        waitFor("the last session re-attached") { store.open.value?.session?.attachable == true }
        val terminal = onMain { store.open.value!!.terminal }
        assertTrue(terminal.isRunning)

        // The server restarts: the session is parked, not in memory.
        s1Live = false
        sockets.poll(5, TimeUnit.SECONDS)!!.close(1001, "restart")
        waitFor("the open session marked stale") { store.open.value?.session?.attachable == false }

        val open = onMain { store.open.value!! }
        assertSame("the screen it had is kept", terminal, open.terminal)
        assertFalse("its keys stop", terminal.isRunning)
        assertTrue(open.session.revivable)
        assertEquals("s1", memory.lastSessionId)

        received.clear()
        onMain { store.type("x") }
        Thread.sleep(150)
        assertTrue("no key reaches a socket not attached to it", received.none { it.type == ClientType.TERMINAL_DATA })

        // Revive answers session.created without scrollback: same terminal, running again.
        onMain { store.revive("s1") }
        waitFor("the revive answered") { store.open.value?.session?.attachable == true }
        assertSame(terminal, onMain { store.open.value!!.terminal })
        assertTrue(terminal.isRunning)
        onMain { store.type("y") }
        waitFor("a key sent after revive") {
            received.any { it.type == ClientType.TERMINAL_DATA && (it.payload as JsonObject)["data"]?.jsonPrimitive?.content == "y" }
        }

        assertTrue("a restart is not an error to show: $shown", shown.isEmpty())
        onMain { connection.disconnect() }
    }

    @Test
    fun aLastSessionThatIsGoneStartsOnTheList() {
        s1Live = false
        val connection = Connection(OkHttpClient(), scope, retryDelaysMs = listOf(50))
        val store = onMain { SessionStore(connection, memory, scope) }
        onMain { connection.connect(server.url("/ws").toString()) }
        waitFor("the attach refused") { memory.lastSessionId == null }
        assertNull(store.open.value)
        onMain { connection.disconnect() }
    }
}
