package com.clauderemote.app.ui.sessions

import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.background
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.CreateNewFolder
import androidx.compose.material.icons.filled.ExpandLess
import androidx.compose.material.icons.filled.ExpandMore
import androidx.compose.material.icons.filled.History
import androidx.compose.material.icons.filled.ViewKanban
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.clauderemote.app.protocol.CategoryInfo
import com.clauderemote.app.protocol.SessionInfo
import com.clauderemote.app.sessions.DrawerRow
import com.clauderemote.app.ui.theme.Palette

/** What a drawer row can ask for; one object so rows stay skippable. */
@Immutable
class DrawerActions(
    val open: (SessionInfo) -> Unit,
    val rename: (SessionInfo) -> Unit,
    val move: (SessionInfo) -> Unit,
    val fork: (SessionInfo) -> Unit,
    val copyLink: (SessionInfo) -> Unit,
    val terminate: (SessionInfo) -> Unit,
    val delete: (SessionInfo) -> Unit,
    val toggleCategory: (CategoryInfo) -> Unit,
    val renameCategory: (CategoryInfo) -> Unit,
    val deleteCategory: (CategoryInfo) -> Unit,
    val newSession: () -> Unit,
    val newCategory: () -> Unit,
    val projects: (() -> Unit)? = null,
    val history: (() -> Unit)? = null,
)

/**
 * The session list. A LazyColumn with stable keys: native fling, and a change to one row
 * recomposes only that row. It is composed once and kept, so opening the drawer is a
 * translation, never a rebuild.
 */
@Composable
fun SessionDrawerContent(
    rows: List<DrawerRow>,
    pending: String?,
    serverLabel: String,
    connected: Boolean,
    actions: DrawerActions,
    modifier: Modifier = Modifier,
) {
    Column(modifier.fillMaxHeight().background(Palette.surface)) {
        Row(Modifier.fillMaxWidth().padding(start = 16.dp, end = 4.dp, top = 8.dp, bottom = 4.dp), verticalAlignment = Alignment.CenterVertically) {
            Box(Modifier.size(8.dp).background(if (connected) Palette.ok else Palette.error, CircleShape))
            Spacer(Modifier.width(8.dp))
            Text(serverLabel, style = MaterialTheme.typography.labelMedium, color = Palette.muted, maxLines = 1,
                overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
            actions.projects?.let { IconButton(onClick = it) { Icon(Icons.Default.ViewKanban, "Projects") } }
            actions.history?.let { IconButton(onClick = it) { Icon(Icons.Default.History, "History") } }
            IconButton(onClick = actions.newCategory) { Icon(Icons.Default.CreateNewFolder, "New category") }
            IconButton(onClick = actions.newSession) { Icon(Icons.Default.Add, "New session") }
        }
        HorizontalDivider(color = Palette.surfaceHigh)
        if (rows.isEmpty()) {
            Text("No sessions yet. + starts one.", color = Palette.muted, modifier = Modifier.padding(16.dp))
        }
        val listState = rememberLazyListState()
        LazyColumn(state = listState, modifier = Modifier.fillMaxWidth().weight(1f)) {
            items(rows, key = { it.key }, contentType = { it::class }) { row ->
                when (row) {
                    is DrawerRow.Category -> CategoryHeader(row, actions)
                    is DrawerRow.Session -> SessionRow(row, row.session.id == pending, actions)
                }
            }
        }
    }
}

@OptIn(ExperimentalFoundationApi::class)
@Composable
private fun CategoryHeader(row: DrawerRow.Category, actions: DrawerActions) {
    val category = row.category ?: return
    var menu by remember { mutableStateOf(false) }
    Box {
        Row(
            Modifier.fillMaxWidth()
                .combinedClickable(onClick = { actions.toggleCategory(category) }, onLongClick = { menu = true })
                .padding(start = 16.dp, end = 16.dp, top = 12.dp, bottom = 6.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text(category.name.uppercase(), style = MaterialTheme.typography.labelSmall, color = Palette.muted,
                fontWeight = FontWeight.SemiBold, modifier = Modifier.weight(1f))
            Text("${row.count}", style = MaterialTheme.typography.labelSmall, color = Palette.muted)
            Icon(if (category.collapsed) Icons.Default.ExpandMore else Icons.Default.ExpandLess, null,
                tint = Palette.muted, modifier = Modifier.size(18.dp))
        }
        DropdownMenu(expanded = menu, onDismissRequest = { menu = false }) {
            DropdownMenuItem(text = { Text("Rename") }, onClick = { menu = false; actions.renameCategory(category) })
            DropdownMenuItem(text = { Text("Delete") }, onClick = { menu = false; actions.deleteCategory(category) })
        }
    }
}

@OptIn(ExperimentalFoundationApi::class)
@Composable
private fun SessionRow(row: DrawerRow.Session, pending: Boolean, actions: DrawerActions) {
    val s = row.session
    var menu by remember { mutableStateOf(false) }
    val live = s.attachable && s.status != "terminated"
    Box {
        Row(
            Modifier.fillMaxWidth()
                .background(if (row.current) Palette.surfaceHigh else Color.Transparent)
                .combinedClickable(onClick = { actions.open(s) }, onLongClick = { menu = true })
                .padding(start = (16 + 14 * row.depth).dp, end = 12.dp, top = 9.dp, bottom = 9.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            val dot = when {
                row.notice == "needs-input" -> Palette.warn
                live -> Palette.ok
                else -> Palette.muted.copy(alpha = 0.5f)
            }
            Box(Modifier.size(8.dp).background(dot, CircleShape))
            Column(Modifier.weight(1f)) {
                Text(
                    s.name,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                    color = if (live) Palette.text else Palette.muted,
                    fontWeight = if (row.current) FontWeight.SemiBold else FontWeight.Normal,
                )
                val sub = listOfNotNull(
                    s.claudeName,
                    if (s.access == "read") "read-only" else null,
                    if (!live) (if (s.revivable) "tap to revive" else "ended") else null,
                    s.accountWarning,
                ).joinToString(" · ").ifEmpty { s.cwd.substringAfterLast('\\').substringAfterLast('/') }
                Text(sub, style = MaterialTheme.typography.bodySmall, color = Palette.muted, maxLines = 1, overflow = TextOverflow.Ellipsis)
            }
            if (pending) CircularProgressIndicator(Modifier.size(16.dp), strokeWidth = 2.dp)
            else if (row.notice == "needs-input") Text("input", style = MaterialTheme.typography.labelSmall, color = Palette.warn)
        }
        DropdownMenu(expanded = menu, onDismissRequest = { menu = false }) {
            DropdownMenuItem(text = { Text("Rename") }, onClick = { menu = false; actions.rename(s) })
            DropdownMenuItem(text = { Text("Move to category") }, onClick = { menu = false; actions.move(s) })
            if (s.claudeSessionId != null) {
                DropdownMenuItem(text = { Text("Fork") }, onClick = { menu = false; actions.fork(s) })
            }
            DropdownMenuItem(text = { Text("Copy link") }, onClick = { menu = false; actions.copyLink(s) })
            if (live) DropdownMenuItem(text = { Text("Terminate") }, onClick = { menu = false; actions.terminate(s) })
            DropdownMenuItem(text = { Text("Delete") }, onClick = { menu = false; actions.delete(s) })
        }
    }
}
