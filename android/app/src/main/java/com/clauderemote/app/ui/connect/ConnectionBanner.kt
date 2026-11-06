package com.clauderemote.app.ui.connect

import androidx.compose.animation.AnimatedVisibility
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import com.clauderemote.app.net.Connection
import com.clauderemote.app.ui.theme.Palette
import kotlinx.coroutines.delay

/** A thin strip while not connected: why, and when the next try is. Tap to retry now. */
@Composable
fun ConnectionBanner(state: Connection.State, onRetry: () -> Unit) {
    var now by remember { mutableLongStateOf(System.currentTimeMillis()) }
    LaunchedEffect(state) {
        while (state is Connection.State.Waiting) {
            now = System.currentTimeMillis()
            delay(500)
        }
    }
    val text = when (state) {
        is Connection.State.Connected, Connection.State.Idle -> null
        is Connection.State.Connecting -> if (state.attempt <= 1) "Connecting…" else "Reconnecting…"
        is Connection.State.Waiting -> {
            val secs = ((state.retryAtMs - now) / 1000).coerceAtLeast(0)
            "${state.reason} · retrying in ${secs}s · tap to retry"
        }
    }
    AnimatedVisibility(visible = text != null) {
        Row(
            Modifier.fillMaxWidth()
                .background(if (state is Connection.State.Waiting) Palette.error.copy(alpha = 0.25f) else Palette.surfaceHigh)
                .clickable(onClick = onRetry)
                .padding(horizontal = 12.dp, vertical = 6.dp),
        ) {
            Text(text ?: "", style = MaterialTheme.typography.labelMedium, maxLines = 1)
        }
    }
}
