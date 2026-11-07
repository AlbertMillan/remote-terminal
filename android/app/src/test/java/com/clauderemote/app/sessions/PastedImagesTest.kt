package com.clauderemote.app.sessions

import com.clauderemote.app.net.Api
import com.clauderemote.app.net.ApiException
import com.clauderemote.app.net.ServerAddress
import kotlinx.coroutines.runBlocking
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import java.io.IOException

class PastedImagesTest {
    private lateinit var server: MockWebServer
    private lateinit var api: Api
    private val png = byteArrayOf(0x89.toByte(), 0x50, 0x4e, 0x47, 1, 2, 3)
    private fun body() = png.toRequestBody("image/png".toMediaType())

    @Before
    fun setUp() {
        server = MockWebServer()
        server.start()
        val address = ServerAddress.parse("http://${server.hostName}:${server.port}")
        api = Api(OkHttpClient()) { address }
    }

    @After
    fun tearDown() = server.shutdown()

    // As the web client's pastedImageText (tests/pasted-image-client.test.ts).
    @Test
    fun pastesThePathWithATrailingSpaceQuotedOnlyWhenItHoldsOne() {
        assertEquals("C:\\Users\\a\\.claude-remote\\images\\s\\1.png ", PastedImages.pastedText("C:\\Users\\a\\.claude-remote\\images\\s\\1.png"))
        assertEquals("\"C:\\Users\\A B\\1.png\" ", PastedImages.pastedText("C:\\Users\\A B\\1.png"))
    }

    @Test
    fun capMatchesTheServer() {
        // src/server/sessions/pasted-images.ts MAX_IMAGE_BYTES
        assertEquals(20L * 1024 * 1024, PastedImages.MAX_BYTES)
    }

    @Test
    fun postsTheBytesToTheSessionAndAnswersTheTextToPaste() = runBlocking {
        server.enqueue(MockResponse().setBody("""{"path":"C:\\d\\images\\s-1\\a.png"}"""))
        assertEquals("C:\\d\\images\\s-1\\a.png ", PastedImages.upload(api, "s-1", body()))
        val request = server.takeRequest()
        assertEquals("POST", request.method)
        assertEquals("/api/sessions/s-1/images", request.path)
        assertEquals("image/png", request.getHeader("Content-Type"))
        assertTrue(request.body.readByteArray().contentEquals(png))
    }

    @Test
    fun anAnswerWithNoPathIsAFailureNotAnEmptyPaste() {
        server.enqueue(MockResponse().setBody("""{}"""))
        val e = assertThrows(IOException::class.java) { runBlocking { PastedImages.upload(api, "s-1", body()) } }
        assertEquals("The server saved no image", e.message)
    }

    @Test
    fun theServersRefusalIsItsMessage() {
        server.enqueue(MockResponse().setResponseCode(415).setBody("""{"error":"Not a PNG, JPEG, GIF or WebP image"}"""))
        val e = assertThrows(ApiException::class.java) { runBlocking { PastedImages.upload(api, "s-1", body()) } }
        assertEquals("Not a PNG, JPEG, GIF or WebP image", e.message)
    }

    @Test
    fun anIdThatIsNotAPlainTokenNeverReachesTheUrl() {
        assertThrows(IOException::class.java) { runBlocking { PastedImages.upload(api, "../jobs", body()) } }
        assertEquals(0, server.requestCount)
    }
}
