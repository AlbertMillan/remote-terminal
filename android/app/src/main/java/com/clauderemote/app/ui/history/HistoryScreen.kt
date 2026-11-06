package com.clauderemote.app.ui.history

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.clauderemote.app.App
import com.clauderemote.app.protocol.Protocol
import com.clauderemote.app.ui.common.LoadingOrError
import com.clauderemote.app.ui.common.Page
import com.clauderemote.app.ui.common.rememberLoaded
import com.clauderemote.app.ui.theme.Palette
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonElement

@Serializable
data class LogMeta(
    val date: String? = null,
    val session: String? = null,
    val branch: String? = null,
    val claudeSessionId: String? = null,
    val account: String? = null,
)

@Serializable
data class LogEntry(val meta: LogMeta? = null, val body: String = "")

@Serializable
data class LogProject(val cwd: String, val name: String, val entries: List<LogEntry> = emptyList())

@Serializable
data class LogBoard(val projects: List<LogProject> = emptyList())

/** One resumable conversation from a project's SESSION-LOG.md. */
data class HistoryItem(
    val cwd: String,
    val project: String,
    val claudeSessionId: String,
    val account: String?,
    val title: String,
    val date: String,
    val summary: String,
)

object History {
    /**
     * Every log entry that names a Claude conversation, newest first. The summary is the
     * entry's "Done:" line, as the web history card leads with it.
     */
    fun items(board: LogBoard): List<HistoryItem> =
        board.projects.flatMap { p ->
            p.entries.mapNotNull { e ->
                val sid = e.meta?.claudeSessionId ?: return@mapNotNull null
                HistoryItem(
                    cwd = p.cwd,
                    project = p.name,
                    claudeSessionId = sid,
                    account = e.meta.account,
                    title = e.meta.session ?: sid.take(8),
                    date = e.meta.date ?: "",
                    summary = summaryOf(e.body),
                )
            }
        }.sortedByDescending { it.date }

    fun summaryOf(body: String): String {
        val done = body.lineSequence().firstOrNull { it.startsWith("**Done:**") }
        return (done ?: body.lineSequence().firstOrNull { it.isNotBlank() && !it.startsWith("<!--") && !it.startsWith("#") } ?: "")
            .removePrefix("**Done:**").replace("**", "").replace("`", "").trim()
    }
}

/** Session history across projects: Resume continues a conversation, Fork copies it first. */
@Composable
fun HistoryScreen(app: App, onBack: () -> Unit, onOpened: () -> Unit) {
    val loaded = rememberLoaded(Unit) {
        Protocol.json.decodeFromJsonElement(LogBoard.serializer(), app.api.get("/api/project-logs") as JsonElement)
    }
    var filter by remember { mutableStateOf("") }
    Page("History", onBack = onBack) {
        OutlinedTextField(
            value = filter,
            onValueChange = { filter = it },
            placeholder = { Text("Filter by project or session") },
            singleLine = true,
            keyboardOptions = KeyboardOptions(imeAction = ImeAction.Search),
            modifier = Modifier.fillMaxWidth().padding(horizontal = 12.dp),
        )
        val board = loaded.value
        if (board == null) {
            LoadingOrError(loaded)
            return@Page
        }
        val items = remember(board) { History.items(board) }
        val shown = if (filter.isBlank()) items else items.filter {
            it.project.contains(filter, true) || it.title.contains(filter, true) || it.summary.contains(filter, true)
        }
        LazyColumn(Modifier.fillMaxWidth().weight(1f)) {
            if (shown.isEmpty()) item { Text("No resumable sessions.", color = Palette.muted, modifier = Modifier.padding(16.dp)) }
            items(shown, key = { it.cwd + it.claudeSessionId + it.date }) { h ->
                Column(Modifier.fillMaxWidth().padding(start = 16.dp, end = 8.dp, top = 10.dp)) {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Column(Modifier.weight(1f)) {
                            Text(h.title, fontWeight = FontWeight.Medium, maxLines = 1, overflow = TextOverflow.Ellipsis)
                            Text("${h.project} · ${h.date.take(10)}" + (h.account?.let { " · $it" } ?: ""),
                                style = MaterialTheme.typography.labelSmall, color = Palette.muted)
                        }
                        TextButton(onClick = { app.sessions.openFromHistory(h.claudeSessionId, h.cwd, "resume", h.account); onOpened() }) { Text("Resume") }
                        TextButton(onClick = { app.sessions.openFromHistory(h.claudeSessionId, h.cwd, "fork", h.account); onOpened() }) { Text("Fork") }
                    }
                    if (h.summary.isNotEmpty()) {
                        Text(h.summary, style = MaterialTheme.typography.bodySmall, color = Palette.muted, maxLines = 3, overflow = TextOverflow.Ellipsis)
                    }
                    HorizontalDivider(color = Palette.surfaceHigh, modifier = Modifier.padding(top = 10.dp))
                }
            }
        }
    }
}

