package com.clauderemote.app.push

import android.os.Build
import android.util.Log
import com.clauderemote.app.App
import com.google.firebase.FirebaseApp
import com.google.firebase.messaging.FirebaseMessaging
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.jsonPrimitive

/**
 * Hands this install's FCM token to the server (POST /api/push/devices). Push is optional
 * at both ends: without google-services.json in the build there is no Firebase here, and
 * without a service account the server answers `enabled: false`. Either way the app works.
 */
object PushRegistrar {
    enum class Status { NOT_BUILT_IN, SERVER_OFF, ON, FAILED, UNKNOWN }

    private val _status = MutableStateFlow(Status.UNKNOWN)
    val status: StateFlow<Status> = _status.asStateFlow()

    fun firebaseAvailable(app: App): Boolean = FirebaseApp.getApps(app).isNotEmpty()

    /** Fetch the current token and register it; called on every connect. */
    fun sync(app: App) {
        if (!firebaseAvailable(app)) {
            _status.value = Status.NOT_BUILT_IN
            return
        }
        try {
            FirebaseMessaging.getInstance().token
                .addOnSuccessListener { token -> register(app, token) }
                .addOnFailureListener { e ->
                    Log.w("push", "no FCM token", e)
                    _status.value = Status.FAILED
                }
        } catch (e: Exception) {
            Log.w("push", "FCM unavailable", e)
            _status.value = Status.FAILED
        }
    }

    fun register(app: App, token: String) {
        if (app.settings.server == null) return
        app.mainScope.launch {
            _status.value = try {
                val body = JsonObject(
                    mapOf(
                        "deviceId" to JsonPrimitive(app.settings.deviceId),
                        "token" to JsonPrimitive(token),
                        "name" to JsonPrimitive("${Build.MANUFACTURER} ${Build.MODEL}"),
                    ),
                )
                val res = app.api.post("/api/push/devices", body) as? JsonObject
                if (res?.get("enabled")?.jsonPrimitive?.booleanOrNull == true) Status.ON else Status.SERVER_OFF
            } catch (e: Exception) {
                Log.w("push", "register failed", e)
                Status.FAILED
            }
        }
    }
}
