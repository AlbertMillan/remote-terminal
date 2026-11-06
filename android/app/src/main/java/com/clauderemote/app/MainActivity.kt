package com.clauderemote.app

import android.content.Intent
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.SystemBarStyle
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.LaunchedEffect
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.clauderemote.app.ui.history.HistoryScreen
import com.clauderemote.app.ui.projects.JobScreen
import com.clauderemote.app.ui.projects.ProjectScreen
import com.clauderemote.app.ui.projects.ProjectsScreen
import com.clauderemote.app.ui.sessions.ExtraScreens
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

/** Pages over the main screen. */
sealed interface Screen {
    data object Projects : Screen
    data class Project(val cwd: String) : Screen
    data class Job(val jobId: String) : Screen
    data object History : Screen
}

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
                        // Pages stack over the main screen, which stays composed underneath so
                        // the terminal and the drawer are there, as they were, on the way back.
                        var stack by remember { mutableStateOf(listOf<Screen>()) }
                        fun push(screen: Screen) { stack = stack + screen }
                        fun pop() { stack = stack.dropLast(1) }
                        val link by app.pendingLink.collectAsStateWithLifecycle()
                        LaunchedEffect(link) {
                            when (val target = link) {
                                is Link.Job -> { app.pendingLink.value = null; push(Screen.Job(target.jobId)) }
                                is Link.Project -> { app.pendingLink.value = null; push(Screen.Project(target.cwd)) }
                                is Link.Session -> stack = emptyList()
                                null -> Unit
                            }
                        }
                        Box(Modifier.fillMaxSize()) {
                            MainScreen(
                                app = app,
                                onChangeServer = {
                                    lastServer = current.display
                                    app.connection.disconnect()
                                    app.settings.server = null
                                    server = null
                                },
                                extraScreens = remember {
                                    ExtraScreens(
                                        projects = { push(Screen.Projects) },
                                        history = { push(Screen.History) },
                                    )
                                },
                            )
                            when (val top = stack.lastOrNull()) {
                                Screen.Projects -> ProjectsScreen(app, ::pop, openProject = { push(Screen.Project(it)) }, openJob = { push(Screen.Job(it)) })
                                is Screen.Project -> ProjectScreen(app, top.cwd, ::pop, openJob = { push(Screen.Job(it)) })
                                is Screen.Job -> JobScreen(app, top.jobId, ::pop, openProject = { push(Screen.Project(it)) })
                                Screen.History -> HistoryScreen(app, ::pop) { stack = emptyList() }
                                null -> Unit
                            }
                        }
                    }
                }
            }
        }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        takeLink(intent)
    }

    /** A notification tap, a claude-remote:// link, or text shared from another app. */
    private fun takeLink(intent: Intent?) {
        if (intent?.action == Intent.ACTION_SEND) {
            val text = listOfNotNull(intent.getStringExtra(Intent.EXTRA_SUBJECT), intent.getStringExtra(Intent.EXTRA_TEXT))
                .filter { it.isNotBlank() }
                .distinct()
                .joinToString("\n")
            if (text.isNotBlank()) app.pendingShare.value = text
            return
        }
        Link.parse(intent?.dataString)?.let { app.pendingLink.value = it }
    }
}
