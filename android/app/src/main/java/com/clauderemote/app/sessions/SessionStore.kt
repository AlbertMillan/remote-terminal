package com.clauderemote.app.sessions

import com.clauderemote.app.data.Settings
import com.clauderemote.app.net.Connection
import com.clauderemote.app.protocol.CategoryCreatePayload
import com.clauderemote.app.protocol.CategoryIdPayload
import com.clauderemote.app.protocol.CategoryRenamePayload
import com.clauderemote.app.protocol.CategoryTogglePayload
import com.clauderemote.app.protocol.ClientType
import com.clauderemote.app.protocol.Envelope
import com.clauderemote.app.protocol.ExitPayload
import com.clauderemote.app.protocol.MessagePayload
import com.clauderemote.app.protocol.Protocol
import com.clauderemote.app.protocol.ServerType
import com.clauderemote.app.protocol.SessionAttachedPayload
import com.clauderemote.app.protocol.SessionCreatePayload
import com.clauderemote.app.protocol.SessionErrorPayload
import com.clauderemote.app.protocol.SessionIdPayload
import com.clauderemote.app.protocol.SessionInfo
import com.clauderemote.app.protocol.SessionMovePayload
import com.clauderemote.app.protocol.SessionOpenPayload
import com.clauderemote.app.protocol.SessionPayload
import com.clauderemote.app.protocol.SessionRenamePayload
import com.clauderemote.app.protocol.SessionRevivePayload
import com.clauderemote.app.protocol.TerminalDataPayload
import com.clauderemote.app.protocol.TerminalResizePayload
import com.clauderemote.app.terminal.RemoteTerminalSession
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch

/**
 * Sessions and the one open terminal, kept in step with the server over [connection].
 * Main thread only: every message arrives there (see [Connection]), and the terminal
 * emulator it feeds is drawn there.
 *
 * Re-attach is the recovery path: whenever the socket comes back (a server restart, the
 * phone waking up, a new network) the list is re-read and the open session re-attached,
 * which replaces the terminal with the server's scrollback, so nothing missed while away
 * is lost or doubled.
 */
class SessionStore(
    private val connection: Connection,
    private val settings: Settings,
    private val scope: CoroutineScope,
) : RemoteTerminalSession.Sink {

    data class Open(val session: SessionInfo, val terminal: RemoteTerminalSession)

    private val _state = MutableStateFlow(SessionsState())
    val state: StateFlow<SessionsState> = _state.asStateFlow()

    private val _open = MutableStateFlow<Open?>(null)
    val open: StateFlow<Open?> = _open.asStateFlow()

    /** The session an attach/create/revive is in flight for, to show progress on its row. */
    private val _pending = MutableStateFlow<String?>(null)
    val pending: StateFlow<String?> = _pending.asStateFlow()

    private val _messages = MutableSharedFlow<String>(extraBufferCapacity = 8)
    val messages: SharedFlow<String> = _messages.asSharedFlow()

    /** Set by the terminal view: redraw. */
    var onScreenUpdated: (() -> Unit)? = null
    var onClipboard: ((String) -> Unit)? = null

    /** The grid the terminal view has room for; new terminals start at this size. */
    private var columns = 80
    private var rows = 24

    init {
        connection.addListener(::handle)
        scope.launch {
            connection.state.collect { if (it is Connection.State.Connected) onConnected() }
        }
    }

    private fun onConnected() {
        connection.send(ClientType.SESSION_LIST)
        connection.send(ClientType.CATEGORY_LIST)
        val reattach = _open.value?.session?.id ?: settings.lastSessionId
        if (reattach != null) attach(reattach, force = true)
    }

    // ---- Actions ----

    fun attach(sessionId: String, force: Boolean = false) {
        if (!force && _open.value?.session?.id == sessionId) return
        _pending.value = sessionId
        connection.send(ClientType.SESSION_ATTACH, Protocol.encode(SessionIdPayload(sessionId)))
    }

    /** Open a row from the drawer: attach a live one, revive a stale one. */
    fun openRow(session: SessionInfo) {
        if (session.attachable && session.status != "terminated") attach(session.id)
        else if (session.revivable) revive(session.id)
        else _messages.tryEmit("${session.name} can't be revived")
    }

    fun create(name: String?, cwd: String?) {
        _pending.value = ""
        connection.send(
            ClientType.SESSION_CREATE,
            Protocol.encode(SessionCreatePayload(name = name?.ifBlank { null }, cwd = cwd?.ifBlank { null }, cols = columns, rows = rows)),
        )
    }

    fun revive(sessionId: String) {
        _pending.value = sessionId
        connection.send(ClientType.SESSION_REVIVE, Protocol.encode(SessionRevivePayload(sessionId, columns, rows)))
    }

    fun openFromHistory(claudeSessionId: String, cwd: String, mode: String, account: String?) {
        _pending.value = ""
        connection.send(
            ClientType.SESSION_OPEN,
            Protocol.encode(SessionOpenPayload(claudeSessionId, cwd, mode, account, columns, rows)),
        )
    }

    fun fork(sessionId: String) = connection.send(ClientType.SESSION_FORK, Protocol.encode(SessionIdPayload(sessionId)))

    fun rename(sessionId: String, name: String) =
        connection.send(ClientType.SESSION_RENAME, Protocol.encode(SessionRenamePayload(sessionId, name)))

    fun terminate(sessionId: String) =
        connection.send(ClientType.SESSION_TERMINATE, Protocol.encode(SessionIdPayload(sessionId)))

    fun delete(sessionId: String) = connection.send(ClientType.SESSION_DELETE, Protocol.encode(SessionIdPayload(sessionId)))

    fun move(sessionId: String, categoryId: String?) =
        connection.send(ClientType.SESSION_MOVE, Protocol.encode(SessionMovePayload(sessionId, categoryId)))

    fun createCategory(name: String) = connection.send(ClientType.CATEGORY_CREATE, Protocol.encode(CategoryCreatePayload(name)))

    fun renameCategory(id: String, name: String) =
        connection.send(ClientType.CATEGORY_RENAME, Protocol.encode(CategoryRenamePayload(id, name)))

    fun deleteCategory(id: String) = connection.send(ClientType.CATEGORY_DELETE, Protocol.encode(CategoryIdPayload(id)))

    fun toggleCategory(id: String, collapsed: Boolean) {
        // Optimistic: the drawer folds at once; the server echoes the same state.
        _state.value = _state.value.copy(categories = _state.value.categories.map { if (it.id == id) it.copy(collapsed = collapsed) else it })
        connection.send(ClientType.CATEGORY_TOGGLE, Protocol.encode(CategoryTogglePayload(id, collapsed)))
    }

    /** Send text to the open session (the keys bar, a paste, share-to). */
    fun type(text: String) {
        val open = _open.value ?: return
        open.terminal.write(text)
    }

    /** The terminal view's grid changed. */
    fun onViewSize(columns: Int, rows: Int) {
        this.columns = columns
        this.rows = rows
        _open.value?.terminal?.updateSize(columns, rows)
    }

    // ---- Sink (the open terminal) ----

    override fun input(sessionId: String, data: String) {
        connection.send(ClientType.TERMINAL_DATA, Protocol.encode(TerminalDataPayload(sessionId, data)))
    }

    override fun resize(sessionId: String, columns: Int, rows: Int) {
        connection.send(ClientType.TERMINAL_RESIZE, Protocol.encode(TerminalResizePayload(sessionId, columns, rows)))
    }

    override fun screenUpdated() {
        onScreenUpdated?.invoke()
    }

    override fun clipboard(text: String) {
        onClipboard?.invoke(text)
    }

    // ---- Messages ----

    private fun handle(env: Envelope) {
        _state.value = SessionsReducer.reduce(_state.value, env)
        when (env.type) {
            ServerType.TERMINAL_DATA -> {
                val data = Protocol.decode<TerminalDataPayload>(env.payload) ?: return
                val open = _open.value ?: return
                if (open.session.id == data.sessionId) open.terminal.feed(data.data)
            }
            ServerType.SESSION_ATTACHED -> {
                val p = Protocol.decode<SessionAttachedPayload>(env.payload) ?: return
                show(p.session, p.scrollback)
            }
            ServerType.SESSION_CREATED, ServerType.SESSION_FORKED -> {
                // The server attached this connection to it: show it.
                val p = Protocol.decode<SessionPayload>(env.payload) ?: return
                show(p.session, p.scrollback)
            }
            ServerType.SESSION_UPDATED -> {
                val p = Protocol.decode<SessionPayload>(env.payload) ?: return
                _open.value?.let { if (it.session.id == p.session.id) _open.value = it.copy(session = p.session) }
            }
            ServerType.SESSION_RENAMED -> refreshOpen()
            ServerType.TERMINAL_EXIT -> {
                val p = Protocol.decode<ExitPayload>(env.payload) ?: return
                _open.value?.let { if (it.session.id == p.sessionId) it.terminal.markExited() }
            }
            ServerType.SESSION_TERMINATED -> {
                val p = Protocol.decode<SessionIdPayload>(env.payload) ?: return
                _open.value?.let { if (it.session.id == p.sessionId) it.terminal.markExited() }
                refreshOpen()
            }
            ServerType.SESSION_DELETED -> {
                val p = Protocol.decode<SessionIdPayload>(env.payload) ?: return
                if (_open.value?.session?.id == p.sessionId) {
                    _open.value = null
                    settings.lastSessionId = null
                }
            }
            ServerType.SESSION_ERROR -> {
                val p = Protocol.decode<SessionErrorPayload>(env.payload)
                val wasReattach = _pending.value != null && _pending.value == settings.lastSessionId && _open.value == null
                _pending.value = null
                if (wasReattach && p?.message == "Session not found") {
                    // The last session is gone (a server restart parks it): start on the list.
                    settings.lastSessionId = null
                    return
                }
                _messages.tryEmit(p?.message ?: "Session error")
            }
            ServerType.ERROR -> Protocol.decode<MessagePayload>(env.payload)?.let { _messages.tryEmit(it.message) }
        }
    }

    private fun refreshOpen() {
        val open = _open.value ?: return
        val row = _state.value.sessions.firstOrNull { it.id == open.session.id } ?: return
        if (row != open.session) _open.value = open.copy(session = row)
    }

    private fun show(session: SessionInfo, scrollback: String?) {
        _pending.value = null
        val terminal = RemoteTerminalSession(session.id, columns, rows, this)
        if (!scrollback.isNullOrEmpty()) terminal.feed(scrollback)
        _open.value = Open(session, terminal)
        settings.lastSessionId = session.id
        if (session.id in _state.value.notices) {
            _state.value = SessionsReducer.clearNotice(_state.value, session.id)
            connection.send(ClientType.NOTIFICATION_DISMISS, Protocol.encode(SessionIdPayload(session.id)))
        }
        // The server's PTY takes this phone's grid, as the web client does on attach.
        terminal.updateSize(columns, rows)
    }
}
