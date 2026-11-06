package com.clauderemote.app.protocol

import kotlinx.serialization.KSerializer
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.serializer

/*
 * The /ws protocol, mirroring src/server/websocket/protocol.ts. The server is the source of
 * truth: a type or field added there must be added here too. ProtocolFixtureTest decodes every
 * message of tests/fixtures/protocol/messages.json strictly (unknown keys fail) through
 * [Protocol.clientPayloads] / [Protocol.serverPayloads], and the server's
 * tests/protocol-fixture.test.ts keeps that fixture in step with protocol.ts.
 * docs/android-app.md
 */

@Serializable
data class Envelope(val type: String, val id: String? = null, val payload: JsonElement? = null)

// ---- Shared shapes ----

@Serializable
data class SessionInfo(
    val id: String,
    val name: String,
    val shell: String,
    val cwd: String,
    val createdAt: String,
    val lastAccessedAt: String,
    val status: String,
    val cols: Int,
    val rows: Int,
    val attachable: Boolean,
    val categoryId: String?,
    val sortOrder: Int,
    val isFork: Boolean,
    val claudeSessionId: String?,
    val spawnedBy: String?,
    val permissionMode: String?,
    val access: String? = null,
    val claudeName: String?,
    val account: String,
    val accountWarning: String?,
    val revivable: Boolean,
)

@Serializable
data class CategoryInfo(val id: String, val name: String, val sortOrder: Int, val collapsed: Boolean)

@Serializable
data class SortOrder(val id: String, val sortOrder: Int)

@Serializable
data class JobStage(val name: String, val status: String)

@Serializable
data class JobSummary(
    val id: String,
    val projectCwd: String,
    val projectName: String,
    val featureId: String?,
    val title: String,
    val status: String,
    val stage: String?,
    val gate: String?,
    val parkReason: String?,
    val detail: String?,
    val stages: List<JobStage>,
    val costUsd: Double,
    val createdAt: String,
    val updatedAt: String,
)

// ---- Client payloads ----

@Serializable
data class AuthPayload(val token: String? = null)

@Serializable
data class SessionCreatePayload(
    val name: String? = null,
    val shell: String? = null,
    val cwd: String? = null,
    val cols: Int? = null,
    val rows: Int? = null,
    val account: String? = null,
    val login: Boolean? = null,
    val cleanup: Boolean? = null,
)

@Serializable
data class SessionIdPayload(val sessionId: String)

@Serializable
data class SessionRenamePayload(val sessionId: String, val name: String)

/** `categoryId` has no default so a move to "no category" is sent as an explicit null. */
@Serializable
data class SessionMovePayload(val sessionId: String, val categoryId: String?)

@Serializable
data class SessionReorderPayload(val sessions: List<SortOrder>)

@Serializable
data class SessionOpenPayload(
    val claudeSessionId: String,
    val cwd: String,
    val mode: String,
    val account: String? = null,
    val cols: Int? = null,
    val rows: Int? = null,
)

@Serializable
data class SessionRevivePayload(val sessionId: String, val cols: Int? = null, val rows: Int? = null)

@Serializable
data class TerminalDataPayload(val sessionId: String, val data: String)

@Serializable
data class TerminalResizePayload(val sessionId: String, val cols: Int, val rows: Int)

@Serializable
data class CategoryCreatePayload(val name: String)

@Serializable
data class CategoryRenamePayload(val categoryId: String, val name: String)

@Serializable
data class CategoryIdPayload(val categoryId: String)

@Serializable
data class CategoryReorderPayload(val categories: List<SortOrder>)

@Serializable
data class CategoryTogglePayload(val categoryId: String, val collapsed: Boolean)

@Serializable
data class NotificationPreferencesSetPayload(
    val browserEnabled: Boolean? = null,
    val visualEnabled: Boolean? = null,
    val notifyOnInput: Boolean? = null,
    val notifyOnCompleted: Boolean? = null,
)

// ---- Server payloads ----

@Serializable
class EmptyPayload

@Serializable
data class AuthSuccessPayload(val userId: String, val loginName: String, val displayName: String)

@Serializable
data class MessagePayload(val message: String, val code: String? = null)

/** `refusal` is the account preflight's (accounts.ts); the app shows only its message. */
@Serializable
data class SessionErrorPayload(val message: String, val refusal: JsonElement? = null)

@Serializable
data class SessionPayload(val session: SessionInfo, val scrollback: String? = null)

@Serializable
data class SessionAttachedPayload(val session: SessionInfo, val scrollback: String)

@Serializable
data class SessionMovedPayload(val sessionId: String, val categoryId: String?, val sortOrder: Int)

@Serializable
data class SessionListPayload(val sessions: List<SessionInfo>)

@Serializable
data class ClaudeNamesPayload(val names: Map<String, String>)

@Serializable
data class AccountWarningsPayload(val warnings: Map<String, String>)

@Serializable
data class ExitPayload(val sessionId: String, val exitCode: Int)

@Serializable
data class CategoryCreatedPayload(val category: CategoryInfo)

@Serializable
data class CategoryListPayload(val categories: List<CategoryInfo>)

@Serializable
data class NotificationPreferencesPayload(
    val browserEnabled: Boolean,
    val visualEnabled: Boolean,
    val notifyOnInput: Boolean,
    val notifyOnCompleted: Boolean,
)

/**
 * Every `notification` variant in one shape, told apart as the server does: no `kind` is a
 * session notification (`type` needs-input/completed); `land`, `prompt-missing` and
 * `account-changed` carry the rest.
 */
@Serializable
data class NotificationPayload(
    val kind: String? = null,
    val sessionId: String? = null,
    val type: String? = null,
    val timestamp: String,
    val projectCwd: String? = null,
    val track: String? = null,
    val ok: Boolean? = null,
    val detail: String? = null,
    val name: String? = null,
)

@Serializable
data class JobsSummaryPayload(val jobs: List<JobSummary>)

@Serializable
data class ProjectsChangedPayload(val projectCwd: String)

object ClientType {
    const val AUTH = "auth"
    const val SESSION_CREATE = "session.create"
    const val SESSION_ATTACH = "session.attach"
    const val SESSION_DETACH = "session.detach"
    const val SESSION_TERMINATE = "session.terminate"
    const val SESSION_DELETE = "session.delete"
    const val SESSION_RENAME = "session.rename"
    const val SESSION_MOVE = "session.move"
    const val SESSION_REORDER = "session.reorder"
    const val SESSION_LIST = "session.list"
    const val SESSION_FORK = "session.fork"
    const val SESSION_OPEN = "session.open"
    const val SESSION_REVIVE = "session.revive"
    const val SESSION_KEEP = "session.keep"
    const val TERMINAL_DATA = "terminal.data"
    const val TERMINAL_RESIZE = "terminal.resize"
    const val CATEGORY_CREATE = "category.create"
    const val CATEGORY_RENAME = "category.rename"
    const val CATEGORY_DELETE = "category.delete"
    const val CATEGORY_REORDER = "category.reorder"
    const val CATEGORY_TOGGLE = "category.toggle"
    const val CATEGORY_LIST = "category.list"
    const val NOTIFICATION_PREFERENCES_GET = "notification.preferences.get"
    const val NOTIFICATION_PREFERENCES_SET = "notification.preferences.set"
    const val NOTIFICATION_DISMISS = "notification.dismiss"
    const val PING = "ping"
}

object ServerType {
    const val AUTH_SUCCESS = "auth.success"
    const val AUTH_FAILURE = "auth.failure"
    const val SESSION_CREATED = "session.created"
    const val SESSION_ADDED = "session.added"
    const val SESSION_UPDATED = "session.updated"
    const val SESSION_ATTACHED = "session.attached"
    const val SESSION_DETACHED = "session.detached"
    const val SESSION_TERMINATED = "session.terminated"
    const val SESSION_DELETED = "session.deleted"
    const val SESSION_RENAMED = "session.renamed"
    const val SESSION_MOVED = "session.moved"
    const val SESSION_REORDERED = "session.reordered"
    const val SESSION_LIST = "session.list"
    const val SESSION_FORKED = "session.forked"
    const val SESSION_KEPT = "session.kept"
    const val SESSION_CLAUDE_NAMES = "session.claudeNames"
    const val SESSION_ACCOUNT_WARNINGS = "session.accountWarnings"
    const val SESSION_LOGIN_ENDED = "session.loginEnded"
    const val SESSION_ERROR = "session.error"
    const val TERMINAL_DATA = "terminal.data"
    const val TERMINAL_EXIT = "terminal.exit"
    const val CATEGORY_CREATED = "category.created"
    const val CATEGORY_RENAMED = "category.renamed"
    const val CATEGORY_DELETED = "category.deleted"
    const val CATEGORY_REORDERED = "category.reordered"
    const val CATEGORY_TOGGLED = "category.toggled"
    const val CATEGORY_LIST = "category.list"
    const val NOTIFICATION_PREFERENCES = "notification.preferences"
    const val NOTIFICATION_PREFERENCES_UPDATED = "notification.preferences.updated"
    const val NOTIFICATION = "notification"
    const val JOBS_SUMMARY = "jobs.summary"
    const val PROJECTS_CHANGED = "projects.changed"
    const val ERROR = "error"
    const val PONG = "pong"
}

object Protocol {
    /** Tolerant: what the app uses on the wire, so an older app survives a newer server. */
    val json = Json {
        ignoreUnknownKeys = true
        encodeDefaults = false
        explicitNulls = true
        coerceInputValues = true
    }

    /** Strict: what the fixture test decodes with, so a field the app lacks fails the build. */
    val strictJson = Json {
        ignoreUnknownKeys = false
        encodeDefaults = false
    }

    private inline fun <reified T> s(): KSerializer<*> = serializer<T>()

    /** Every client message type → its payload shape (null: sent without a payload). */
    val clientPayloads: Map<String, KSerializer<*>?> = mapOf(
        ClientType.AUTH to s<AuthPayload>(),
        ClientType.SESSION_CREATE to s<SessionCreatePayload>(),
        ClientType.SESSION_ATTACH to s<SessionIdPayload>(),
        ClientType.SESSION_DETACH to s<SessionIdPayload>(),
        ClientType.SESSION_TERMINATE to s<SessionIdPayload>(),
        ClientType.SESSION_DELETE to s<SessionIdPayload>(),
        ClientType.SESSION_RENAME to s<SessionRenamePayload>(),
        ClientType.SESSION_MOVE to s<SessionMovePayload>(),
        ClientType.SESSION_REORDER to s<SessionReorderPayload>(),
        ClientType.SESSION_LIST to null,
        ClientType.SESSION_FORK to s<SessionIdPayload>(),
        ClientType.SESSION_OPEN to s<SessionOpenPayload>(),
        ClientType.SESSION_REVIVE to s<SessionRevivePayload>(),
        ClientType.SESSION_KEEP to s<SessionIdPayload>(),
        ClientType.TERMINAL_DATA to s<TerminalDataPayload>(),
        ClientType.TERMINAL_RESIZE to s<TerminalResizePayload>(),
        ClientType.CATEGORY_CREATE to s<CategoryCreatePayload>(),
        ClientType.CATEGORY_RENAME to s<CategoryRenamePayload>(),
        ClientType.CATEGORY_DELETE to s<CategoryIdPayload>(),
        ClientType.CATEGORY_REORDER to s<CategoryReorderPayload>(),
        ClientType.CATEGORY_TOGGLE to s<CategoryTogglePayload>(),
        ClientType.CATEGORY_LIST to null,
        ClientType.NOTIFICATION_PREFERENCES_GET to null,
        ClientType.NOTIFICATION_PREFERENCES_SET to s<NotificationPreferencesSetPayload>(),
        ClientType.NOTIFICATION_DISMISS to s<SessionIdPayload>(),
        ClientType.PING to null,
    )

    /** Every server message type → its payload shape (null: arrives without a payload). */
    val serverPayloads: Map<String, KSerializer<*>?> = mapOf(
        ServerType.AUTH_SUCCESS to s<AuthSuccessPayload>(),
        ServerType.AUTH_FAILURE to s<MessagePayload>(),
        ServerType.SESSION_CREATED to s<SessionPayload>(),
        ServerType.SESSION_ADDED to s<SessionPayload>(),
        ServerType.SESSION_UPDATED to s<SessionPayload>(),
        ServerType.SESSION_ATTACHED to s<SessionAttachedPayload>(),
        ServerType.SESSION_DETACHED to s<EmptyPayload>(),
        ServerType.SESSION_TERMINATED to s<SessionIdPayload>(),
        ServerType.SESSION_DELETED to s<SessionIdPayload>(),
        ServerType.SESSION_RENAMED to s<SessionRenamePayload>(),
        ServerType.SESSION_MOVED to s<SessionMovedPayload>(),
        ServerType.SESSION_REORDERED to s<SessionReorderPayload>(),
        ServerType.SESSION_LIST to s<SessionListPayload>(),
        ServerType.SESSION_FORKED to s<SessionPayload>(),
        ServerType.SESSION_KEPT to s<SessionIdPayload>(),
        ServerType.SESSION_CLAUDE_NAMES to s<ClaudeNamesPayload>(),
        ServerType.SESSION_ACCOUNT_WARNINGS to s<AccountWarningsPayload>(),
        ServerType.SESSION_LOGIN_ENDED to s<ExitPayload>(),
        ServerType.SESSION_ERROR to s<SessionErrorPayload>(),
        ServerType.TERMINAL_DATA to s<TerminalDataPayload>(),
        ServerType.TERMINAL_EXIT to s<ExitPayload>(),
        ServerType.CATEGORY_CREATED to s<CategoryCreatedPayload>(),
        ServerType.CATEGORY_RENAMED to s<CategoryRenamePayload>(),
        ServerType.CATEGORY_DELETED to s<CategoryIdPayload>(),
        ServerType.CATEGORY_REORDERED to s<CategoryReorderPayload>(),
        ServerType.CATEGORY_TOGGLED to s<CategoryTogglePayload>(),
        ServerType.CATEGORY_LIST to s<CategoryListPayload>(),
        ServerType.NOTIFICATION_PREFERENCES to s<NotificationPreferencesPayload>(),
        ServerType.NOTIFICATION_PREFERENCES_UPDATED to s<NotificationPreferencesPayload>(),
        ServerType.NOTIFICATION to s<NotificationPayload>(),
        ServerType.JOBS_SUMMARY to s<JobsSummaryPayload>(),
        ServerType.PROJECTS_CHANGED to s<ProjectsChangedPayload>(),
        ServerType.ERROR to s<MessagePayload>(),
        ServerType.PONG to null,
    )

    inline fun <reified T> encode(value: T): JsonElement = json.encodeToJsonElement(serializer<T>(), value)

    /** Decode a payload tolerantly; null when it is missing or the wrong shape. */
    inline fun <reified T> decode(payload: JsonElement?): T? {
        if (payload == null) return null
        return try {
            json.decodeFromJsonElement(serializer<T>(), payload)
        } catch (_: Exception) {
            null
        }
    }
}
