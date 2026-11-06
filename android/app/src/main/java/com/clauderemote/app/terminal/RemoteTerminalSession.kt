package com.clauderemote.app.terminal

import com.termux.terminal.ITerminalSession
import com.termux.terminal.TerminalEmulator
import com.termux.terminal.TerminalOutput

/**
 * One server session shown in the terminal view: a local emulator fed by `terminal.data`,
 * whose keystrokes and size go back through [sink]. Main thread only, like the view that
 * draws it.
 */
class RemoteTerminalSession(
    val sessionId: String,
    columns: Int,
    rows: Int,
    private val sink: Sink,
) : ITerminalSession {

    interface Sink {
        fun input(sessionId: String, data: String)
        fun resize(sessionId: String, columns: Int, rows: Int)
        fun screenUpdated()
        fun clipboard(text: String) {}
    }

    private var title = ""
    private var running = true
    private var sentColumns = -1
    private var sentRows = -1

    private val output = object : TerminalOutput() {
        // Answers the emulator itself gives (cursor position reports, DA) go to the PTY.
        override fun write(data: ByteArray, offset: Int, count: Int) {
            sink.input(sessionId, String(data, offset, count, Charsets.UTF_8))
        }

        override fun titleChanged(oldTitle: String?, newTitle: String?) {
            title = newTitle ?: ""
        }

        override fun onBell() {}

        override fun clipboardText(text: String?) {
            if (text != null) sink.clipboard(text)
        }

        override fun onColorsChanged() {
            sink.screenUpdated()
        }
    }

    private val emulator = TerminalEmulator(output, columns.coerceAtLeast(4), rows.coerceAtLeast(4))

    /** Output from the server. */
    fun feed(data: String) {
        if (data.isEmpty()) return
        val bytes = data.toByteArray(Charsets.UTF_8)
        emulator.process(bytes, bytes.size)
        sink.screenUpdated()
    }

    /**
     * Paste text as a terminal paste: line breaks become Enter (CR), and when the program
     * asked for bracketed paste (Claude Code does) the text is bracketed, so a multi-line
     * paste or share lands in the prompt instead of submitting at every line.
     */
    fun paste(text: String) {
        write(preparePaste(text, emulator.getBracketedPasteBracket(true).isNotEmpty()))
    }

    fun markExited() {
        running = false
        feed("\r\n\u001b[2m[process exited]\u001b[0m\r\n")
    }

    override fun getEmulator(): TerminalEmulator = emulator

    override fun write(data: ByteArray, offset: Int, length: Int) {
        if (running) sink.input(sessionId, String(data, offset, length, Charsets.UTF_8))
    }

    override fun write(data: String) {
        if (running && data.isNotEmpty()) sink.input(sessionId, data)
    }

    /** Resize the local grid and, when it changed, the server's PTY. */
    override fun updateSize(columns: Int, rows: Int) {
        if (columns < 4 || rows < 4) return
        emulator.resize(columns, rows)
        if (columns != sentColumns || rows != sentRows) {
            sentColumns = columns
            sentRows = rows
            sink.resize(sessionId, columns, rows)
        }
        sink.screenUpdated()
    }

    override fun isRunning(): Boolean = running

    override fun getTitle(): String = title

    companion object {
        /** ESC is dropped: a pasted "ESC[201~" would end the bracket early and run what follows. */
        fun preparePaste(text: String, bracketed: Boolean): String {
            val body = text.replace("\r\n", "\r").replace('\n', '\r').replace("\u001b", "")
            return if (bracketed) "\u001b[200~$body\u001b[201~" else body
        }
    }
}
