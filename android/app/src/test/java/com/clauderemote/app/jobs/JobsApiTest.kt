package com.clauderemote.app.jobs

import com.clauderemote.app.net.Api
import com.clauderemote.app.net.ServerAddress
import kotlinx.coroutines.runBlocking
import okhttp3.OkHttpClient
import okhttp3.mockwebserver.Dispatcher
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.RecordedRequest
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Before
import org.junit.Test

class JobsApiTest {
    private lateinit var server: MockWebServer
    private lateinit var api: JobsApi
    private val requests = mutableListOf<RecordedRequest>()

    @Before
    fun setUp() {
        server = MockWebServer()
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse {
                requests += request
                val body = when (request.path) {
                    "/api/factory/items/f-aaaaaa/release" -> """{"ok":true}"""
                    "/api/factory/items/f-bbbbbb/release" -> return MockResponse().setResponseCode(409).setBody("""{"error":"This unit is not parked"}""")
                    else -> return MockResponse().setResponseCode(404).setBody("""{"error":"Unknown route"}""")
                }
                return MockResponse().setBody(body)
            }
        }
        server.start()
        val address = ServerAddress.parse("http://${server.hostName}:${server.port}")
        api = JobsApi(Api(OkHttpClient()) { address })
    }

    @After
    fun tearDown() = server.shutdown()

    @Test
    fun releasesAFactoryUnitWithItsOutcome() = runBlocking {
        api.releaseFactory("C:/p", "f-aaaaaa", "approved")
        api.releaseFactory("C:/p", "f-aaaaaa", null)
        val posts = requests.filter { it.path == "/api/factory/items/f-aaaaaa/release" }
        assertEquals(listOf("POST", "POST"), posts.map { it.method })
        assertEquals("""{"cwd":"C:/p","outcome":"approved"}""", posts[0].body.readUtf8())
        assertEquals("""{"cwd":"C:/p"}""", posts[1].body.readUtf8())
    }

    @Test
    fun surfacesTheServersRefusal() = runBlocking {
        val error = runCatching { api.releaseFactory("C:/p", "f-bbbbbb", null) }.exceptionOrNull()
        assertEquals("This unit is not parked", error?.message)
    }

    @Test
    fun readsABoardFeatureWithANumericPriority() {
        // As /api/projects/detail sends it: priority is a number (P1 → 1), not a string.
        val f = com.clauderemote.app.protocol.Protocol.json.decodeFromString(
            BoardFeature.serializer(),
            """{"id":"f-2wq7bd","status":"done","priority":1,"title":"Revive","spec":"project/x.md"}""",
        )
        assertEquals(1, f.priority)
    }
}
