package com.clauderemote.app.sessions

import com.clauderemote.app.protocol.AccountWarningsPayload
import com.clauderemote.app.protocol.CategoryCreatedPayload
import com.clauderemote.app.protocol.CategoryIdPayload
import com.clauderemote.app.protocol.CategoryInfo
import com.clauderemote.app.protocol.CategoryListPayload
import com.clauderemote.app.protocol.CategoryRenamePayload
import com.clauderemote.app.protocol.CategoryReorderPayload
import com.clauderemote.app.protocol.CategoryTogglePayload
import com.clauderemote.app.protocol.ClaudeNamesPayload
import com.clauderemote.app.protocol.Envelope
import com.clauderemote.app.protocol.NotificationPayload
import com.clauderemote.app.protocol.Protocol
import com.clauderemote.app.protocol.ServerType
import com.clauderemote.app.protocol.SessionAttachedPayload
import com.clauderemote.app.protocol.SessionIdPayload
import com.clauderemote.app.protocol.SessionInfo
import com.clauderemote.app.protocol.SessionListPayload
import com.clauderemote.app.protocol.SessionMovedPayload
import com.clauderemote.app.protocol.SessionPayload
import com.clauderemote.app.protocol.SessionRenamePayload
import com.clauderemote.app.protocol.SessionReorderPayload

/** What the drawer shows, rebuilt from server messages only (the server is the truth). */
data class SessionsState(
    val sessions: List<SessionInfo> = emptyList(),
    val categories: List<CategoryInfo> = emptyList(),
    /** Session id → `needs-input` / `completed`, until that session is opened. */
    val notices: Map<String, String> = emptyMap(),
    val loaded: Boolean = false,
)

object SessionsReducer {
    fun reduce(state: SessionsState, env: Envelope): SessionsState {
        val p = env.payload
        return when (env.type) {
            ServerType.SESSION_LIST ->
                Protocol.decode<SessionListPayload>(p)?.let { state.copy(sessions = it.sessions, loaded = true) } ?: state
            ServerType.SESSION_CREATED, ServerType.SESSION_ADDED, ServerType.SESSION_UPDATED, ServerType.SESSION_FORKED ->
                Protocol.decode<SessionPayload>(p)?.let { upsert(state, it.session) } ?: state
            ServerType.SESSION_ATTACHED ->
                Protocol.decode<SessionAttachedPayload>(p)?.let { upsert(state, it.session) } ?: state
            ServerType.SESSION_TERMINATED ->
                Protocol.decode<SessionIdPayload>(p)?.let { id ->
                    mapSession(state, id.sessionId) { it.copy(status = "terminated", attachable = false) }
                } ?: state
            ServerType.SESSION_DELETED ->
                Protocol.decode<SessionIdPayload>(p)?.let { id ->
                    state.copy(sessions = state.sessions.filter { it.id != id.sessionId }, notices = state.notices - id.sessionId)
                } ?: state
            ServerType.SESSION_RENAMED ->
                Protocol.decode<SessionRenamePayload>(p)?.let { r -> mapSession(state, r.sessionId) { it.copy(name = r.name) } } ?: state
            ServerType.SESSION_MOVED ->
                Protocol.decode<SessionMovedPayload>(p)?.let { m ->
                    mapSession(state, m.sessionId) { it.copy(categoryId = m.categoryId, sortOrder = m.sortOrder) }
                } ?: state
            ServerType.SESSION_REORDERED ->
                Protocol.decode<SessionReorderPayload>(p)?.let { r ->
                    val order = r.sessions.associate { it.id to it.sortOrder }
                    state.copy(sessions = state.sessions.map { s -> order[s.id]?.let { s.copy(sortOrder = it) } ?: s })
                } ?: state
            ServerType.SESSION_CLAUDE_NAMES ->
                Protocol.decode<ClaudeNamesPayload>(p)?.let { n ->
                    state.copy(sessions = state.sessions.map { it.copy(claudeName = n.names[it.id]) })
                } ?: state
            ServerType.SESSION_ACCOUNT_WARNINGS ->
                Protocol.decode<AccountWarningsPayload>(p)?.let { w ->
                    state.copy(sessions = state.sessions.map { it.copy(accountWarning = w.warnings[it.id]) })
                } ?: state
            ServerType.CATEGORY_LIST ->
                Protocol.decode<CategoryListPayload>(p)?.let { state.copy(categories = it.categories) } ?: state
            ServerType.CATEGORY_CREATED ->
                Protocol.decode<CategoryCreatedPayload>(p)?.let { c ->
                    state.copy(categories = state.categories.filter { it.id != c.category.id } + c.category)
                } ?: state
            ServerType.CATEGORY_RENAMED ->
                Protocol.decode<CategoryRenamePayload>(p)?.let { r ->
                    state.copy(categories = state.categories.map { if (it.id == r.categoryId) it.copy(name = r.name) else it })
                } ?: state
            ServerType.CATEGORY_DELETED ->
                Protocol.decode<CategoryIdPayload>(p)?.let { d ->
                    state.copy(
                        categories = state.categories.filter { it.id != d.categoryId },
                        sessions = state.sessions.map { if (it.categoryId == d.categoryId) it.copy(categoryId = null) else it },
                    )
                } ?: state
            ServerType.CATEGORY_REORDERED ->
                Protocol.decode<CategoryReorderPayload>(p)?.let { r ->
                    val order = r.categories.associate { it.id to it.sortOrder }
                    state.copy(categories = state.categories.map { c -> order[c.id]?.let { c.copy(sortOrder = it) } ?: c })
                } ?: state
            ServerType.CATEGORY_TOGGLED ->
                Protocol.decode<CategoryTogglePayload>(p)?.let { t ->
                    state.copy(categories = state.categories.map { if (it.id == t.categoryId) it.copy(collapsed = t.collapsed) else it })
                } ?: state
            ServerType.NOTIFICATION ->
                Protocol.decode<NotificationPayload>(p)?.let { n ->
                    if (n.kind == null && n.sessionId != null && n.type != null) {
                        state.copy(notices = state.notices + (n.sessionId to n.type))
                    } else {
                        state
                    }
                } ?: state
            else -> state
        }
    }

    fun clearNotice(state: SessionsState, sessionId: String): SessionsState =
        if (sessionId in state.notices) state.copy(notices = state.notices - sessionId) else state

    private fun upsert(state: SessionsState, session: SessionInfo): SessionsState {
        val index = state.sessions.indexOfFirst { it.id == session.id }
        val sessions = if (index < 0) state.sessions + session
        else state.sessions.toMutableList().also { it[index] = session }
        return state.copy(sessions = sessions)
    }

    private fun mapSession(state: SessionsState, id: String, f: (SessionInfo) -> SessionInfo): SessionsState =
        state.copy(sessions = state.sessions.map { if (it.id == id) f(it) else it })
}

/** One line of the drawer, flattened so a LazyColumn renders it with stable keys. */
sealed interface DrawerRow {
    val key: String

    data class Category(val category: CategoryInfo?, val count: Int) : DrawerRow {
        override val key = "c:" + (category?.id ?: "none")
    }

    data class Session(
        val session: SessionInfo,
        val depth: Int,
        val notice: String?,
        val current: Boolean,
    ) : DrawerRow {
        override val key = "s:" + session.id
    }
}

object DrawerRows {
    /**
     * Uncategorised sessions first, then each category in its order; within a group by
     * sortOrder, with sessions another session started nested under it (as the web
     * sidebar does). A collapsed category keeps its header and hides its sessions.
     */
    fun build(state: SessionsState, currentId: String?): List<DrawerRow> {
        val known = state.categories.map { it.id }.toSet()
        val byCategory = state.sessions.groupBy { it.categoryId?.takeIf { id -> id in known } }
        val rows = ArrayList<DrawerRow>(state.sessions.size + state.categories.size + 1)

        fun addGroup(sessions: List<SessionInfo>) {
            val ids = sessions.map { it.id }.toSet()
            val children = sessions.filter { it.spawnedBy != null && it.spawnedBy in ids }.groupBy { it.spawnedBy }
            fun add(s: SessionInfo, depth: Int) {
                rows += DrawerRow.Session(s, depth, state.notices[s.id], s.id == currentId)
                children[s.id].orEmpty().sortedWith(order).forEach { add(it, depth + 1) }
            }
            sessions.filter { it.spawnedBy == null || it.spawnedBy !in ids }.sortedWith(order).forEach { add(it, 0) }
        }

        val loose = byCategory[null].orEmpty()
        if (loose.isNotEmpty() || state.categories.isEmpty()) addGroup(loose)
        for (category in state.categories.sortedBy { it.sortOrder }) {
            val members = byCategory[category.id].orEmpty()
            rows += DrawerRow.Category(category, members.size)
            if (!category.collapsed) addGroup(members)
        }
        return rows
    }

    /** Read-only peers sort after their builder; then the server's order. */
    private val order = compareBy<SessionInfo>({ if (it.access == "read") 1 else 0 }, { it.sortOrder }, { it.createdAt })
}
