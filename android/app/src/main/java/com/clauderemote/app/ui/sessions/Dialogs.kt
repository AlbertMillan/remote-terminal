package com.clauderemote.app.ui.sessions

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.clauderemote.app.ui.theme.Palette

/** The one dialog the main screen may show at a time. */
sealed interface DialogSpec {
    data class Text(val title: String, val initial: String, val confirm: String, val onConfirm: (String) -> Unit) : DialogSpec
    data class Confirm(val title: String, val body: String, val confirm: String, val onConfirm: () -> Unit) : DialogSpec
    data class Choose(val title: String, val options: List<Pair<String, String?>>, val onChoose: (String?) -> Unit) : DialogSpec
    data class NewSession(val recentPaths: List<String>, val onCreate: (name: String, cwd: String) -> Unit) : DialogSpec
}

@Composable
fun ShowDialog(spec: DialogSpec, onDismiss: () -> Unit) {
    when (spec) {
        is DialogSpec.Text -> TextDialog(spec, onDismiss)
        is DialogSpec.Confirm -> AlertDialog(
            onDismissRequest = onDismiss,
            title = { Text(spec.title) },
            text = { Text(spec.body) },
            confirmButton = { TextButton(onClick = { onDismiss(); spec.onConfirm() }) { Text(spec.confirm) } },
            dismissButton = { TextButton(onClick = onDismiss) { Text("Cancel") } },
        )
        is DialogSpec.Choose -> AlertDialog(
            onDismissRequest = onDismiss,
            title = { Text(spec.title) },
            text = {
                LazyColumn(Modifier.heightIn(max = 360.dp)) {
                    items(spec.options) { (label, value) ->
                        Text(label, modifier = Modifier.fillMaxWidth().clickable { onDismiss(); spec.onChoose(value) }.padding(vertical = 12.dp))
                    }
                }
            },
            confirmButton = {},
            dismissButton = { TextButton(onClick = onDismiss) { Text("Cancel") } },
        )
        is DialogSpec.NewSession -> NewSessionDialog(spec, onDismiss)
    }
}

@Composable
private fun TextDialog(spec: DialogSpec.Text, onDismiss: () -> Unit) {
    var value by remember { mutableStateOf(spec.initial) }
    val focus = remember { FocusRequester() }
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(spec.title) },
        text = {
            OutlinedTextField(value, { value = it }, singleLine = true, modifier = Modifier.fillMaxWidth().focusRequester(focus))
        },
        confirmButton = {
            TextButton(enabled = value.isNotBlank(), onClick = { onDismiss(); spec.onConfirm(value.trim()) }) { Text(spec.confirm) }
        },
        dismissButton = { TextButton(onClick = onDismiss) { Text("Cancel") } },
    )
    LaunchedEffect(Unit) { focus.requestFocus() }
}

@Composable
private fun NewSessionDialog(spec: DialogSpec.NewSession, onDismiss: () -> Unit) {
    var name by remember { mutableStateOf("") }
    var cwd by remember { mutableStateOf("") }
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("New session") },
        text = {
            Column {
                OutlinedTextField(name, { name = it }, label = { Text("Name (optional)") }, singleLine = true, modifier = Modifier.fillMaxWidth())
                OutlinedTextField(
                    cwd, { cwd = it }, label = { Text("Folder (optional)") }, singleLine = true,
                    keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Uri, autoCorrectEnabled = false),
                    modifier = Modifier.fillMaxWidth().padding(top = 8.dp),
                )
                if (spec.recentPaths.isNotEmpty()) {
                    Text("Recent", style = MaterialTheme.typography.labelSmall, color = Palette.muted, modifier = Modifier.padding(top = 12.dp, bottom = 4.dp))
                    LazyColumn(Modifier.heightIn(max = 220.dp)) {
                        items(spec.recentPaths) { path ->
                            Text(
                                path, maxLines = 1, overflow = TextOverflow.Ellipsis,
                                style = MaterialTheme.typography.bodySmall,
                                color = if (path == cwd) Palette.accent else Palette.text,
                                modifier = Modifier.fillMaxWidth().clickable { cwd = path }.padding(vertical = 8.dp),
                            )
                        }
                    }
                }
            }
        },
        confirmButton = { TextButton(onClick = { onDismiss(); spec.onCreate(name.trim(), cwd.trim()) }) { Text("Start") } },
        dismissButton = { TextButton(onClick = onDismiss) { Text("Cancel") } },
    )
}
