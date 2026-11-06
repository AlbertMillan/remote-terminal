package com.clauderemote.app

import android.app.Application
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import android.net.NetworkRequest
import androidx.lifecycle.DefaultLifecycleObserver
import androidx.lifecycle.LifecycleOwner
import androidx.lifecycle.ProcessLifecycleOwner
import com.clauderemote.app.data.Settings
import com.clauderemote.app.net.Api
import com.clauderemote.app.net.Connection
import com.clauderemote.app.net.ServerAddress
import com.clauderemote.app.jobs.JobsApi
import com.clauderemote.app.jobs.JobsFeed
import com.clauderemote.app.links.Link
import com.clauderemote.app.protocol.AppStatePayload
import com.clauderemote.app.protocol.ClientType
import com.clauderemote.app.protocol.Protocol
import com.clauderemote.app.push.Notifications
import com.clauderemote.app.push.PushRegistrar
import com.clauderemote.app.sessions.SessionStore
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import okhttp3.OkHttpClient
import java.util.concurrent.TimeUnit

/**
 * The process-wide graph: one OkHttp client, one WebSocket, one store. A single activity
 * hosts the UI; everything long-lived hangs off here so a rotation or a trip through the
 * notification shade never reconnects.
 */
class App : Application() {
    lateinit var settings: Settings
        private set
    lateinit var connection: Connection
        private set
    lateinit var api: Api
        private set
    lateinit var sessions: SessionStore
        private set
    lateinit var jobsApi: JobsApi
        private set
    lateinit var jobsFeed: JobsFeed
        private set

    /** The main-thread scope every connection callback and store update runs on. */
    val mainScope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)

    private val _foreground = MutableStateFlow(false)
    val foreground: StateFlow<Boolean> = _foreground.asStateFlow()

    private var backgroundClose: Job? = null

    /** Where a notification tap or a link asked to go; the screen that handles it clears it. */
    val pendingLink = MutableStateFlow<Link?>(null)

    /** Text shared to the app (Android share sheet), waiting for the user to pick a session. */
    val pendingShare = MutableStateFlow<String?>(null)

    val http: OkHttpClient by lazy {
        OkHttpClient.Builder()
            .connectTimeout(8, TimeUnit.SECONDS)
            .readTimeout(30, TimeUnit.SECONDS)
            // OkHttp's own liveness check; [Connection.verify] is the fast one on resume.
            .pingInterval(20, TimeUnit.SECONDS)
            .build()
    }

    override fun onCreate() {
        super.onCreate()
        instance = this
        settings = Settings(this)
        connection = Connection(http, mainScope)
        api = Api(http) { settings.server }
        sessions = SessionStore(connection, settings, mainScope)
        jobsApi = JobsApi(api)
        jobsFeed = JobsFeed(connection)
        Notifications.createChannels(this)
        mainScope.launch {
            connection.state.collect {
                if (it is Connection.State.Connected) {
                    sendAppState()
                    PushRegistrar.sync(this@App)
                }
            }
        }
        watchLifecycle()
        watchNetwork()
    }

    /** Connect (or reconnect) to the configured server. */
    fun connectToServer(address: ServerAddress? = settings.server) {
        if (address == null) return
        connection.connect(address.ws(settings.deviceId))
    }

    private fun watchLifecycle() {
        ProcessLifecycleOwner.get().lifecycle.addObserver(object : DefaultLifecycleObserver {
            override fun onStart(owner: LifecycleOwner) {
                _foreground.value = true
                backgroundClose?.cancel()
                sendAppState()
                if (settings.server == null) return
                if (connection.state.value is Connection.State.Idle) connectToServer()
                else connection.reconnectNow()
            }

            override fun onStop(owner: LifecycleOwner) {
                _foreground.value = false
                sendAppState()
                // Hold the socket a while for a quick app switch, then let it go: Android
                // would freeze it anyway, and push covers the time away (f-cr85qn).
                backgroundClose?.cancel()
                backgroundClose = mainScope.launch {
                    delay(BACKGROUND_HOLD_MS)
                    connection.disconnect()
                }
            }
        })
    }

    /** The server skips push to this device while it is on screen. */
    private fun sendAppState() {
        connection.send(ClientType.APP_STATE, Protocol.encode(AppStatePayload(_foreground.value)))
    }

    private fun watchNetwork() {
        val cm = getSystemService(ConnectivityManager::class.java) ?: return
        val request = NetworkRequest.Builder()
            .addCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
            .build()
        cm.registerNetworkCallback(request, object : ConnectivityManager.NetworkCallback() {
            override fun onAvailable(network: Network) {
                mainScope.launch { if (_foreground.value) connection.reconnectNow() }
            }
        })
    }

    companion object {
        const val BACKGROUND_HOLD_MS = 60_000L

        lateinit var instance: App
            private set
    }
}
