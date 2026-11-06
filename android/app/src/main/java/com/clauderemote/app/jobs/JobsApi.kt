package com.clauderemote.app.jobs

import com.clauderemote.app.net.Api
import com.clauderemote.app.protocol.Protocol
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.serializer

/*
 * The /api routes behind the web client's Projects board and job board, decoded
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
    val runningJobs: Int = 0,
    val waitingJobs: Int = 0,
    val lastActivity: String? = null,
)

@Serializable
data class AttentionItem(
    val kind: String,
    val projectCwd: String,
    val projectName: String,
    val title: String,
    val detail: String? = null,
    val jobId: String? = null,
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

@Serializable
data class StageInfo(val name: String, val status: String, val detail: String? = null)

@Serializable
data class Job(
    val id: String,
    val projectCwd: String,
    val featureId: String? = null,
    val title: String,
    val status: String,
    val stage: String? = null,
    val gate: String? = null,
    val parkReason: String? = null,
    val detail: String? = null,
    val stages: List<StageInfo> = emptyList(),
    val createdAt: String = "",
    val updatedAt: String = "",
)

@Serializable
data class DecisionOption(val label: String, val text: String)

@Serializable
data class DecisionRecommendation(val kind: String, val option: String? = null, val text: String)

@Serializable
data class DecisionCard(
    val question: String,
    val context: List<String> = emptyList(),
    val options: List<DecisionOption> = emptyList(),
    val recommendation: DecisionRecommendation? = null,
)

/** src/client/decision-format.ts's ParsedDecision, served by GET /api/jobs/:id/decision. */
@Serializable
data class Decision(val preamble: List<String> = emptyList(), val cards: List<DecisionCard> = emptyList(), val questionCount: Int = 0)

@Serializable
data class Finding(
    val id: String,
    val severity: String,
    val file: String,
    val line: Int? = null,
    val title: String,
    val detail: String = "",
    val suggestion: String = "",
    val selected: Boolean = false,
)

@Serializable
data class JobDoc(val path: String, val status: String = "unchanged", val insertions: Int = 0, val deletions: Int = 0, val isSpec: Boolean = false)

class JobsApi(private val api: Api) {
    private inline fun <reified T> decode(element: JsonElement?): T =
        Protocol.json.decodeFromJsonElement(serializer<T>(), element ?: JsonObject(emptyMap()))

    private fun obj(element: JsonElement): JsonObject = element as? JsonObject ?: JsonObject(emptyMap())

    suspend fun rollup(): Rollup = decode(api.get("/api/projects/rollup"))

    suspend fun project(cwd: String): BoardProject? =
        decode<ProjectDetail>(api.get("/api/projects/detail", mapOf("cwd" to cwd))).project

    suspend fun jobs(cwd: String? = null): List<Job> =
        decode(obj(api.get("/api/jobs", cwd?.let { mapOf("cwd" to it) } ?: emptyMap()))["jobs"])

    suspend fun job(id: String): Job = decode(obj(api.get("/api/jobs/$id"))["job"])

    suspend fun decision(id: String): Decision? =
        obj(api.get("/api/jobs/$id/decision"))["decision"]?.takeIf { it is JsonObject }?.let { decode<Decision>(it) }

    suspend fun findings(id: String): List<Finding> = decode(obj(api.get("/api/jobs/$id/findings"))["findings"])

    suspend fun selectFindings(id: String, selected: List<String>): List<Finding> =
        decode(obj(api.post("/api/jobs/$id/findings/select", JsonObject(mapOf("selected" to JsonArray(selected.map { JsonPrimitive(it) })))))["findings"])

    suspend fun docs(id: String): List<JobDoc> = decode(obj(api.get("/api/jobs/$id/docs"))["docs"])

    suspend fun file(id: String, path: String): String? =
        (obj(api.get("/api/jobs/$id/file", mapOf("path" to path)))["text"] as? JsonPrimitive)?.takeIf { it.isString }?.content

    suspend fun diff(id: String): String =
        (obj(api.get("/api/jobs/$id/diff"))["diff"] as? JsonPrimitive)?.content.orEmpty()

    suspend fun approve(id: String): Job = decode(obj(api.post("/api/jobs/$id/approve"))["job"])

    suspend fun answer(id: String, answer: String): Job =
        decode(obj(api.post("/api/jobs/$id/answer", JsonObject(mapOf("answer" to JsonPrimitive(answer)))))["job"])

    suspend fun retry(id: String): Job = decode(obj(api.post("/api/jobs/$id/retry"))["job"])

    suspend fun cancel(id: String): Job = decode(obj(api.post("/api/jobs/$id/cancel"))["job"])

    companion object {
        /**
         * The one string `/answer` takes, as the board builds it (job-board.ts submitAnswer):
         * a single answer as typed; several labelled by their question, since the stage re-runs
         * from its own prompt and "stop" alone does not say which question it settles.
         * Null while any box is empty — a partial answer restarts a stage still missing
         * what it stopped for.
         */
        fun joinAnswers(questions: List<String>, answers: List<String>): String? {
            if (answers.isEmpty() || answers.any { it.isBlank() }) return null
            if (answers.size == 1) return answers[0].trim()
            return answers.mapIndexed { i, a -> "${i + 1}) ${questions.getOrElse(i) { "" }}\n   ${a.trim()}" }.joinToString("\n")
        }
    }
}
