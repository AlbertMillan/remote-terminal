package com.clauderemote.app

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.SystemBarStyle
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.systemBarsPadding
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.toArgb
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.clauderemote.app.net.Api
import com.clauderemote.app.net.Connection
import com.clauderemote.app.ui.connect.ConnectScreen
import com.clauderemote.app.ui.connect.ConnectionBanner
import com.clauderemote.app.ui.theme.ClaudeRemoteTheme
import com.clauderemote.app.ui.theme.Palette

class MainActivity : ComponentActivity() {
    private val app get() = application as App

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val bar = SystemBarStyle.dark(Palette.background.toArgb())
        enableEdgeToEdge(statusBarStyle = bar, navigationBarStyle = bar)
        setContent {
            ClaudeRemoteTheme {
                Surface(Modifier.fillMaxSize()) {
                    var server by remember { mutableStateOf(app.settings.server) }
                    val state by app.connection.state.collectAsStateWithLifecycle()
                    if (server == null) {
                        ConnectScreen(
                            initial = "",
                            api = { address -> Api(app.http) { address } },
                            onConnected = { address ->
                                app.settings.server = address
                                server = address
                                app.connectToServer(address)
                            },
                        )
                    } else {
                        Column(Modifier.systemBarsPadding()) {
                            ConnectionBanner(state) { app.connection.reconnectNow() }
                            val who = (state as? Connection.State.Connected)?.user
                            Text(
                                if (who != null) "Connected to ${server!!.display} as ${who.displayName.ifEmpty { who.loginName }}"
                                else "Not connected to ${server!!.display}",
                                Modifier.padding(16.dp),
                            )
                        }
                    }
                }
            }
        }
    }
}
