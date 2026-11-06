package com.clauderemote.app

import android.content.Intent
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.SystemBarStyle
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.material3.Surface
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.toArgb
import com.clauderemote.app.links.Link
import com.clauderemote.app.net.Api
import com.clauderemote.app.ui.connect.ConnectScreen
import com.clauderemote.app.ui.sessions.MainScreen
import com.clauderemote.app.ui.theme.ClaudeRemoteTheme
import com.clauderemote.app.ui.theme.Palette

/** The one activity: the connect screen until a server is saved, then the main screen. */
class MainActivity : ComponentActivity() {
    private val app get() = application as App

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        if (savedInstanceState == null) takeLink(intent)
        val bar = SystemBarStyle.dark(Palette.background.toArgb())
        enableEdgeToEdge(statusBarStyle = bar, navigationBarStyle = bar)
        setContent {
            ClaudeRemoteTheme {
                Surface(Modifier.fillMaxSize(), color = Palette.background) {
                    var server by remember { mutableStateOf(app.settings.server) }
                    var lastServer by remember { mutableStateOf(server?.display ?: "") }
                    val current = server
                    if (current == null) {
                        ConnectScreen(
                            initial = lastServer,
                            api = { address -> Api(app.http) { address } },
                            onConnected = { address ->
                                app.settings.server = address
                                server = address
                                app.connectToServer(address)
                            },
                        )
                    } else {
                        MainScreen(
                            app = app,
                            onChangeServer = {
                                lastServer = current.display
                                app.connection.disconnect()
                                app.settings.server = null
                                server = null
                            },
                        )
                    }
                }
            }
        }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        takeLink(intent)
    }

    /** A notification tap or a claude-remote:// link: the main screen goes there. */
    private fun takeLink(intent: Intent?) {
        Link.parse(intent?.dataString)?.let { app.pendingLink.value = it }
    }
}
