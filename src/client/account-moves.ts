import { showHeaderToast } from './header-toast.js';
import type { AccountRefusal, ErrorPayload, ServerMessage, SessionInfo } from './session-types.js';

export interface AccountMovesHost {
  send(type: string, payload?: unknown): string;
  /**
   * How to send a launch again, by message id, until it is answered. Shared with the
   * launches (create, open, revive): a move refused by the account preflight is
   * retried after Log in exactly like one.
   */
  launchRetries: Map<string, () => void>;
  session(sessionId: string): SessionInfo | undefined;
  currentSessionId(): string | null;
  revive(sessionId: string): void;
  /** Redraw the session list (a row's account changed). */
  render(): void;
  /** The header's account chip stops showing "Moving…". */
  menuFinished(): void;
  showRefusal(refusal: AccountRefusal, retry: () => void): void;
}

/**
 * Moving a session's conversation to another Claude account
 * (project/move-conversation-account.md): the request, its answer
 * (`session.accountChanged`) and its refusals (a `session.error` that answers it).
 */
export class AccountMoves {
  /** session.changeAccount requests in flight, by message id. */
  private moves = new Map<string, { sessionId: string; account: string }>();

  constructor(private readonly host: AccountMovesHost) {}

  /**
   * Ask the server to move it. It stops a running one first; the answer says whether
   * to revive it. A preflight refusal is retried after Log in through launchRetries.
   */
  change(sessionId: string, account: string, force = false): void {
    const id = this.host.send('session.changeAccount', { sessionId, account, ...(force ? { force: true } : {}) });
    this.moves.set(id, { sessionId, account });
    this.host.launchRetries.set(id, () => this.change(sessionId, account));
  }

  /** Apply `session.accountChanged`; false for any other message. */
  handleMessage(message: ServerMessage): boolean {
    if (message.type !== 'session.accountChanged') return false;
    const { payload, id: messageId } = message;
    if (messageId) {
      this.moves.delete(messageId);
      this.host.launchRetries.delete(messageId);
    }
    const session = this.host.session(payload.sessionId);
    if (session) session.account = payload.account;
    this.host.menuFinished();
    this.host.render();
    const name = session?.name ?? 'The session';
    // Revive attaches this browser to it: only while it is still the session on screen, or a
    // move finishing would pull the user back from wherever they went meanwhile.
    const resumeHere = payload.resume && this.host.currentSessionId() === payload.sessionId;
    showHeaderToast(
      resumeHere
        ? `${name} now runs under ${payload.account}: resuming the conversation there.`
        : `${name} now runs under ${payload.account}. Resume opens it there.`,
      true
    );
    if (resumeHere) this.host.revive(payload.sessionId);
    return true;
  }

  /** A `session.error`: handle it and return true when it answers a move, else false. */
  failed(messageId: string | undefined, payload: ErrorPayload): boolean {
    const move = messageId ? this.moves.get(messageId) : undefined;
    if (!messageId || !move) return false;
    const retry = this.host.launchRetries.get(messageId);
    this.moves.delete(messageId);
    this.host.launchRetries.delete(messageId);
    this.host.menuFinished();

    // Another browser is viewing it: the move would close their terminal too.
    if (payload.code === 'viewers') {
      if (confirm(`${payload.message}. Move it to ${move.account} anyway?`)) this.change(move.sessionId, move.account, true);
      return true;
    }
    if (payload.refusal && retry) {
      this.host.showRefusal(payload.refusal, retry);
      return true;
    }
    // It was stopped for the move and kept its account: bring it back where it was, if it is
    // still the session on screen (reviving attaches to it).
    if (payload.code === 'stopped') {
      const here = this.host.currentSessionId() === move.sessionId;
      showHeaderToast(`${payload.message}. Nothing moved; ${here ? 'resuming it where it was' : 'Resume brings it back'}.`);
      if (here) this.host.revive(move.sessionId);
      return true;
    }
    showHeaderToast(payload.message);
    return true;
  }

  /**
   * The socket dropped: no answer is coming for a move in flight, and the menu would show
   * "Moving…" until a reload. A move the server finished is in the session list it re-sends;
   * a session it stopped for the move is Resumed from the sidebar.
   */
  clear(): void {
    for (const id of this.moves.keys()) this.host.launchRetries.delete(id);
    this.moves.clear();
    this.host.menuFinished();
  }
}
