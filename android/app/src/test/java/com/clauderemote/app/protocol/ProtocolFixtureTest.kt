package com.clauderemote.app.protocol

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.fail
import org.junit.Test

/**
 * The app half of the protocol drift check (docs/android-app.md). The server's
 * tests/protocol-fixture.test.ts keeps tests/fixtures/protocol/messages.json in step with
 * protocol.ts; this decodes every message in it *strictly* through the app's types, so a
 * message type or field the server added and the app lacks fails `npm run android:test`.
 */
class ProtocolFixtureTest {
    private val fixture: JsonObject by lazy {
        val text = javaClass.classLoader!!.getResource("messages.json")!!.readText()
        Protocol.strictJson.parseToJsonElement(text).jsonObject
    }

    private fun resolve(element: JsonElement, shapes: JsonObject): JsonElement = when (element) {
        is JsonPrimitive ->
            if (element.isString && element.content.startsWith("$")) shapes[element.content.drop(1)]!! else element
        is JsonArray -> JsonArray(element.map { resolve(it, shapes) })
        is JsonObject -> JsonObject(element.mapValues { resolve(it.value, shapes) })
    }

    private fun messages(direction: String): List<JsonObject> {
        val shapes = fixture["shapes"]!!.jsonObject
        return fixture[direction]!!.jsonArray.map { resolve(it, shapes).jsonObject }
    }

    private fun checkDirection(direction: String, payloads: Map<String, kotlinx.serialization.KSerializer<*>?>) {
        val list = messages(direction)
        assertEquals(
            "the app's $direction message types differ from protocol.ts (via the fixture)",
            list.map { it["type"]!!.jsonPrimitive.content }.toSortedSet(),
            payloads.keys.toSortedSet(),
        )
        for (message in list) {
            val envelope = Protocol.strictJson.decodeFromJsonElement(Envelope.serializer(), message)
            val serializer = payloads.getValue(envelope.type)
            if (serializer == null) {
                if (envelope.payload != null) fail("${envelope.type} carries a payload the app ignores")
                continue
            }
            try {
                Protocol.strictJson.decodeFromJsonElement(serializer, envelope.payload!!)
            } catch (e: Exception) {
                fail("${envelope.type}: ${e.message}")
            }
        }
    }

    @Test
    fun clientMessagesMatchTheFixture() = checkDirection("client", Protocol.clientPayloads)

    @Test
    fun serverMessagesMatchTheFixture() = checkDirection("server", Protocol.serverPayloads)

    @Test
    fun tolerantJsonIgnoresFieldsANewerServerAdds() {
        val session = messages("server").first { it["type"]!!.jsonPrimitive.content == ServerType.SESSION_LIST }
        val withExtra = JsonObject(session["payload"]!!.jsonObject.mapValues { (k, v) ->
            if (k != "sessions") v else JsonArray(v.jsonArray.map { JsonObject(it.jsonObject + ("future" to JsonPrimitive(1))) })
        })
        val decoded = Protocol.decode<SessionListPayload>(withExtra)
        assertEquals(1, decoded!!.sessions.size)
    }

    @Test
    fun aMoveToNoCategoryIsSentAsAnExplicitNull() {
        val json = Protocol.encode(SessionMovePayload("s-1", null)).toString()
        assertEquals("""{"sessionId":"s-1","categoryId":null}""", json)
    }
}
