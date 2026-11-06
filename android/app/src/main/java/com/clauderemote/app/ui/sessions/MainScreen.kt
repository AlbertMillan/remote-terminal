package com.clauderemote.app.ui.sessions

import android.content.ClipboardManager
import android.content.Context
import android.view.KeyEvent
import androidx.activity.compose.BackHandler
import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.Orientation
import androidx.compose.foundation.gestures.draggable
import androidx.compose.foundation.gestures.rememberDraggableState
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Keyboard
import androidx.compose.material.icons.filled.Menu
import androidx.compose.material.icons.filled.MoreVert
import androidx.compose.material3.Button
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.derivedStateOf
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.min
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.clauderemote.app.App
import com.clauderemote.app.net.Connection
import com.clauderemote.app.sessions.DrawerRows
import com.clauderemote.app.ui.connect.ConnectionBanner
import com.clauderemote.app.ui.theme.Palette
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonPrimitive
import kotlin.math.roundToInt

/**
 * The terminal with the session drawer over it. The drawer panel is always composed and
 * only translated in and out, so opening it costs a 160 ms slide and no composition.
 */
@Composable
fun MainScreen(app: App, onChangeServer: () -> Unit, extraScreens: ExtraScreens = ExtraScreens()) {
    val store = app.sessions
    val state by store.state.collectAsStateWithLifecycle()
    val open by store.open.collectAsStateWithLifecycle()
    val pending by store.pending.collectAsStateWithLifecycle()
    val connection by app.connection.state.collectAsStateWithLifecycle()
    val scope = rememberCoroutineScope()
    val context = LocalContext.current
    val snackbar = remember { SnackbarHostState() }
    val handle = remember { TerminalHandle() }
    var dialog by remember { mutableStateOf<DialogSpec?>(null) }
    var ctrlOn by remember { mutableStateOf(false) }
    var fontSize by remember { mutableStateOf(app.settings.fontSizeSp) }
    var menu by remember { mutableStateOf(false) }

    LaunchedEffect(store) { store.messages.collect { snackbar.showSnackbar(it) } }

    BoxWithConstraints(Modifier.fillMaxSize().background(Palette.background)) {
        val density = LocalDensity.current
        val drawerWidth = min(maxWidth * 0.86f, 360.dp)
        val drawerPx = with(density) { drawerWidth.toPx() }
        // 0 = closed, 1 = open. Drives the panel's translation and the scrim, both read in
        // the draw/layout phase, so a slide never recomposes the terminal or the list.
        val progress = remember { Animatable(if (open == null) 1f else 0f) }
        val drawerOpen = progress.targetValue > 0.5f
        fun setDrawer(openIt: Boolean) {
            scope.launch { progress.animateTo(if (openIt) 1f else 0f, tween(160)) }
            if (openIt) handle.view?.hideSoftKeyboard()
        }

        Column(Modifier.fillMaxSize().statusBarsPadding().navigationBarsPadding().imePadding()) {
            Row(Modifier.fillMaxWidth().height(48.dp), verticalAlignment = Alignment.CenterVertically) {
                IconButton(onClick = { setDrawer(true) }) { Icon(Icons.Default.Menu, "Sessions") }
                Column(Modifier.weight(1f)) {
                    Text(open?.session?.name ?: "Claude Remote", maxLines = 1, overflow = TextOverflow.Ellipsis,
                        style = MaterialTheme.typography.titleSmall)
                    open?.session?.claudeName?.let {
                        Text(it, maxLines = 1, style = MaterialTheme.typography.labelSmall, color = Palette.muted)
                    }
                }
                if (open != null) {
                    IconButton(onClick = { handle.view?.showSoftKeyboard() }) { Icon(Icons.Default.Keyboard, "Keyboard") }
                }
                Box {
                    IconButton(onClick = { menu = true }) { Icon(Icons.Default.MoreVert, "More") }
                    DropdownMenu(expanded = menu, onDismissRequest = { menu = false }) {
                        DropdownMenuItem(text = { Text("Larger text") }, onClick = {
                            fontSize = (fontSize + 1).coerceAtMost(24); app.settings.fontSizeSp = fontSize
                        })
                        DropdownMenuItem(text = { Text("Smaller text") }, onClick = {
                            fontSize = (fontSize - 1).coerceAtLeast(7); app.settings.fontSizeSp = fontSize
                        })
                        extraScreens.menu.forEach { (label, action) ->
                            DropdownMenuItem(text = { Text(label) }, onClick = { menu = false; action() })
                        }
                        DropdownMenuItem(text = { Text("Change server") }, onClick = { menu = false; onChangeServer() })
                    }
                }
            }
            ConnectionBanner(connection) { app.connection.reconnectNow() }
            val current = open
            if (current != null) {
                TerminalPane(
                    store = store,
                    open = current,
                    handle = handle,
                    fontSizeSp = fontSize,
                    ctrlOn = ctrlOn,
                    onCtrlConsumed = { ctrlOn = false },
                    modifier = Modifier.weight(1f).fillMaxWidth(),
                )
                KeysBar(
                    ctrlOn = ctrlOn,
                    onCtrl = { ctrlOn = !ctrlOn },
                    send = { text -> store.type(text); handle.view?.scrollToBottom() },
                    key = { code -> handle.view?.onKeyDown(code, KeyEvent(KeyEvent.ACTION_DOWN, code)) },
                    onPaste = {
                        val cm = context.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
                        cm.primaryClip?.getItemAt(0)?.coerceToText(context)?.toString()?.let { store.type(it) }
                    },
                )
            } else {
                Box(Modifier.weight(1f).fillMaxWidth(), contentAlignment = Alignment.Center) {
                    Column(horizontalAlignment = Alignment.CenterHorizontally) {
                        Text(if (state.loaded) "No session open" else "Loading sessions…", color = Palette.muted)
                        Button(onClick = { setDrawer(true) }, modifier = Modifier.padding(top = 12.dp)) { Text("Sessions") }
                    }
                }
            }
        }

        // Scrim: drawn only while the drawer shows; taps on it close the drawer.
        val showScrim by remember { derivedStateOf { progress.value > 0f } }
        if (showScrim) {
            Box(
                Modifier.fillMaxSize()
                    .graphicsLayer { alpha = progress.value * 0.55f }
                    .background(androidx.compose.ui.graphics.Color.Black)
                    .clickable(interactionSource = remember { MutableInteractionSource() }, indication = null) { setDrawer(false) },
            )
        }

        val rows = remember(state, open?.session?.id) { DrawerRows.build(state, open?.session?.id) }
        val actions = remember(store) {
            DrawerActions(
                open = { s -> store.openRow(s); setDrawer(false) },
                rename = { s -> dialog = DialogSpec.Text("Rename session", s.name, "Rename") { store.rename(s.id, it) } },
                move = { s ->
                    val options = listOf("No category" to null) + store.state.value.categories.sortedBy { it.sortOrder }.map { it.name to it.id }
                    dialog = DialogSpec.Choose("Move ${s.name}", options) { store.move(s.id, it) }
                },
                fork = { s -> store.fork(s.id); setDrawer(false) },
                terminate = { s -> dialog = DialogSpec.Confirm("Terminate ${s.name}?", "Its shell is killed; a Claude conversation can be revived later.", "Terminate") { store.terminate(s.id) } },
                delete = { s -> dialog = DialogSpec.Confirm("Delete ${s.name}?", "It leaves the list; a running shell is killed.", "Delete") { store.delete(s.id) } },
                toggleCategory = { c -> store.toggleCategory(c.id, !c.collapsed) },
                renameCategory = { c -> dialog = DialogSpec.Text("Rename category", c.name, "Rename") { store.renameCategory(c.id, it) } },
                deleteCategory = { c -> dialog = DialogSpec.Confirm("Delete ${c.name}?", "Its sessions move to no category.", "Delete") { store.deleteCategory(c.id) } },
                newSession = {
                    scope.launch {
                        val recent = try {
                            (app.api.get("/api/recent-paths") as? JsonObject)?.get("paths")?.jsonArray
                                ?.mapNotNull { it.jsonPrimitive.contentOrNull }.orEmpty()
                        } catch (_: Exception) {
                            emptyList()
                        }
                        dialog = DialogSpec.NewSession(recent) { name, cwd -> store.create(name, cwd); setDrawer(false) }
                    }
                },
                newCategory = { dialog = DialogSpec.Text("New category", "", "Create") { store.createCategory(it) } },
                projects = extraScreens.projects?.let { go -> { setDrawer(false); go() } },
                history = extraScreens.history?.let { go -> { setDrawer(false); go() } },
            )
        }
        SessionDrawerContent(
            rows = rows,
            pending = pending,
            serverLabel = app.settings.server?.display ?: "",
            connected = connection is Connection.State.Connected,
            actions = actions,
            modifier = Modifier
                .width(drawerWidth)
                .offset { IntOffset(((progress.value - 1f) * drawerPx).roundToInt(), 0) }
                .statusBarsPadding()
                .draggable(
                    orientation = Orientation.Horizontal,
                    state = rememberDraggableState { delta ->
                        scope.launch { progress.snapTo((progress.value + delta / drawerPx).coerceIn(0f, 1f)) }
                    },
                    onDragStopped = { velocity -> setDrawer(velocity > 300f || (velocity > -300f && progress.value > 0.5f)) },
                ),
        )

        BackHandler(enabled = drawerOpen && open != null) { setDrawer(false) }
        SnackbarHost(snackbar, Modifier.align(Alignment.BottomCenter).navigationBarsPadding().padding(bottom = 56.dp))
        dialog?.let { spec -> ShowDialog(spec) { dialog = null } }

        // A session opening (picked, created, revived) closes the drawer; none open opens it.
        LaunchedEffect(open?.session?.id) {
            if (open != null) setDrawer(false)
        }
    }
}

/** Screens later features hang off the main screen (projects, history). */
class ExtraScreens(
    val projects: (() -> Unit)? = null,
    val history: (() -> Unit)? = null,
    val menu: List<Pair<String, () -> Unit>> = emptyList(),
)
