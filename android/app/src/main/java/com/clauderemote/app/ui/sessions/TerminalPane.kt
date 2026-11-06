package com.clauderemote.app.ui.sessions

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.view.KeyEvent
import androidx.compose.foundation.background
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.KeyboardArrowLeft
import androidx.compose.material.icons.automirrored.filled.KeyboardArrowRight
import androidx.compose.material.icons.filled.KeyboardArrowDown
import androidx.compose.material.icons.filled.KeyboardArrowUp
import androidx.compose.material.icons.filled.KeyboardDoubleArrowDown
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.SmallFloatingActionButton
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import com.clauderemote.app.sessions.SessionStore
import com.clauderemote.app.ui.theme.Palette
import com.termux.view.TerminalView

/** The terminal view's handle for the keys bar and the menu (keyboard, Ctrl, text size). */
class TerminalHandle {
    var view: TerminalView? = null
}

/**
 * The native terminal (Termux's view in an AndroidView): its scrolling and fling are the
 * View system's own, never Compose's, and its redraws never recompose anything.
 */
@Composable
fun TerminalPane(
    store: SessionStore,
    open: SessionStore.Open,
    handle: TerminalHandle,
    fontSizeSp: Int,
    ctrlOn: Boolean,
    onCtrlUsed: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val context = LocalContext.current
    var selection by remember { mutableStateOf(false) }
    var atBottom by remember { mutableStateOf(true) }

    Box(modifier) {
        AndroidView(
            modifier = Modifier.fillMaxSize(),
            factory = { ctx ->
                TerminalView(ctx).apply {
                    val side = (2 * resources.displayMetrics.density).toInt()
                    setPadding(side, 0, side, 0)
                    setTerminalViewClient(object : TerminalView.TerminalViewClient {
                        override fun onTerminalSizeChanged(columns: Int, rows: Int) = store.onViewSize(columns, rows)
                        override fun onSelectionChanged(hasSelection: Boolean) { selection = hasSelection }
                        override fun onCtrlConsumed() = onCtrlUsed()
                        override fun onScrolledToBottomChanged(bottom: Boolean) { atBottom = bottom }
                    })
                    handle.view = this
                }
            },
            update = { view ->
                view.setCtrlDown(ctrlOn)
                if (view.session !== open.terminal) {
                    view.attachSession(open.terminal)
                    store.onViewSize(view.calculateColumns(), view.calculateRows())
                }
                // The setting is named in sp; the view takes dp, which a 1.0 font scale equates.
                val textSize = fontSizeSp.toFloat()
                if (view.tag != textSize) {
                    view.tag = textSize
                    view.setTextSizeDp(textSize)
                }
            },
        )
        if (!atBottom) {
            SmallFloatingActionButton(
                onClick = { handle.view?.scrollToBottom() },
                modifier = Modifier.align(Alignment.BottomEnd).padding(12.dp),
                containerColor = Palette.surfaceHigh,
            ) { Icon(Icons.Default.KeyboardDoubleArrowDown, "Scroll to bottom") }
        }
        if (selection) {
            Row(
                Modifier.align(Alignment.TopCenter).padding(8.dp)
                    .background(Palette.surfaceHigh, RoundedCornerShape(8.dp)),
            ) {
                TextButton(onClick = {
                    handle.view?.selectedText?.let { text ->
                        val cm = context.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
                        cm.setPrimaryClip(ClipData.newPlainText("terminal", text))
                    }
                    handle.view?.clearSelection()
                    selection = false
                }) { Text("Copy") }
                TextButton(onClick = { handle.view?.clearSelection(); selection = false }) { Text("Cancel") }
            }
        }
    }

    DisposableEffect(store) {
        store.onScreenUpdated = { handle.view?.onScreenUpdated() }
        store.onClipboard = { text ->
            val cm = context.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
            cm.setPrimaryClip(ClipData.newPlainText("terminal", text))
        }
        onDispose {
            store.onScreenUpdated = null
            store.onClipboard = null
            handle.view = null
        }
    }
}

/**
 * The keys a phone keyboard lacks. Ctrl is sticky: it applies to the next key typed,
 * on this bar or the keyboard, then turns itself off.
 */
@Composable
fun KeysBar(
    ctrlOn: Boolean,
    onCtrl: () -> Unit,
    send: (String) -> Unit,
    key: (Int) -> Unit,
    onPaste: () -> Unit,
    modifier: Modifier = Modifier,
) {
    Surface(color = Palette.surface, modifier = modifier.fillMaxWidth()) {
        Row(
            Modifier.horizontalScroll(rememberScrollState()).height(44.dp).padding(horizontal = 4.dp),
            horizontalArrangement = Arrangement.spacedBy(2.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            // Keys go through the view, so the arrows follow the cursor-key mode and Ctrl applies.
            KeyButton("Esc") { key(KeyEvent.KEYCODE_ESCAPE) }
            KeyButton("Tab") { key(KeyEvent.KEYCODE_TAB) }
            KeyButton("⇧Tab") { send("\u001b[Z") }
            KeyButton("Ctrl", highlighted = ctrlOn, onClick = onCtrl)
            KeyIcon(Icons.AutoMirrored.Filled.KeyboardArrowLeft, "Left") { key(KeyEvent.KEYCODE_DPAD_LEFT) }
            KeyIcon(Icons.Default.KeyboardArrowUp, "Up") { key(KeyEvent.KEYCODE_DPAD_UP) }
            KeyIcon(Icons.Default.KeyboardArrowDown, "Down") { key(KeyEvent.KEYCODE_DPAD_DOWN) }
            KeyIcon(Icons.AutoMirrored.Filled.KeyboardArrowRight, "Right") { key(KeyEvent.KEYCODE_DPAD_RIGHT) }
            KeyButton("/") { send("/") }
            KeyButton("^C") { send("\u0003") }
            KeyButton("Paste", onClick = onPaste)
        }
    }
}

@Composable
private fun KeyButton(label: String, highlighted: Boolean = false, onClick: () -> Unit) {
    TextButton(
        onClick = onClick,
        modifier = Modifier.height(40.dp),
        shape = RoundedCornerShape(6.dp),
        colors = androidx.compose.material3.ButtonDefaults.textButtonColors(
            containerColor = if (highlighted) Palette.accent else Color.Transparent,
            contentColor = if (highlighted) Color.Black else Palette.text,
        ),
    ) { Text(label, style = MaterialTheme.typography.labelLarge) }
}

@Composable
private fun KeyIcon(icon: ImageVector, description: String, onClick: () -> Unit) {
    TextButton(onClick = onClick, modifier = Modifier.height(40.dp), shape = RoundedCornerShape(6.dp)) {
        Icon(icon, description, tint = Palette.text)
    }
}
