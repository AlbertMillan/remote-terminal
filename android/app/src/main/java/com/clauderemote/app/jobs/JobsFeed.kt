package com.clauderemote.app.jobs

import com.clauderemote.app.net.Connection
import com.clauderemote.app.protocol.JobSummary
import com.clauderemote.app.protocol.JobsSummaryPayload
import com.clauderemote.app.protocol.Protocol
import com.clauderemote.app.protocol.ServerType
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

/**
 * The server's live job feed (`jobs.summary`, pushed on every job write and once after
 * auth) and a tick for `projects.changed`, so open screens refresh on their own.
 */
class JobsFeed(connection: Connection) {
    private val _jobs = MutableStateFlow<List<JobSummary>>(emptyList())
    val jobs: StateFlow<List<JobSummary>> = _jobs.asStateFlow()

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
                ServerType.PROJECTS_CHANGED -> _revision.value++
            }
        }
    }

    /** Jobs waiting on the user: parked at a gate or on a question. */
    fun waiting(jobs: List<JobSummary>): List<JobSummary> = jobs.filter { it.status == "parked" }
}
