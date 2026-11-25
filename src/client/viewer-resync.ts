/**
 * Keeps this browser's terminal in step when another viewer of the same session resizes its
 * PTY (`terminal.resized`, docs/session-revive.md).
 *
 * Every viewer shares one PTY size, the last one sent. Output after another viewer's resize
 * is drawn for its width and lands in our scrollback in the wrong cells. So we are marked
 * *outsized*, and on our next use (focus, click, scroll, key) the session is re-attached:
 * the snapshot replays the server's ScreenMirror and the attach sends our size back. Never
 * at once, or two open viewers would take the size from each other forever.
 */

export interface Size {
  cols: number;
  rows: number;
}

export class ViewerResync {
  /** The session on screen and the PTY size another viewer gave it, while it differs from ours. */
  private outsized: { sessionId: string; size: Size } | null = null;
  /** A re-attach in flight to the session already on screen, and where its view was scrolled. */
  private resyncing: { sessionId: string; linesFromBottom: number } | null = null;

  /** `terminal.resized` arrived. `ours` is this terminal's grid. */
  resized(sessionId: string, size: Size, onScreen: string | null, ours: Size): void {
    if (sessionId !== onScreen) return;
    const differs = size.cols !== ours.cols || size.rows !== ours.rows;
    // Back to our size, the mark stays: live output fits again, what was drawn meanwhile doesn't.
    if (differs || this.outsized?.sessionId === sessionId) this.outsized = { sessionId, size };
  }

  /** The PTY size of the session on screen while we are outsized, else null. */
  ptySize(onScreen: string | null): Size | null {
    return this.outsized && this.outsized.sessionId === onScreen ? this.outsized.size : null;
  }

  /**
   * This browser was used. Returns the session to re-attach, or null. `canAttach` is false
   * while another attach is in flight or the session has no shell; the mark is dropped
   * either way, since that attach (or the stopped screen) replaces the terminal anyway.
   */
  take(onScreen: string | null, canAttach: boolean, linesFromBottom: number): string | null {
    const outsized = this.outsized;
    if (!outsized) return null;
    this.outsized = null;
    if (outsized.sessionId !== onScreen || !canAttach) return null;
    this.resyncing = { sessionId: outsized.sessionId, linesFromBottom: Math.max(0, linesFromBottom) };
    return outsized.sessionId;
  }

  /**
   * `session.attached` arrived. `rebuild`: build the terminal from the snapshot even though
   * the session is already on screen (our re-attach). A rebuilt terminal holds the whole
   * screen again, so any outsized mark (from a resize that raced the attach, or from before
   * switching away and back) is cleared. `linesFromBottom`: where to scroll back to.
   */
  attached(sessionId: string, onScreen: string | null): { rebuild: boolean; linesFromBottom: number } {
    const resync = this.resyncing?.sessionId === sessionId ? this.resyncing : null;
    if (resync) this.resyncing = null;
    const rebuild = sessionId !== onScreen || !!resync;
    if (rebuild && this.outsized?.sessionId === sessionId) this.outsized = null;
    return { rebuild, linesFromBottom: resync?.linesFromBottom ?? 0 };
  }

  /** The socket dropped: the reconnect re-attaches from scratch. */
  reset(): void {
    this.outsized = null;
    this.resyncing = null;
  }
}
