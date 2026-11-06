package com.clauderemote.app.ui.theme

import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color

object Palette {
    val background = Color(0xFF16161E)
    val surface = Color(0xFF1E1E28)
    val surfaceHigh = Color(0xFF282834)
    val accent = Color(0xFFD97757)
    val text = Color(0xFFE6E6E6)
    val muted = Color(0xFF9A9AA8)
    val ok = Color(0xFF6CC28A)
    val warn = Color(0xFFE5B85C)
    val error = Color(0xFFE5707A)
}

private val colors = darkColorScheme(
    primary = Palette.accent,
    onPrimary = Color(0xFF1A0E09),
    secondary = Palette.accent,
    background = Palette.background,
    onBackground = Palette.text,
    surface = Palette.surface,
    onSurface = Palette.text,
    surfaceVariant = Palette.surfaceHigh,
    onSurfaceVariant = Palette.muted,
    surfaceContainer = Palette.surface,
    surfaceContainerHigh = Palette.surfaceHigh,
    surfaceContainerHighest = Palette.surfaceHigh,
    surfaceContainerLow = Palette.background,
    error = Palette.error,
)

@Composable
fun ClaudeRemoteTheme(content: @Composable () -> Unit) {
    MaterialTheme(colorScheme = colors, content = content)
}
