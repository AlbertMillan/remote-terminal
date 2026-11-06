package com.clauderemote.app.ui.projects

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.Checkbox
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.clauderemote.app.App
import com.clauderemote.app.jobs.Decision
import com.clauderemote.app.jobs.Job
import com.clauderemote.app.jobs.JobsApi
import com.clauderemote.app.ui.common.Chip
import com.clauderemote.app.ui.common.LoadingOrError
import com.clauderemote.app.ui.common.Page
import com.clauderemote.app.ui.common.rememberLoaded
import com.clauderemote.app.ui.common.statusColor
import com.clauderemote.app.ui.theme.Palette
import kotlinx.coroutines.launch

/**
 * One job and whatever it is waiting for: answers to its questions (one box per
 * question, all required), the review findings to hand to the fix stage, or approval
 * of its design or merge. Live: every job write reloads it.
 */
@Composable
fun JobScreen(app: App, jobId: String, onBack: () -> Unit, openProject: (String) -> Unit) {
    val revision by app.jobsFeed.revision.collectAsStateWithLifecycle()
    val loaded = rememberLoaded(jobId, revision) { app.jobsApi.job(jobId) }
    val job = loaded.value
    val scope = rememberCoroutineScope()
    var busy by remember { mutableStateOf(false) }
    var message by remember { mutableStateOf<String?>(null) }
    var viewing by remember { mutableStateOf<Pair<String, String>?>(null) }

    fun act(label: String, call: suspend () -> Unit) {
        if (busy) return
        busy = true
        message = null
        scope.launch {
            try {
                call()
                loaded.reload()
            } catch (e: Exception) {
                message = "$label failed: ${e.message}"
            } finally {
                busy = false
            }
        }
    }

    Page(job?.title ?: "Job", subtitle = job?.projectCwd, onBack = onBack, actions = {
        job?.let {
            val context = androidx.compose.ui.platform.LocalContext.current
            TextButton(onClick = {
                val cm = context.getSystemService(android.content.ClipboardManager::class.java)
                cm?.setPrimaryClip(android.content.ClipData.newPlainText(it.title, com.clauderemote.app.links.Link.Job(it.id).toUri()))
                message = "Link copied"
            }) { Text("Link") }
            TextButton(onClick = { openProject(it.projectCwd) }) { Text("Project") }
        }
    }) {
        if (job == null) {
            LoadingOrError(loaded)
            return@Page
        }
        Column(Modifier.fillMaxWidth().weight(1f).verticalScroll(rememberScrollState()).padding(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Chip(jobLabel(job.status, job.gate, job.parkReason, job.stage), statusColor(job.status))
                job.featureId?.let { Text(it, style = MaterialTheme.typography.labelSmall, color = Palette.muted) }
            }
            StageStrip(job)
            message?.let { Text(it, color = Palette.error) }

            when {
                job.status == "parked" && job.parkReason == "question" ->
                    QuestionGate(app, job, busy) { answer -> act("Answer") { app.jobsApi.answer(job.id, answer) } }
                job.status == "parked" && job.gate == "review" ->
                    ReviewGate(app, job, busy, onApprove = { act("Approve") { app.jobsApi.approve(job.id) } })
                job.status == "parked" -> {
                    job.detail?.let { DetailText(it) }
                    if (job.gate == "merge") MergePreview(app, job) { title, text -> viewing = title to text }
                    else DocsList(app, job) { title, text -> viewing = title to text }
                    Button(onClick = { act("Approve") { app.jobsApi.approve(job.id) } }, enabled = !busy, modifier = Modifier.fillMaxWidth()) {
                        Text(if (job.gate == "merge") "Approve merge" else "Approve ${job.gate ?: ""}".trim())
                    }
                }
                else -> job.detail?.let { DetailText(it) }
            }

            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                if (job.status == "failed") {
                    OutlinedButton(onClick = { act("Retry") { app.jobsApi.retry(job.id) } }, enabled = !busy) { Text("Retry") }
                }
                if (job.status in setOf("queued", "running", "parked")) {
                    var confirm by remember { mutableStateOf(false) }
                    OutlinedButton(onClick = { confirm = true }, enabled = !busy) { Text("Cancel job") }
                    if (confirm) AlertDialog(
                        onDismissRequest = { confirm = false },
                        title = { Text("Cancel this job?") },
                        text = { Text("Its running stage stops and its worktree is torn down.") },
                        confirmButton = { TextButton(onClick = { confirm = false; act("Cancel") { app.jobsApi.cancel(job.id) } }) { Text("Cancel job") } },
                        dismissButton = { TextButton(onClick = { confirm = false }) { Text("Keep") } },
                    )
                }
            }
        }
    }

    viewing?.let { (title, text) ->
        Page(title, onBack = { viewing = null }) {
            SelectionContainer(Modifier.weight(1f)) {
                Column(Modifier.verticalScroll(rememberScrollState()).horizontalScroll(rememberScrollState()).padding(12.dp)) {
                    Text(text, fontFamily = FontFamily.Monospace, fontSize = 12.sp)
                }
            }
        }
    }
}

@Composable
private fun StageStrip(job: Job) {
    if (job.stages.isEmpty()) return
    Row(Modifier.horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(4.dp)) {
        for (stage in job.stages) Chip(stage.name, statusColor(stage.status))
    }
}

@Composable
private fun DetailText(text: String) {
    SelectionContainer {
        Text(text, style = MaterialTheme.typography.bodyMedium, modifier = Modifier.background(Palette.surface, RoundedCornerShape(8.dp)).padding(12.dp))
    }
}

/** The question cards as the web board shows them, each with its own required answer. */
@Composable
private fun QuestionGate(app: App, job: Job, busy: Boolean, send: (String) -> Unit) {
    val decision = rememberLoaded(job.id, job.detail) { app.jobsApi.decision(job.id) }
    if (decision.loading && decision.value == null) {
        LoadingOrError(decision)
        return
    }
    val parsed: Decision? = decision.value
    val questions = parsed?.cards?.filter { it.question.isNotBlank() }.orEmpty()
    // Drafts survive a reload (every job write reloads this screen).
    val answers = remember(job.id, questions.size) { mutableStateListOf(*Array(maxOf(1, questions.size)) { "" }) }

    if (parsed == null || questions.isEmpty()) {
        job.detail?.let { DetailText(it) }
    } else {
        parsed.preamble.forEach { Text(it, style = MaterialTheme.typography.bodyMedium, color = Palette.muted) }
        parsed.cards.forEach { card ->
            if (card.question.isBlank()) {
                card.context.forEach { Text(it, style = MaterialTheme.typography.bodyMedium, color = Palette.muted) }
                return@forEach
            }
            val index = questions.indexOf(card)
            Column(
                Modifier.fillMaxWidth().background(Palette.surface, RoundedCornerShape(8.dp)).padding(12.dp),
                verticalArrangement = Arrangement.spacedBy(6.dp),
            ) {
                Text(card.question, fontWeight = FontWeight.SemiBold)
                card.context.forEach { Text(it, style = MaterialTheme.typography.bodySmall, color = Palette.muted) }
                card.options.forEach { o ->
                    Text("(${o.label}) ${o.text}", style = MaterialTheme.typography.bodyMedium,
                        modifier = Modifier.fillMaxWidth().clickable { answers[index] = "(${o.label}) ${o.text}" }.padding(vertical = 2.dp))
                }
                card.recommendation?.let { r ->
                    // "Recommends (b)." parses to option b with no text worth showing.
                    val lead = (if (r.kind == "assumes") "Assumed" else "Recommends") + (r.option?.let { " ($it)" } ?: "")
                    val text = r.text.trim().trim('.', ' ')
                    Text(if (text.isEmpty()) lead else "$lead: ${r.text.trim()}",
                        style = MaterialTheme.typography.bodySmall, color = Palette.accent)
                }
                OutlinedTextField(
                    value = answers[index],
                    onValueChange = { answers[index] = it },
                    placeholder = { Text("Your answer") },
                    modifier = Modifier.fillMaxWidth(),
                )
            }
        }
    }
    if (questions.isEmpty()) {
        OutlinedTextField(answers[0], { answers[0] = it }, placeholder = { Text("Your decision") }, modifier = Modifier.fillMaxWidth())
    }
    val joined = JobsApi.joinAnswers(questions.map { it.question }, answers.toList())
    Button(onClick = { joined?.let(send) }, enabled = !busy && joined != null, modifier = Modifier.fillMaxWidth()) {
        Text(if (questions.size > 1 && joined == null) "Answer every question" else "Send answer")
    }
}

/** The review's findings: the ticked ones go to the fix stage. */
@Composable
private fun ReviewGate(app: App, job: Job, busy: Boolean, onApprove: () -> Unit) {
    val scope = rememberCoroutineScope()
    val loaded = rememberLoaded(job.id) { app.jobsApi.findings(job.id) }
    var findings by remember(loaded.value) { mutableStateOf(loaded.value.orEmpty()) }
    var error by rememberSaveable { mutableStateOf<String?>(null) }
    job.detail?.let { DetailText(it) }
    if (loaded.value == null) LoadingOrError(loaded)
    if (loaded.value != null && findings.isEmpty()) Text("The review found nothing to fix.", color = Palette.muted)
    findings.forEach { f ->
        Row(Modifier.fillMaxWidth().background(Palette.surface, RoundedCornerShape(8.dp)).padding(8.dp), verticalAlignment = Alignment.Top) {
            Checkbox(checked = f.selected, onCheckedChange = { checked ->
                val ids = findings.filter { if (it.id == f.id) checked else it.selected }.map { it.id }
                findings = findings.map { if (it.id == f.id) it.copy(selected = checked) else it }
                scope.launch {
                    try {
                        findings = app.jobsApi.selectFindings(job.id, ids)
                        error = null
                    } catch (e: Exception) {
                        error = "Couldn't save the selection: ${e.message}"
                    }
                }
            })
            Column(Modifier.weight(1f)) {
                Row(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalAlignment = Alignment.CenterVertically) {
                    Chip(f.severity, if (f.severity == "high" || f.severity == "critical") Palette.error else Palette.warn)
                    Text(f.title, fontWeight = FontWeight.Medium)
                }
                Text(f.file + (f.line?.let { ":$it" } ?: ""), style = MaterialTheme.typography.labelSmall, color = Palette.muted)
                if (f.detail.isNotBlank()) Text(f.detail, style = MaterialTheme.typography.bodySmall)
                if (f.suggestion.isNotBlank()) Text("Fix: " + f.suggestion, style = MaterialTheme.typography.bodySmall, color = Palette.accent)
            }
        }
    }
    error?.let { Text(it, color = Palette.error) }
    val ticked = findings.count { it.selected }
    Button(onClick = onApprove, enabled = !busy, modifier = Modifier.fillMaxWidth()) {
        Text(if (ticked > 0) "Fix $ticked and continue" else "Continue without fixes")
    }
}

@Composable
private fun DocsList(app: App, job: Job, open: (String, String) -> Unit) {
    val scope = rememberCoroutineScope()
    val docs = rememberLoaded(job.id) { app.jobsApi.docs(job.id) }
    val list = docs.value.orEmpty().filter { it.isSpec || it.status != "unchanged" }
    if (list.isEmpty()) return
    Text("Documents", style = MaterialTheme.typography.labelMedium, color = Palette.muted)
    list.forEach { d ->
        Text(
            (if (d.isSpec) "Spec: " else "") + d.path + if (d.status != "unchanged") "  +${d.insertions} −${d.deletions}" else "",
            color = Palette.accent,
            style = MaterialTheme.typography.bodyMedium,
            modifier = Modifier.fillMaxWidth().clickable {
                scope.launch { open(d.path, app.jobsApi.file(job.id, d.path) ?: "(unreadable)") }
            }.padding(vertical = 6.dp),
        )
    }
    HorizontalDivider(color = Palette.surfaceHigh)
}

@Composable
private fun MergePreview(app: App, job: Job, open: (String, String) -> Unit) {
    val scope = rememberCoroutineScope()
    OutlinedButton(onClick = { scope.launch { open("Diff", app.jobsApi.diff(job.id).ifEmpty { "(no changes)" }) } }) { Text("View diff") }
}
