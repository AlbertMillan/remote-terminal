package com.clauderemote.app.ui.projects

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.clauderemote.app.App
import com.clauderemote.app.jobs.JobsFeed
import com.clauderemote.app.ui.common.Chip
import com.clauderemote.app.ui.common.Page
import com.clauderemote.app.ui.theme.Palette
import kotlinx.coroutines.launch

/**
 * One factory unit, live from `factory.summary`: where it is, why it waits, a track's
 * features, its merge entry and tokens. A parked unit can be approved (a review it stopped
 * at) or released for another round; everything else is the web board's.
 */
@Composable
fun FactoryUnitScreen(app: App, key: String, onBack: () -> Unit) {
    val factory by app.jobsFeed.factory.collectAsStateWithLifecycle()
    val unit = factory?.units?.firstOrNull { it.key == key }
    val merge = unit?.mergeId?.let { id -> factory?.merges?.firstOrNull { it.id == id } }
    val scope = rememberCoroutineScope()
    var busy by remember { mutableStateOf(false) }
    var message by remember { mutableStateOf<String?>(null) }

    fun release(outcome: String?) {
        val u = unit ?: return
        if (busy) return
        busy = true
        message = null
        scope.launch {
            try {
                app.jobsApi.releaseFactory(u.projectCwd, u.featureIds.first(), outcome)
            } catch (e: Exception) {
                message = "Failed: ${e.message}"
            } finally {
                busy = false
            }
        }
    }

    Page(unit?.title ?: "Factory", subtitle = unit?.projectName, onBack = onBack) {
        if (unit == null) {
            Text("This unit is no longer in the factory feed.", color = Palette.muted, modifier = Modifier.padding(16.dp))
            return@Page
        }
        Column(
            Modifier.fillMaxWidth().weight(1f).verticalScroll(rememberScrollState()).padding(16.dp),
            verticalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
                Chip(JobsFeed.unitLabel(unit), unitColor(unit))
                Text(if (unit.isTrack) "track" else unit.unitId, style = MaterialTheme.typography.labelSmall, color = Palette.muted)
                unit.modelTier?.let { Text(it, style = MaterialTheme.typography.labelSmall, color = Palette.muted) }
            }
            unit.stalled?.let { Text("Stalled: $it", color = Palette.warn) }
            unit.reason?.let { Text(it) }
            if (unit.waitsFor.isNotEmpty()) Text("Waits for ${unit.waitsFor.joinToString(", ")}", color = Palette.muted)
            if (unit.features.isNotEmpty()) {
                Text("Features, in order", fontWeight = FontWeight.SemiBold)
                unit.features.forEach { f ->
                    val mark = when (f.state) {
                        "done" -> "✓"
                        "now" -> "◐"
                        else -> "○"
                    }
                    Text("$mark ${f.title}", fontWeight = if (f.state == "now") FontWeight.SemiBold else FontWeight.Normal)
                }
            }
            merge?.let { m ->
                Text("Merge: ${m.status}", fontWeight = FontWeight.SemiBold)
                m.detail?.let { Text(it, color = Palette.muted) }
                if (m.conflictPaths.isNotEmpty()) Text("Conflicts: ${m.conflictPaths.joinToString(", ")}", color = Palette.warn)
            }
            Text("Tokens: ${"%,d".format(unit.tokens)}", style = MaterialTheme.typography.bodySmall, color = Palette.muted)
            message?.let { Text(it, color = Palette.error) }
            if (JobsFeed.canRelease(unit)) {
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    if (unit.column == "review") {
                        Button(onClick = { release("approved") }, enabled = !busy) { Text("Approve") }
                    }
                    OutlinedButton(onClick = { release(null) }, enabled = !busy) { Text("Release for another round") }
                }
                Text(
                    "Request changes, answers and triage are on the web board.",
                    style = MaterialTheme.typography.bodySmall, color = Palette.muted,
                )
            }
        }
    }
}
