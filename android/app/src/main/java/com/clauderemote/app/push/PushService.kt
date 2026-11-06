package com.clauderemote.app.push

import com.clauderemote.app.App
import com.google.firebase.messaging.FirebaseMessagingService
import com.google.firebase.messaging.RemoteMessage

/**
 * Receives the server's data-only pushes (src/server/push/push.ts) and shows them. The
 * server already skips a device that said it is in the foreground; one that arrives in the
 * race while the app is on screen is dropped, since the app shows the event itself.
 */
class PushService : FirebaseMessagingService() {
    override fun onNewToken(token: String) {
        (application as? App)?.let { PushRegistrar.register(it, token) }
    }

    override fun onMessageReceived(message: RemoteMessage) {
        val app = application as? App
        if (app?.foreground?.value == true) return
        Notifications.show(this, message.data)
    }
}
