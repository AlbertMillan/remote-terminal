package com.clauderemote.app.net

import com.clauderemote.app.protocol.ClientType
import com.clauderemote.app.protocol.Envelope
import com.clauderemote.app.protocol.Protocol
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.asCoroutineDispatcher
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeout
import okhttp3.OkHttpClient
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import java.util.Collections
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.TimeUnit

/** [Connection] against a real WebSocket (MockWebServer) standing in for the server's /ws. */
class ConnectionTest {
    private lateinit var server: MockWebServer
    private val executor = Executors.newSingleThreadExecutor()
    private val dispatcher = executor.asCoroutineDispatcher()
    private val scope = CoroutineScope(SupervisorJob() + dispatcher)
    private val http = OkHttpClient()

    /** Server-side sockets, one per accepted upgrade, and every text they received. */
    private val serverSockets = LinkedBlockingQueue<WebSocket>()
    private val received = LinkedBlockingQueue<String>()

    private fun upgrade(onOpen: (WebSocket) -> Unit = { it.send("""{"type":"auth.success","payload":{"userId":"u","loginName":"me","displayName":"Me"}}""") }) =
        MockResponse().withWebSocketUpgrade(object : WebSocketListener() {
            override fun onOpen(webSocket: WebSocket, response: Response) {
                serverSockets += webSocket
                onOpen(webSocket)
            }

            override fun onMessage(webSocket: WebSocket, text: String) {
                received += text
                val env = Protocol.json.decodeFromString(Envelope.serializer(), text)
                if (env.type == ClientType.PING) webSocket.send("""{"type":"pong","id":"${env.id}"}""")
            }
        })

    @Before
    fun setUp() {
        server = MockWebServer()
        server.start()
    }

    @After
    fun tearDown() {
        scope.cancel()
        executor.shutdownNow()
        server.shutdown()
    }

    private fun url() = server.url("/ws").toString().replace("http://", "ws://")

    private fun newConnection() = Connection(http, scope, retryDelaysMs = listOf(50, 100))

    private suspend fun Connection.awaitState(predicate: (Connection.State) -> Boolean) =
        withTimeout(5_000) { state.first(predicate) }

    @Test
    fun connectsAndAnswersARequestById() = runBlocking {
        server.enqueue(upgrade())
        val c = newConnection()
        withContext(dispatcher) { c.connect(url()) }
        val connected = c.awaitState { it is Connection.State.Connected } as Connection.State.Connected
        assertEquals("Me", connected.user.displayName)
        val pong = withContext(dispatcher) { c.request(ClientType.PING, null, 2_000) }
        assertNotNull(pong)
        assertEquals("pong", pong!!.type)
        assertTrue(withContext(dispatcher) { c.verify() })
    }

    @Test
    fun reconnectsAfterTheServerDropsTheSocket() = runBlocking {
        server.enqueue(upgrade())
        server.enqueue(upgrade())
        val c = newConnection()
        withContext(dispatcher) { c.connect(url()) }
        c.awaitState { it is Connection.State.Connected }
        serverSockets.poll(5, TimeUnit.SECONDS)!!.close(1001, "server restart")
        c.awaitState { it is Connection.State.Waiting || it is Connection.State.Connecting }
        c.awaitState { it is Connection.State.Connected }
        assertEquals(2, server.requestCount)
    }

    @Test
    fun anAuthFailureWaitsAndSaysWhy() = runBlocking {
        server.enqueue(upgrade { ws ->
            ws.send("""{"type":"auth.failure","payload":{"message":"Unauthorized"}}""")
            ws.close(4001, "Unauthorized")
        })
        val c = newConnection()
        withContext(dispatcher) { c.connect(url()) }
        val waiting = c.awaitState { it is Connection.State.Waiting } as Connection.State.Waiting
        assertTrue(waiting.reason, waiting.reason.contains("Unauthorized"))
        withContext(dispatcher) { c.disconnect() }
    }

    @Test
    fun deliversTerminalOutputInOrderOnTheGivenDispatcher() = runBlocking {
        val count = 500
        server.enqueue(upgrade { ws ->
            ws.send("""{"type":"auth.success","payload":{"userId":"u","loginName":"me","displayName":"Me"}}""")
            for (i in 0 until count) ws.send("""{"type":"terminal.data","payload":{"sessionId":"s","data":"$i"}}""")
        })
        val c = newConnection()
        val got = Collections.synchronizedList(mutableListOf<String>())
        val threads = Collections.synchronizedSet(mutableSetOf<Thread>())
        val done = CountDownLatch(count)
        withContext(dispatcher) {
            c.addListener { env ->
                if (env.type == "terminal.data") {
                    threads += Thread.currentThread()
                    got += env.payload.toString()
                    done.countDown()
                }
            }
            c.connect(url())
        }
        assertTrue(done.await(5, TimeUnit.SECONDS))
        assertEquals((0 until count).map { """{"sessionId":"s","data":"$it"}""" }, got.toList())
        assertEquals(1, threads.size)
    }

    @Test
    fun sendsEnvelopesTheServerParses() = runBlocking {
        server.enqueue(upgrade())
        val c = newConnection()
        withContext(dispatcher) { c.connect(url()) }
        c.awaitState { it is Connection.State.Connected }
        withContext(dispatcher) {
            c.send(ClientType.SESSION_ATTACH, Protocol.encode(com.clauderemote.app.protocol.SessionIdPayload("s-1")))
        }
        val text = received.poll(5, TimeUnit.SECONDS)!!
        val env = Protocol.json.decodeFromString(Envelope.serializer(), text)
        assertEquals("session.attach", env.type)
        assertEquals("""{"sessionId":"s-1"}""", env.payload.toString())
        assertNotNull(env.id)
    }
}
