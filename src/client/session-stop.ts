import type { SessionInfo } from './session-types.js';

/**
 * The client's half of Stop (project/stop-sessions.md): `session.stop` requests in flight,
 * by message id. Kept apart from SessionManager so it can be tested without a page.
 */
export class StopRequests {
  private byMessage = new Map<string, string>();

  /** Whether a stop for this session is already waiting for its answer. */
  inFlight(sessionId: string): boolean {
    for (const id of this.byMessage.values()) if (id === sessionId) return true;
    return false;
  }

  sent(messageId: string, sessionId: string): void {
    this.byMessage.set(messageId, sessionId);
  }

  /** Answered (`session.stopped`, or an error): forget it. */
  answered(messageId: string | undefined): void {
    if (messageId) this.byMessage.delete(messageId);
  }

  /**
   * A refused stop: the session to stop again with `force` when the refusal was another
   * browser viewing it, else undefined. Either way it is no longer in flight.
   */
  refused(messageId: string | undefined, code: string | undefined): string | undefined {
    if (!messageId) return undefined;
    const sessionId = this.byMessage.get(messageId);
    this.byMessage.delete(messageId);
    return code === 'viewers' ? sessionId : undefined;
  }

  /** The socket closed: no answer is coming for any of them. */
  clear(): void {
    this.byMessage.clear();
  }
}

/**
 * Whether the session on screen still has a shell. A stopped one stays on screen without
 * one (its last output under the Resume prompt): no input, resize or detach goes to it.
 * A session not in the list yet counts as live: only a row saying `attachable: false` is
 * known to have no shell.
 */
export function isLive(session: SessionInfo | undefined): boolean {
  return session?.attachable !== false;
}

/**
 * The current session id once `revivedId` is being revived. Reviving the stopped session
 * still on screen must forget it, or the attach that follows the server's session.created
 * early-returns as "already attached" and the revived shell never gets a terminal.
 */
export function currentAfterRevive(currentId: string | null, revivedId: string): string | null {
  return currentId === revivedId ? null : currentId;
}
