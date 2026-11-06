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
import org.junit.Assert.assertNull
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
                    "/api/jobs/j-1" -> """{"job":{"id":"j-1","projectCwd":"C:\\p","featureId":"f-1","title":"T","status":"parked","stage":"design","gate":"design","approvedGate":null,"parkReason":"question","detail":"- Q?","worktreePath":"x","stages":[{"id":1,"jobId":"j-1","name":"design","status":"passed","detail":null,"usage":{}}],"createdAt":"a","updatedAt":"b","future":true}}"""
                    "/api/jobs/j-1/decision" -> """{"decision":{"preamble":[],"cards":[{"question":"Which store?","context":["Context."],"options":[{"label":"a","text":"SQLite"},{"label":"b","text":"JSON"}],"recommendation":{"kind":"recommends","option":"a","text":"SQLite"}}],"questionCount":1}}"""
                    "/api/jobs/j-2/decision" -> """{"decision":null}"""
                    "/api/jobs/j-1/answer" -> """{"job":{"id":"j-1","projectCwd":"C:\\p","title":"T","status":"queued"}}"""
                    "/api/jobs/j-9" -> return MockResponse().setResponseCode(409).setBody("""{"error":"This job is not waiting for approval"}""")
                    else -> return MockResponse().setResponseCode(404).setBody("""{"error":"Unknown job"}""")
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
    fun decodesAJobTolerantly() = runBlocking {
        val job = api.job("j-1")
        assertEquals("question", job.parkReason)
        assertEquals(listOf("design"), job.stages.map { it.name })
    }

    @Test
    fun decodesTheBoardsDecision() = runBlocking {
        val d = api.decision("j-1")!!
        assertEquals("Which store?", d.cards[0].question)
        assertEquals(listOf("a", "b"), d.cards[0].options.map { it.label })
        assertNull(api.decision("j-2"))
    }

    @Test
    fun postsTheAnswerAsTheBoardDoes() = runBlocking {
        assertEquals("queued", api.answer("j-1", "(a) SQLite").status)
        val post = requests.last { it.path == "/api/jobs/j-1/answer" }
        assertEquals("POST", post.method)
        assertEquals("""{"answer":"(a) SQLite"}""", post.body.readUtf8())
    }

    @Test
    fun surfacesTheServersRefusal() = runBlocking {
        val error = runCatching { api.job("j-9") }.exceptionOrNull()
        assertEquals("This job is not waiting for approval", error?.message)
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

    @Test
    fun joinsAnswersOnePerQuestionAndAllRequired() {
        assertEquals("stop", JobsApi.joinAnswers(listOf("Q1"), listOf(" stop ")))
        assertEquals(
            "1) Which store?\n   SQLite\n2) Migrate?\n   no",
            JobsApi.joinAnswers(listOf("Which store?", "Migrate?"), listOf("SQLite", "no")),
        )
        assertNull(JobsApi.joinAnswers(listOf("A", "B"), listOf("x", " ")))
        assertNull(JobsApi.joinAnswers(emptyList(), emptyList()))
    }
}
