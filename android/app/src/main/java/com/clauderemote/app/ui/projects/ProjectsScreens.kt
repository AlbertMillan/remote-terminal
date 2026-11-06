package com.clauderemote.app.ui.projects

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.clauderemote.app.App
import com.clauderemote.app.protocol.JobSummary
import com.clauderemote.app.ui.common.Chip
import com.clauderemote.app.ui.common.LoadingOrError
import com.clauderemote.app.ui.common.Page
import com.clauderemote.app.ui.common.rememberLoaded
import com.clauderemote.app.ui.common.statusColor
import com.clauderemote.app.ui.theme.Palette

/** Everything waiting on you first (live from `jobs.summary`), then every project. */
@Composable
fun ProjectsScreen(app: App, onBack: () -> Unit, openProject: (String) -> Unit, openJob: (String) -> Unit) {
    val jobs by app.jobsFeed.jobs.collectAsStateWithLifecycle()
    // The roll-up parses every PROJECT.md: loaded on open and on Refresh, not on every job write.
    val rollup = rememberLoaded(Unit) { app.jobsApi.rollup() }
    Page("Projects", onBack = onBack, actions = { TextButton(onClick = rollup.reload) { Text("Refresh") } }) {
        LazyColumn(Modifier.fillMaxWidth().weight(1f)) {
            val live = jobs.filter { it.status in setOf("parked", "running", "queued", "failed") }
            if (live.isNotEmpty()) {
                item { SectionHeader("Jobs") }
                items(live, key = { "j:" + it.id }) { job -> JobRow(job) { openJob(job.id) } }
            }
            val attention = rollup.value?.attention.orEmpty().filter { it.jobId == null }
            if (attention.isNotEmpty()) {
                item { SectionHeader("Needs attention") }
                items(attention, key = { "a:" + it.projectCwd + it.title }) { a ->
                    Column(Modifier.fillMaxWidth().clickable { openProject(a.projectCwd) }.padding(horizontal = 16.dp, vertical = 10.dp)) {
                        Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
                            Chip(a.kind, statusColor(a.kind))
                            Text(a.title, maxLines = 1, overflow = TextOverflow.Ellipsis)
                        }
                        Text(listOfNotNull(a.projectName, a.detail).joinToString(" · "), style = MaterialTheme.typography.bodySmall, color = Palette.muted, maxLines = 2)
                    }
                }
            }
            item { SectionHeader("Projects") }
            val projects = rollup.value?.projects.orEmpty().sortedByDescending { it.lastActivity ?: "" }
            if (rollup.value == null) item { LoadingOrError(rollup) }
            items(projects, key = { "p:" + it.cwd }) { p ->
                Column(Modifier.fillMaxWidth().clickable { openProject(p.cwd) }.padding(horizontal = 16.dp, vertical = 10.dp)) {
                    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        Text(p.name, fontWeight = FontWeight.Medium, modifier = Modifier.weight(1f), maxLines = 1, overflow = TextOverflow.Ellipsis)
                        if (p.waitingJobs > 0) Chip("${p.waitingJobs} waiting", Palette.warn)
                        if (p.runningJobs > 0) Chip("${p.runningJobs} running", Palette.accent)
                    }
                    val c = p.counts
                    Text(
                        if (c != null && c.total > 0) "${c.done}/${c.total} done · ${c.in_progress} in progress · ${c.pending} pending" else (if (p.hasDoc) "No features" else "No PROJECT.md"),
                        style = MaterialTheme.typography.bodySmall, color = Palette.muted,
                    )
                }
            }
        }
    }
}

@Composable
fun SectionHeader(text: String) {
    Text(
        text.uppercase(),
        style = MaterialTheme.typography.labelSmall,
        color = Palette.muted,
        fontWeight = FontWeight.SemiBold,
        modifier = Modifier.padding(start = 16.dp, end = 16.dp, top = 16.dp, bottom = 6.dp),
    )
}

@Composable
fun JobRow(job: JobSummary, onClick: () -> Unit) {
    Column(Modifier.fillMaxWidth().clickable(onClick = onClick).padding(horizontal = 16.dp, vertical = 10.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Chip(jobLabel(job.status, job.gate, job.parkReason, job.stage), statusColor(job.status))
            Text(job.title, maxLines = 1, overflow = TextOverflow.Ellipsis)
        }
        Text(job.projectName, style = MaterialTheme.typography.bodySmall, color = Palette.muted)
    }
}

/** "design gate", "question", "running: implement", "failed: review". */
fun jobLabel(status: String, gate: String?, parkReason: String?, stage: String?): String = when {
    status == "parked" && parkReason == "question" -> "question"
    status == "parked" -> "${gate ?: stage ?: ""} gate".trim()
    status == "running" && stage != null -> stage
    status == "failed" && stage != null -> "failed: $stage"
    else -> status
}

/** One project: its jobs (live) and its plan's tracks and features. */
@Composable
fun ProjectScreen(app: App, cwd: String, onBack: () -> Unit, openJob: (String) -> Unit) {
    val revision by app.jobsFeed.revision.collectAsStateWithLifecycle()
    val project = rememberLoaded(cwd) { app.jobsApi.project(cwd) }
    val jobs = rememberLoaded(cwd, revision) { app.jobsApi.jobs(cwd) }
    Page(project.value?.name ?: cwd.substringAfterLast('\\').substringAfterLast('/'), subtitle = cwd, onBack = onBack) {
        LazyColumn(Modifier.fillMaxWidth().weight(1f)) {
            val list = jobs.value.orEmpty().sortedByDescending { it.updatedAt }
            if (list.isNotEmpty()) {
                item { SectionHeader("Jobs") }
                items(list, key = { "j:" + it.id }) { job ->
                    Column(Modifier.fillMaxWidth().clickable { openJob(job.id) }.padding(horizontal = 16.dp, vertical = 10.dp)) {
                        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                            Chip(jobLabel(job.status, job.gate, job.parkReason, job.stage), statusColor(job.status))
                            Text(job.title, maxLines = 1, overflow = TextOverflow.Ellipsis)
                        }
                    }
                }
            }
            val p = project.value
            if (p == null) item { LoadingOrError(project) }
            p?.tracks?.forEach { track ->
                item(key = "t:" + track.name) { SectionHeader(track.name) }
                items(track.features, key = { "f:" + track.name + it.id }) { f ->
                    Row(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 7.dp), verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        Text(featureMark(f.status), color = statusColor(f.status))
                        Text(f.title, style = MaterialTheme.typography.bodyMedium, modifier = Modifier.weight(1f))
                        f.priority?.let { Text("P$it", style = MaterialTheme.typography.labelSmall, color = Palette.muted) }
                    }
                }
                item(key = "d:" + track.name) { HorizontalDivider(color = Palette.surfaceHigh, modifier = Modifier.padding(top = 6.dp)) }
            }
        }
    }
}

private fun featureMark(status: String) = when (status) {
    "done" -> "✓"
    "in_progress" -> "◐"
    "blocked" -> "!"
    else -> "○"
}
