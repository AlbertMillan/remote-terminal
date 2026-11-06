package com.clauderemote.app.ui.connect

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.systemBarsPadding
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import com.clauderemote.app.net.Api
import com.clauderemote.app.net.ServerAddress
import com.clauderemote.app.ui.theme.Palette
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonPrimitive

/**
 * Enter the server once: its MagicDNS name or tailnet IP (port 4220 unless given). The
 * address is checked against /health before it is saved, so a typo says so here instead of
 * as an endless reconnect.
 */
@Composable
fun ConnectScreen(
    initial: String,
    api: (ServerAddress) -> Api,
    onConnected: (ServerAddress) -> Unit,
) {
    var text by remember { mutableStateOf(initial) }
    var error by remember { mutableStateOf<String?>(null) }
    var busy by remember { mutableStateOf(false) }
    val scope = rememberCoroutineScope()

    fun submit() {
        val address = ServerAddress.parse(text)
        if (address == null) {
            error = "Enter a host name or IP, e.g. my-pc or my-pc.tailnet.ts.net:4220"
            return
        }
        busy = true
        error = null
        scope.launch {
            try {
                val health = api(address).get("/health") as? JsonObject
                val status = health?.get("status")?.jsonPrimitive?.contentOrNull
                if (status == "ok") onConnected(address)
                else error = "${address.display} answered, but not as claude-remote"
            } catch (e: Exception) {
                error = "Can't reach ${address.display}: ${e.message ?: e.javaClass.simpleName}"
            } finally {
                busy = false
            }
        }
    }

    Column(
        Modifier.fillMaxSize().systemBarsPadding().imePadding().padding(24.dp),
        verticalArrangement = Arrangement.spacedBy(16.dp, androidx.compose.ui.Alignment.CenterVertically),
    ) {
        Text("Claude Remote", style = MaterialTheme.typography.headlineMedium)
        Text(
            "Your server's MagicDNS name or tailnet IP. Plain http over Tailscale; the server " +
                "checks who you are with tailscale whois.",
            color = Palette.muted,
            style = MaterialTheme.typography.bodyMedium,
        )
        OutlinedTextField(
            value = text,
            onValueChange = { text = it; error = null },
            label = { Text("Server") },
            placeholder = { Text("my-pc.tailnet.ts.net") },
            singleLine = true,
            isError = error != null,
            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Uri, imeAction = ImeAction.Go, autoCorrectEnabled = false),
            keyboardActions = KeyboardActions(onGo = { if (!busy) submit() }),
            modifier = Modifier.fillMaxWidth(),
        )
        error?.let { Text(it, color = Palette.error, style = MaterialTheme.typography.bodySmall) }
        Button(onClick = { submit() }, enabled = !busy, modifier = Modifier.fillMaxWidth()) {
            if (busy) CircularProgressIndicator(Modifier.padding(2.dp), strokeWidth = 2.dp)
            else Text("Connect")
        }
    }
}
