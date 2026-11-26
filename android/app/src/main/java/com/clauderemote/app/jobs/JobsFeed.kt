package com.clauderemote.app.jobs

import com.clauderemote.app.net.Connection
import com.clauderemote.app.protocol.FactorySummaryPayload
import com.clauderemote.app.protocol.FactoryUnitSummary
import com.clauderemote.app.protocol.JobSummary
import com.clauderemote.app.protocol.JobsSummaryPayload
import com.clauderemote.app.protocol.Protocol
import com.clauderemote.app.protocol.ServerType
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

/**
 * The server's live job feed (`jobs.summary`) and factory feed (`factory.summary`), each
 * pushed on every write and once after auth, and a tick for `projects.changed`, so open
 * screens refresh on their own.
 */
class JobsFeed(connection: Connection) {
    private val _jobs = MutableStateFlow<List<JobSummary>>(emptyList())
    val jobs: StateFlow<List<JobSummary>> = _jobs.asStateFlow()

    private val _factory = MutableStateFlow<FactorySummaryPayload?>(null)
    /** The factory's units and merge queue; null until the server sent one. */
    val factory: StateFlow<FactorySummaryPayload?> = _factory.asStateFlow()

    /** Bumped on every job write and project change: screens reload what they show. */
    private val _revision = MutableStateFlow(0)
    val revision: StateFlow<Int> = _revision.asStateFlow()

    init {
        connection.addListener { env ->
            when (env.type) {
                ServerType.JOBS_SUMMARY -> {
                    Protocol.decode<JobsSummaryPayload>(env.payload)?.let { _jobs.value = it.jobs }
                    _revision.value++
                }
                ServerType.FACTORY_SUMMARY -> {
                    // No revision bump: heartbeats push this every minute, and screens that read
                    // the factory collect `factory` itself rather than reloading on a tick.
                    Protocol.decode<FactorySummaryPayload>(env.payload)?.let { _factory.value = it }
                }
                ServerType.PROJECTS_CHANGED -> _revision.value++
            }
        }
    }

    /** Jobs waiting on the user: parked at a gate or on a question. */
    fun waiting(jobs: List<JobSummary>): List<JobSummary> = jobs.filter { it.status == "parked" }

    companion object {
        /** Units worth a row: everything but today's done, what waits for you first (the overlay's order). */
        fun liveUnits(units: List<FactoryUnitSummary>): List<FactoryUnitSummary> =
            units.filter { it.column != "done" }.sortedWith(compareBy({ !it.needsYou }, { columnRank(it.column) }))

        private fun columnRank(column: String) = when (column) {
            "review" -> 1
            "running" -> 2
            "intake" -> 3
            "ready" -> 4
            "merging" -> 5
            else -> 6
        }

        /** "needs you: review", "agent reviewing", "merging: holding", "feature 2 of 4", "ready". */
        fun unitLabel(u: FactoryUnitSummary): String = when {
            u.triage -> "triage"
            u.needsYou && u.column == "review" -> if (u.escalated) "escalated" else "needs you: review"
            u.needsYou -> "needs you: ${u.step ?: u.column}"
            u.column == "review" -> "agent reviewing"
            u.column == "merging" -> "merging" + (u.mergeStatus?.let { ": $it" } ?: "")
            u.isTrack && u.features.isNotEmpty() && u.column == "running" ->
                "feature ${(u.features.indexOfFirst { it.state == "now" }.takeIf { it >= 0 } ?: u.features.count { it.state == "done" }) + 1} of ${u.features.size}"
            u.column == "running" -> u.step ?: "running"
            else -> u.column
        }

        /** The unit can be handed back from here: parked by the engine, not a triage card or a merge park. */
        fun canRelease(u: FactoryUnitSummary): Boolean = u.status == "parked" && !u.triage && u.column != "merging"
    }
}
