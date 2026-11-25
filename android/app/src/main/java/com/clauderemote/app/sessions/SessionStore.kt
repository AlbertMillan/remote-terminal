package com.clauderemote.app.sessions

import com.clauderemote.app.data.SessionMemory
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
    private val settings: SessionMemory,
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

    /** The open session while its re-attach after a reconnect is in flight. */
    private var reattaching: String? = null

    /** Another viewer resized the open session: re-attach on the next use here ([ViewerResync]). */
    private val viewerResync = ViewerResync()

    /** Whether `session.list` has answered since the last connect (rows before it are stale). */
    private var listFresh = false

    /** The open session's re-attach was refused before the fresh list came: settle it then. */
    private var settleWhenListed: String? = null

    private fun onConnected() {
        listFresh = false
        settleWhenListed = null
        // The re-attach below replays the screen anyway.
        viewerResync.reset()
        connection.send(ClientType.SESSION_LIST)
        connection.send(ClientType.CATEGORY_LIST)
        reattaching = _open.value?.session?.id
        val reattach = reattaching ?: settings.lastSessionId
        if (reattach != null) attach(reattach, force = true)
    }

    /**
     * The open session could not be re-attached: after a server restart it is parked, not
     * in memory. Stop its terminal (keys would only draw "Not attached" errors) and show
     * the server's row, whose `revivable` offers Revive, as the web client does. Never
     * revived automatically: that relaunches `claude`, which is the user's call.
     */
    private fun settleStale(sessionId: String) {
        settleWhenListed = null
        val open = _open.value ?: return
        if (open.session.id != sessionId) return
        val row = _state.value.sessions.firstOrNull { it.id == sessionId }
        when {
            row == null -> {
                _open.value = null
                settings.lastSessionId = null
            }
            row.attachable && row.status != "terminated" -> attach(sessionId, force = true)
            else -> {
                open.terminal.markExited()
                _open.value = open.copy(session = row)
            }
        }
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

    /** A link or notification named this session: open it the way a tap on its row would. */
    fun openById(sessionId: String) {
        val row = _state.value.sessions.firstOrNull { it.id == sessionId }
        if (row != null) openRow(row) else attach(sessionId, force = true)
    }

    /** A null or blank `account` lets the server pick: the project's, else the configured one. */
    fun create(name: String?, cwd: String?, account: String? = null) {
        _pending.value = ""
        connection.send(
            ClientType.SESSION_CREATE,
            Protocol.encode(
                SessionCreatePayload(
                    name = name?.ifBlank { null }, cwd = cwd?.ifBlank { null }, cols = columns, rows = rows,
                    account = account?.ifBlank { null },
                ),
            ),
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

    /** Send keys to the open session (the keys bar). */
    fun type(text: String) {
        val open = _open.value ?: return
        open.terminal.write(text)
    }

    /** Paste into the open session (Paste key), bracketed when the program asked for it. */
    fun paste(text: String) {
        _open.value?.terminal?.paste(text)
    }

    /** Text shared to the app, waiting for its session to open. */
    private var pendingPaste: Pair<String, String>? = null

    /**
     * Share-to: paste [text] into [sessionId], opening it first when it is not the open one.
     * Never presses Enter: what was shared is left in the prompt to read and send.
     */
    fun shareTo(sessionId: String, text: String) {
        if (_open.value?.session?.id == sessionId) {
            paste(text)
            return
        }
        pendingPaste = sessionId to text
        openById(sessionId)
    }

    /** The terminal view's grid changed. */
    fun onViewSize(columns: Int, rows: Int) {
        this.columns = columns
        this.rows = rows
        _open.value?.terminal?.updateSize(columns, rows)
    }

    // ---- Sink (the open terminal) ----

    override fun input(sessionId: String, data: String) {
        // Not attached on this socket yet: the server would only answer "Not attached".
        if (reattaching == sessionId) return
        connection.send(ClientType.TERMINAL_DATA, Protocol.encode(TerminalDataPayload(sessionId, data)))
        resyncIfOutsized()
    }

    /** The app came back to the foreground: a use, as input is. */
    fun resumed() = resyncIfOutsized()

    /**
     * Re-attach the open session if another viewer resized it: the snapshot replays the
     * server's screen and show() sends this grid back.
     */
    private fun resyncIfOutsized() {
        val onScreen = _open.value?.session?.id
        val canAttach = _pending.value == null && reattaching == null
        viewerResync.take(onScreen, canAttach)?.let { attach(it, force = true) }
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
            ServerType.SESSION_LIST -> {
                listFresh = true
                val stale = settleWhenListed
                if (stale != null) settleStale(stale) else refreshOpen()
            }
            ServerType.TERMINAL_DATA -> {
                val data = Protocol.decode<TerminalDataPayload>(env.payload) ?: return
                val open = _open.value ?: return
                if (open.session.id != data.sessionId) return
                val pty = viewerResync.ptySize(open.session.id)
                // The server's catch-up snapshot (RIS first, terminal-output.ts) is drawn at the
                // PTY's size, which another viewer set: replay it there, keeping our grid.
                if (pty != null && data.data.startsWith(ServerType.CATCH_UP_RESET)) open.terminal.replayAt(pty.columns, pty.rows, data.data)
                else open.terminal.feed(data.data)
            }
            ServerType.TERMINAL_RESIZED -> {
                val p = Protocol.decode<TerminalResizePayload>(env.payload) ?: return
                viewerResync.resized(
                    p.sessionId, ViewerResync.Size(p.cols, p.rows), _open.value?.session?.id, ViewerResync.Size(columns, rows),
                )
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
                val failed = _pending.value
                _pending.value = null
                if (failed != null && p?.message == "Session not found") {
                    if (failed == reattaching) {
                        // The open session did not survive a server restart.
                        reattaching = null
                        if (listFresh) settleStale(failed) else settleWhenListed = failed
                        return
                    }
                    if (failed == settings.lastSessionId && _open.value == null) {
                        // The last session is gone (a server restart parks it): start on the list.
                        settings.lastSessionId = null
                        return
                    }
                }
                if (failed != null && failed == reattaching) reattaching = null
                _messages.tryEmit(p?.message ?: "Session error")
            }
            ServerType.ERROR -> Protocol.decode<MessagePayload>(env.payload)?.let {
                // A server older than the app answers `app.state` this way; nothing to tell the user.
                if (!it.message.startsWith("Unknown message type")) _messages.tryEmit(it.message)
            }
        }
    }

    private fun refreshOpen() {
        val open = _open.value ?: return
        val row = _state.value.sessions.firstOrNull { it.id == open.session.id } ?: return
        if (row != open.session) _open.value = open.copy(session = row)
    }

    private fun show(session: SessionInfo, scrollback: String?) {
        _pending.value = null
        if (reattaching == session.id) reattaching = null
        val current = _open.value
        // Reviving the open session answers `session.created` with no scrollback: keep the
        // screen it had and carry on below it, instead of a blank terminal.
        val terminal = if (scrollback == null && current != null && current.session.id == session.id) {
            current.terminal.also { it.revived() }
        } else {
            // The snapshot is drawn at the session's size: replay it there, then updateSize()
            // below reflows to this grid, as the web client does. Fed at our grid instead,
            // a snapshot drawn on a wider screen lands in the wrong cells.
            val replay = !scrollback.isNullOrEmpty() && session.cols >= 4 && session.rows >= 4
            RemoteTerminalSession(session.id, if (replay) session.cols else columns, if (replay) session.rows else rows, this).also {
                if (!scrollback.isNullOrEmpty()) it.feed(scrollback)
                // A fresh snapshot holds the whole screen: no stale outsized mark survives it.
                viewerResync.attached(session.id)
            }
        }
        _open.value = Open(session, terminal)
        settings.lastSessionId = session.id
        if (session.id in _state.value.notices) {
            _state.value = SessionsReducer.clearNotice(_state.value, session.id)
            connection.send(ClientType.NOTIFICATION_DISMISS, Protocol.encode(SessionIdPayload(session.id)))
        }
        // The server's PTY takes this phone's grid, as the web client does on attach.
        terminal.updateSize(columns, rows)
        pendingPaste?.let { (id, text) ->
            if (id == session.id) {
                pendingPaste = null
                terminal.paste(text)
            }
        }
    }
}
