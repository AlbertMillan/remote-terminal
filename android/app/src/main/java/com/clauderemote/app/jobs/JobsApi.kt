package com.clauderemote.app.jobs

import com.clauderemote.app.net.Api
import com.clauderemote.app.protocol.Protocol
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.serializer

/*
 * The /api routes behind the web client's Projects board and the factory, decoded
 * tolerantly: the app reads only what it shows, so a field the server adds never breaks it.
 */

@Serializable
data class Counts(val total: Int = 0, val done: Int = 0, val in_progress: Int = 0, val pending: Int = 0, val blocked: Int = 0)

@Serializable
data class RollupProject(
    val cwd: String,
    val name: String,
    val status: String? = null,
    val hasDoc: Boolean = false,
    val counts: Counts? = null,
    val lastActivity: String? = null,
)

@Serializable
data class AttentionItem(
    val kind: String,
    val projectCwd: String,
    val projectName: String,
    val title: String,
    val detail: String? = null,
    val featureId: String? = null,
    val since: String? = null,
)

@Serializable
data class Rollup(val attention: List<AttentionItem> = emptyList(), val projects: List<RollupProject> = emptyList())

@Serializable
data class BoardFeature(val id: String, val status: String, val priority: Int? = null, val title: String, val spec: String? = null)

@Serializable
data class BoardTrack(val name: String, val features: List<BoardFeature> = emptyList())

@Serializable
data class BoardProject(val cwd: String, val name: String, val tracks: List<BoardTrack> = emptyList())

@Serializable
data class ProjectDetail(val project: BoardProject? = null)

class JobsApi(private val api: Api) {
    private inline fun <reified T> decode(element: JsonElement?): T =
        Protocol.json.decodeFromJsonElement(serializer<T>(), element ?: JsonObject(emptyMap()))

    private fun obj(element: JsonElement): JsonObject = element as? JsonObject ?: JsonObject(emptyMap())

    suspend fun rollup(): Rollup = decode(api.get("/api/projects/rollup"))

    suspend fun project(cwd: String): BoardProject? =
        decode<ProjectDetail>(api.get("/api/projects/detail", mapOf("cwd" to cwd))).project

    /**
     * Hand a parked factory unit back (POST /api/factory/items/:featureId/release):
     * `approved` passes its review, null releases a loop cap or runaway park for another round.
     */
    suspend fun releaseFactory(cwd: String, featureId: String, outcome: String?) {
        val body = buildMap<String, JsonElement> {
            put("cwd", JsonPrimitive(cwd))
            if (outcome != null) put("outcome", JsonPrimitive(outcome))
        }
        api.post("/api/factory/items/$featureId/release", JsonObject(body))
    }
}
