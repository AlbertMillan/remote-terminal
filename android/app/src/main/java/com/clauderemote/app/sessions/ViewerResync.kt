package com.clauderemote.app.sessions

/**
 * Keeps the open terminal in step when another viewer of the same session resizes its PTY
 * (`terminal.resized`, docs/session-revive.md). The web client's `viewer-resync.ts`, minus the
 * scroll position (a rebuilt terminal view starts at the bottom here anyway).
 *
 * Every viewer shares one PTY size, the last one sent. Output after another viewer's resize is
 * drawn for its width and lands in this terminal in the wrong cells, so the phone is marked
 * *outsized* and the session is re-attached on its next use (input, back to the foreground):
 * the snapshot replays the server's screen and the attach sends this grid back. Never at once,
 * or two open viewers would take the size from each other forever.
 */
class ViewerResync {
    data class Size(val columns: Int, val rows: Int)

    private var outsizedId: String? = null
    private var ptySize: Size? = null

    /** `terminal.resized` arrived; [ours] is this phone's grid. */
    fun resized(sessionId: String, size: Size, onScreen: String?, ours: Size) {
        if (sessionId != onScreen) return
        // Back to our grid, the mark stays: live output fits again, what was drawn meanwhile doesn't.
        if (size != ours || outsizedId == sessionId) {
            outsizedId = sessionId
            ptySize = size
        }
    }

    /** The PTY size of the open session while it is outsized, else null. */
    fun ptySize(onScreen: String?): Size? = if (outsizedId != null && outsizedId == onScreen) ptySize else null

    /**
     * The phone was used. Returns the session to re-attach, or null. The mark is dropped even
     * when [canAttach] is false: the attach already in flight replaces the terminal anyway.
     */
    fun take(onScreen: String?, canAttach: Boolean): String? {
        val id = outsizedId ?: return null
        clear()
        return if (id == onScreen && canAttach) id else null
    }

    /** A terminal was built from a fresh snapshot of [sessionId]: it holds the whole screen again. */
    fun attached(sessionId: String) {
        if (outsizedId == sessionId) clear()
    }

    /** The socket came back: its re-attach replays the screen anyway. */
    fun reset() = clear()

    private fun clear() {
        outsizedId = null
        ptySize = null
    }
}
