package com.clauderemote.app.push

import android.Manifest
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat
import com.clauderemote.app.MainActivity
import com.clauderemote.app.R
import com.clauderemote.app.links.Link

/**
 * The app's notifications, one Android channel per kind so each can be muted or made
 * silent in the system settings (the server sends every event; the phone decides).
 */
object Notifications {
    const val CHANNEL_INPUT = "needs-input"
    const val CHANNEL_DONE = "completed"
    const val CHANNEL_JOBS = "jobs"
    const val CHANNEL_LAND = "land"

    fun createChannels(context: Context) {
        val nm = context.getSystemService(NotificationManager::class.java) ?: return
        nm.createNotificationChannels(
            listOf(
                NotificationChannel(CHANNEL_INPUT, "Needs input", NotificationManager.IMPORTANCE_HIGH).apply {
                    description = "Claude is waiting for you in a session"
                },
                NotificationChannel(CHANNEL_DONE, "Finished", NotificationManager.IMPORTANCE_DEFAULT).apply {
                    description = "Claude finished a turn in a session"
                },
                NotificationChannel(CHANNEL_JOBS, "Job gates", NotificationManager.IMPORTANCE_HIGH).apply {
                    description = "A pipeline job is waiting at a gate or has a question"
                },
                NotificationChannel(CHANNEL_LAND, "Land results", NotificationManager.IMPORTANCE_DEFAULT).apply {
                    description = "A track landed, or failed to"
                },
            ),
        )
    }

    fun channelFor(data: Map<String, String>): String = when (data["kind"]) {
        "session" -> if (data["event"] == "needs-input") CHANNEL_INPUT else CHANNEL_DONE
        "job" -> CHANNEL_JOBS
        else -> CHANNEL_LAND
    }

    /**
     * One notification per session, job or track: a newer event replaces the older one.
     * A Land is per track (the server's collapseKey too), so two tracks of one project
     * landing are two notifications.
     */
    fun tagFor(data: Map<String, String>): String =
        data["kind"] + ":" + (data["sessionId"] ?: data["jobId"] ?: data["track"] ?: data["projectCwd"] ?: "")

    fun show(context: Context, data: Map<String, String>) {
        if (Build.VERSION.SDK_INT >= 33 &&
            ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED
        ) return
        val link = Link.fromPush(data)
        val intent = Intent(context, MainActivity::class.java).apply {
            action = Intent.ACTION_VIEW
            link?.let { setData(Uri.parse(it.toUri())) }
            flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP
        }
        val tag = tagFor(data)
        val pending = PendingIntent.getActivity(
            context, tag.hashCode(), intent, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        val notification = NotificationCompat.Builder(context, channelFor(data))
            .setSmallIcon(R.drawable.ic_notification)
            .setContentTitle(data["title"] ?: "Claude Remote")
            .setContentText(data["body"])
            .setStyle(NotificationCompat.BigTextStyle().bigText(data["body"]))
            .setContentIntent(pending)
            .setAutoCancel(true)
            .setCategory(NotificationCompat.CATEGORY_MESSAGE)
            .build()
        NotificationManagerCompat.from(context).notify(tag, 0, notification)
    }

    /** Opening a session clears its notification. */
    fun cancel(context: Context, data: Map<String, String>) {
        NotificationManagerCompat.from(context).cancel(tagFor(data), 0)
    }
}
