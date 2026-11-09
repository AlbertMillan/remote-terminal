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
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import java.io.IOException

class PastedFilesTest {
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

    // As the web client's pastedFileText (tests/pasted-file-client.test.ts).
    @Test
    fun pastesThePathWithATrailingSpaceQuotedOnlyWhenItHoldsOne() {
        assertEquals("C:\\Users\\a\\.claude-remote\\uploads\\s\\1.png ", PastedFiles.pastedText("C:\\Users\\a\\.claude-remote\\uploads\\s\\1.png"))
        assertEquals("\"C:\\Users\\A B\\1.png\" ", PastedFiles.pastedText("C:\\Users\\A B\\1.png"))
    }

    @Test
    fun capMatchesTheServer() {
        // src/server/sessions/uploads.ts MAX_UPLOAD_BYTES
        assertEquals(20L * 1024 * 1024, PastedFiles.MAX_BYTES)
    }

    @Test
    fun postsTheBytesToTheSessionAndAnswersTheTextToPaste() = runBlocking {
        server.enqueue(MockResponse().setBody("""{"path":"C:\\d\\uploads\\s-1\\a.png"}"""))
        assertEquals("C:\\d\\uploads\\s-1\\a.png ", PastedFiles.upload(api, "s-1", "a.png", body()))
        val request = server.takeRequest()
        assertEquals("POST", request.method)
        assertEquals("/api/sessions/s-1/files?name=a.png", request.path)
        assertEquals("image/png", request.getHeader("Content-Type"))
        assertTrue(request.body.readByteArray().contentEquals(png))
    }

    @Test
    fun anAnswerWithNoPathIsAFailureNotAnEmptyPaste() {
        server.enqueue(MockResponse().setBody("""{}"""))
        val e = assertThrows(IOException::class.java) { runBlocking { PastedFiles.upload(api, "s-1", "a.png", body()) } }
        assertEquals("The server saved no file", e.message)
    }

    @Test
    fun theServersRefusalIsItsMessage() {
        server.enqueue(MockResponse().setResponseCode(413).setBody("""{"error":"Pick a smaller file"}"""))
        val e = assertThrows(ApiException::class.java) { runBlocking { PastedFiles.upload(api, "s-1", "a.png", body()) } }
        assertEquals("Pick a smaller file", e.message)
    }

    @Test
    fun anIdThatIsNotAPlainTokenNeverReachesTheUrl() {
        assertThrows(IOException::class.java) { runBlocking { PastedFiles.upload(api, "../jobs", "a.png", body()) } }
        assertEquals(0, server.requestCount)
    }

    @Test
    fun theDisplayNameIsEncodedIntoTheQuery() = runBlocking {
        server.enqueue(MockResponse().setBody("""{"path":"/d/x"}"""))
        PastedFiles.upload(api, "s-1", "my spec & notes.pdf", body())
        assertEquals("/api/sessions/s-1/files?name=my%20spec%20%26%20notes.pdf", server.takeRequest().path)
    }

    @Test
    fun severalFilesAreOnePasteInPickOrder() {
        assertEquals("/a/1.png \"/b c/2.pdf\" /d/3.md ", PastedFiles.joinPasted(listOf("/a/1.png", "/b c/2.pdf", "/d/3.md")))
        assertEquals("", PastedFiles.joinPasted(emptyList()))
    }

    private val send = "android.intent.action.SEND"
    private val sendMany = "android.intent.action.SEND_MULTIPLE"

    @Test
    fun aPlainTextShareWithTextIsTextEvenWithAThumbnail() {
        assertEquals(PastedFiles.Share.Text, PastedFiles.parseShare(send, "text/plain", true, listOf("thumb")))
        assertEquals(PastedFiles.Share.Text, PastedFiles.parseShare(send, "text/plain", true, emptyList<String>()))
    }

    @Test
    fun aSingleStreamIsAFile() {
        assertEquals(PastedFiles.Share.Files(listOf("a")), PastedFiles.parseShare(send, "application/pdf", false, listOf("a")))
        assertEquals(PastedFiles.Share.Files(listOf("a")), PastedFiles.parseShare(send, "image/png", true, listOf("a")))
        // A text/plain file (a .txt) has a stream and no text: a file.
        assertEquals(PastedFiles.Share.Files(listOf("a")), PastedFiles.parseShare(send, "text/plain", false, listOf("a")))
    }

    @Test
    fun aShareOfOtherTypeWithOnlyTextFallsBackToText() {
        assertEquals(PastedFiles.Share.Text, PastedFiles.parseShare(send, "text/html", true, emptyList<String>()))
    }

    @Test
    fun severalStreamsAreAllFilesInOrder() {
        assertEquals(PastedFiles.Share.Files(listOf("a", "b", "c")), PastedFiles.parseShare(sendMany, "*/*", false, listOf("a", "b", "c")))
    }

    @Test
    fun anEmptyOrUnknownShareIsNothing() {
        assertNull(PastedFiles.parseShare(send, "application/pdf", false, emptyList<String>()))
        assertNull(PastedFiles.parseShare(sendMany, "*/*", false, emptyList<String>()))
        assertNull(PastedFiles.parseShare("android.intent.action.VIEW", null, true, listOf("a")))
        assertNull(PastedFiles.parseShare(null, null, false, emptyList<String>()))
    }
}
