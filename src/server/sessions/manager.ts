import { randomUUID } from 'crypto';
import { unlinkSync } from 'fs';
import { createPty, resizePty, writeToPty, killPty, ptyExit } from './pty-handler.js';
import { ScreenMirror, storedToReplay } from './screen-mirror.js';
import { generateSessionLog } from './project-log.js';
import type { ActiveSession, SessionCreateOptions, SessionMetadata } from './types.js';
import { getConfig } from '../config.js';
import { deleteUploads } from './uploads.js';
import { createLogger } from '../utils/logger.js';
import { getDefaultShell, isWindows } from '../utils/platform.js';
import { sessionsInWorktree } from '../utils/paths.js';
import {
  insertSession,
  updateSession,
  getAllSessions as getAllSessionsFromDb,
  deleteSession as deleteSessionFromDb,
  getSession as getSessionMetadata,
  logSessionEvent,
  getMaxSessionSortOrder,
  clearForkFlag,
  setSessionAccount,
} from '../db/queries.js';
import { changeAccountRefusal, moveTranscript } from './account-move.js';
import { assertSessionSlot } from './session-limit.js';
import {
  createTmuxSession,
  killTmuxSession,
  persistScrollback,
  restoreScrollbackRaw,
  isTmuxAvailable,
} from './persistence.js';
import {
  forkSession as forkSessionImpl,
  openClaudeSession as openClaudeSessionImpl,
  reviveSession as reviveSessionImpl,
  type SessionRegistry,
} from './session-open.js';
import { revokeAllSessionTokens, revokeSessionToken, sessionEnv } from './session-env.js';
import { deletePromptFile } from './prompt-file.js';
import { assertAccountReady, findTranscript, resolveStartAccount } from '../accounts.js';
import { projectCwdFor } from '../projects/worktree-owner.js';
import { createFolder, defaultCwd } from './folder-picker.js';

const logger = createLogger('session-manager');


// Configuration constants
const IDLE_CHECK_INTERVAL_MS = 60000; // Check for idle sessions every minute
const DB_UPDATE_DEBOUNCE_MS = 5000; // Debounce database updates for session activity
const PTY_EXIT_WAIT_MS = 5000; // Longest terminateSession waits for a killed shell to exit (~0.1s measured)

/** A move that failed after its checks; `stopped`: the session was parked for it. */
export class ChangeAccountError extends Error {
  constructor(message: string, readonly stopped: boolean) {
    super(message);
    this.name = 'ChangeAccountError';
  }
}

class SessionManager {
  private activeSessions: Map<string, ActiveSession> = new Map();
  /**
   * Sessions whose conversation is moving to another account: stopped, files on the move.
   * Revive, Stop and a second move refuse them, or a Resume in that window would start a
   * Claude on the transcript being renamed (project/move-conversation-account.md).
   */
  private movingAccount = new Set<string>();
  private dataListeners: Map<string, Set<(data: string) => void>> = new Map();
  private exitListeners: Map<string, Set<(code: number) => void>> = new Map();
  /** Told after any session's shell exits on its own and its row is marked 'terminated'. */
  private anyExitListeners: Set<(id: string) => void> = new Set();
  private liveChangeListeners: Set<(id: string) => void> = new Set();
  /** Each session's screen (docs/session-revive.md): what attach replays and shutdown persists. */
  private screens: Map<string, ScreenMirror> = new Map();
  private touchDebounceTimers: Map<string, NodeJS.Timeout> = new Map();
  private idleCheckInterval: NodeJS.Timeout | null = null;
  /** createSession calls past the limit check whose row isn't inserted yet. */
  private pendingCreates = 0;

  constructor() {
    this.startIdleChecker();
  }

  // N1: Shared PTY wiring — scrollback buffer + data/exit listeners.
  // Called by both createSession and forkSession to avoid duplication.
  private _initSessionPty(session: ActiveSession): void {
    const { id, pty } = session;
    this.screens.get(id)?.dispose();
    const screen = new ScreenMirror(session.cols, session.rows);
    this.screens.set(id, screen);

    pty.onData((data: string) => {
      screen.write(data);
      const listeners = this.dataListeners.get(id);
      if (listeners) {
        for (const listener of listeners) listener(data);
      }
    });

    pty.onExit(({ exitCode }) => {
      logger.info({ id, exitCode }, 'Session PTY exited');
      // Only the id's live shell may act on it. A shell killed by terminate or stop is
      // already out of activeSessions, and one that reports its exit late (past
      // PTY_EXIT_WAIT_MS) may have been revived in place meanwhile: acting on the id then
      // would revoke the new shell's token, mark its row terminated and close its viewers.
      // Every caller registers the session in the same tick as this wiring, so a genuine
      // exit always finds its own PTY.
      if (this.activeSessions.get(id)?.pty !== pty) return;
      this.handleSessionExit(id, exitCode);
    });
  }

  // The slice of this manager's private bookkeeping that forkSession, openClaudeSession and
  // reviveSession need in session-open.ts -- passed explicitly rather than reached into, so
  // that module stays free functions over these Maps instead of methods on this class.
  private _registry(): SessionRegistry {
    return {
      activeSessions: this.activeSessions,
      screens: this.screens,
      dataListeners: this.dataListeners,
      exitListeners: this.exitListeners,
      initSessionPty: (session: ActiveSession) => this._initSessionPty(session),
    };
  }

  private startIdleChecker(): void {
    const config = getConfig();
    const timeoutMs = config.sessions.idleTimeoutMinutes * 60 * 1000;
    if (timeoutMs <= 0) return;

    this.idleCheckInterval = setInterval(() => {
      const now = Date.now();
      for (const [id, session] of this.activeSessions) {
        if (session.connectedClients.size === 0) {
          const idleTime = now - session.lastAccessedAt.getTime();
          if (idleTime > timeoutMs) {
            logger.info({ id, name: session.name, idleMinutes: Math.round(idleTime / 60000) },
              'Terminating idle session');
            this.terminateSession(id);
          }
        }
      }
    }, IDLE_CHECK_INTERVAL_MS);
  }

  async createSession(options: SessionCreateOptions = {}): Promise<ActiveSession> {
    // Counted in until its row is inserted: on Linux/macOS the tmux awaits below let another
    // createSession count the table before this row is in it, and both would pass the limit.
    const activeCount = assertSessionSlot(this.pendingCreates);
    this.pendingCreates++;
    try {
      return await this.createAdmittedSession(options, activeCount);
    } finally {
      this.pendingCreates--;
    }
  }

  private async createAdmittedSession(options: SessionCreateOptions, activeCount: number): Promise<ActiveSession> {
    const config = getConfig();
    const id = randomUUID();
    const name = options.name || `Session ${activeCount + 1}`;
    const shell = options.shell || config.sessions.defaultShell || getDefaultShell();
    // No folder: the configured default (~/NodeProjects), never the server's own checkout.
    let cwd = options.cwd || defaultCwd();
    const cols = options.cols || 80;
    const rows = options.rows || 24;
    const now = new Date();
    const account = resolveStartAccount(options.account, projectCwdFor(cwd));
    // Before anything exists: a refused start leaves no row and no PTY. A Log in session
    // skips it — it is how the login gets there.
    if (!options.skipPreflight) assertAccountReady(account);
    // Only once the slot and the login are settled: a refused launch must leave no folder.
    // createFolder re-checks the path itself; the dialog's check is advisory.
    if (options.createCwd && options.cwd) cwd = await createFolder(cwd, options.createCwd);

    logger.info({ id, name, shell, cwd, account }, 'Creating new session');

    // sessionEnv: the session id for the notification hooks, and the token and
    // URLs the agent-sessions CLI uses (docs/session-orchestration.md).
    const pty = createPty({
      shell,
      cwd,
      cols,
      rows,
      account,
      env: {
        ...options.env,
        ...sessionEnv(id),
      },
    });

    // Try to create tmux session on Linux/Mac
    let tmuxSession: string | undefined;
    if (!isWindows() && (await isTmuxAvailable())) {
      const tmuxName = `claude-remote-${id.slice(0, 8)}`;
      const created = await createTmuxSession(tmuxName, shell, cwd);
      if (created) {
        tmuxSession = tmuxName;
      } else {
        logger.warn({ id, name }, 'Tmux session creation failed, session will not persist across server restarts');
      }
    }

    const session: ActiveSession = {
      id,
      name,
      shell,
      cwd,
      createdAt: now,
      lastAccessedAt: now,
      ownerId: options.ownerId,
      status: 'active',
      cols,
      rows,
      account,
      pty,
      tmuxSession,
      scrollback: [], // Will be populated from buffer when needed
      connectedClients: new Set(),
    };

    this._initSessionPty(session);

    // Persist to database first - if this fails, clean up PTY
    // New sessions go at the bottom of uncategorized (categoryId = null)
    const sortOrder = getMaxSessionSortOrder(null) + 1;

    const metadata: SessionMetadata = {
      id,
      name,
      shell,
      cwd,
      createdAt: now.toISOString(),
      lastAccessedAt: now.toISOString(),
      ownerId: options.ownerId || null,
      status: 'active',
      cols,
      rows,
      tmuxSession: tmuxSession || null,
      categoryId: null,
      sortOrder,
      claudeSessionId: null,
      isFork: false,
      forkJsonlPath: null,
      spawnedBy: options.spawnedBy ?? null,
      permissionMode: options.permissionMode ?? null,
      mcpServers: options.mcpServers ?? null,
      access: options.access ?? null,
      account,
    };

    try {
      insertSession(metadata);
      logSessionEvent(id, 'created', JSON.stringify({ shell, cwd }));
    } catch (error) {
      // Database insert failed - clean up PTY to avoid zombie process
      logger.error({ id, error }, 'Failed to persist session to database, cleaning up PTY');
      killPty(pty);
      revokeSessionToken(id);
      if (tmuxSession) {
        killTmuxSession(tmuxSession).catch(() => {});
      }
      this.dropScreen(id);
      throw error;
    }

    // Only add to active sessions after successful database insert
    this.activeSessions.set(id, session);

    logger.info({ id, name, pid: pty.pid }, 'Session created successfully');

    return session;
  }

  getSession(id: string): ActiveSession | undefined {
    return this.activeSessions.get(id);
  }

  getAllSessions(): ActiveSession[] {
    return Array.from(this.activeSessions.values());
  }

  /**
   * Sessions whose PTY is still running. A shell that exited stays in
   * activeSessions as `terminated` (its scrollback is still attachable) but
   * holds no folder open, so Land and Delete track must neither wait on it
   * nor "close" it. Both read this one list, or they drift apart again.
   */
  getRunningSessions(): ActiveSession[] {
    return this.getAllSessions().filter((s) => s.status !== 'terminated');
  }

  getSessionList(): (SessionMetadata & { attachable: boolean })[] {
    const dbSessions = getAllSessionsFromDb();
    // Mark sessions as attachable only if they have an active PTY in memory
    return dbSessions.map(session => ({
      ...session,
      attachable: this.activeSessions.has(session.id),
    }));
  }

  async terminateSession(id: string): Promise<boolean> {
    const session = this.activeSessions.get(id);
    if (!session) {
      logger.warn({ id }, 'Attempted to terminate non-existent session');
      return false;
    }

    logger.info({ id, name: session.name }, 'Terminating session');

    // Get fork metadata before any cleanup
    const metadata = getSessionMetadata(id);

    // Persist scrollback before terminating (Windows)
    const scrollback = await this.caughtUpScreen(id);
    if (isWindows() && scrollback) {
      persistScrollback(id, scrollback);
    }

    const { exited } = await this.teardownPty(id, session);

    // Update database
    updateSession(id, { status: 'terminated', lastAccessedAt: new Date().toISOString() });
    logSessionEvent(id, 'terminated');

    // Project-log: capture what this session accomplished (no-op if disabled)
    this.maybeLogSession(metadata);

    // Delete ephemeral fork JSONL
    if (metadata?.isFork && metadata.forkJsonlPath) {
      try {
        unlinkSync(metadata.forkJsonlPath);
        logger.info({ id, path: metadata.forkJsonlPath }, 'Deleted fork JSONL on terminate');
      } catch (err) {
        logger.warn({ id, err }, 'Failed to delete fork JSONL on terminate');
      }
    }

    await exited;

    return true;
  }

  /**
   * The shell half of terminate and stop: out of activeSessions, tmux and PTY killed, token
   * revoked, listeners, buffer and debounce dropped. Resolves once the kill is sent, with the
   * shell's exit wrapped (a bare promise would be flattened and awaited here), so the caller
   * writes its row first and then awaits it.
   *
   * activeSessions loses the id BEFORE the kill: the exit then finds no session of its own
   * (onExit checks the PTY is the live one), so it never marks the row 'terminated' or logs
   * it a second time. The exit is awaited at all because Land and Delete track tear the
   * folder down next, and on Windows a still-exiting shell holds its cwd. That is the SHELL
   * only: node-pty kills the rest of the console through a helper that can fail
   * (`AttachConsole failed`), so a child such as `claude` may outlive it; removeWorktree's
   * busy-folder retry is the backstop.
   */
  private async teardownPty(id: string, session: ActiveSession): Promise<{ exited: Promise<void> }> {
    this.activeSessions.delete(id);
    if (session.tmuxSession) await killTmuxSession(session.tmuxSession);

    const exited = session.status === 'terminated' ? Promise.resolve() : ptyExit(session.pty, PTY_EXIT_WAIT_MS);
    killPty(session.pty);
    revokeSessionToken(id);

    this.dataListeners.delete(id);
    this.exitListeners.delete(id);
    this.dropScreen(id);
    const debounceTimer = this.touchDebounceTimers.get(id);
    if (debounceTimer) {
      clearTimeout(debounceTimer);
      this.touchDebounceTimers.delete(id);
    }
    this.emitLiveChange(id);
    return { exited };
  }

  /**
   * Stop a running session so it can be revived later: the shell (and its `claude`) is
   * killed, the row is parked `idle` with its scrollback persisted, exactly the state
   * shutdown() leaves every session in. reviveSession() brings it back unchanged.
   * The sessions it started (`spawned_by`) are stopped first; running forks among them and
   * exited ones are left alone. A fork itself is refused: its transcript is removed on
   * restart, so it could not come back. Returns the ids stopped, parent last.
   *
   * `targets` is the stopTargets() list the caller already checked (its viewers), so a child
   * started in between is not stopped unchecked. `beforeKill(id)` runs for each session once
   * nothing can fail before its kill: the handler detaches that session's browsers there, so
   * a stop that fails part-way never leaves a running session with no one attached.
   * project/stop-sessions.md
   */
  async stopSession(
    id: string,
    options: { targets?: string[]; beforeKill?: (id: string) => void } = {}
  ): Promise<string[]> {
    const stopped: string[] = [];
    for (const sid of options.targets ?? this.stopTargets(id)) {
      if (await this.parkSession(sid, options.beforeKill)) stopped.push(sid);
    }
    return stopped;
  }

  /** A live shell (a terminated one stays in memory for its scrollback). */
  isRunning(id: string): boolean {
    const s = this.activeSessions.get(id);
    return !!s && s.status !== 'terminated';
  }

  /**
   * Move a session's conversation to `account` (project/move-conversation-account.md): every
   * refusal and the target's preflight first, so a refused move never stops anything; then a
   * running session is parked as Stop parks it (its Claude has exited, so Windows frees the
   * transcript), the transcript moves and the row's account follows. `resume` says the
   * session was running: the client revives it, which resumes under the new account.
   *
   * A failed move throws ChangeAccountError with nothing moved and the account unchanged;
   * its `stopped` says the session was parked, so the client revives it where it was.
   */
  async changeSessionAccount(
    id: string,
    account: string,
    options: { beforeKill?: (id: string) => void } = {}
  ): Promise<{ resume: boolean }> {
    if (this.movingAccount.has(id)) throw new Error('This session is already moving to another account');
    const metadata = getSessionMetadata(id);
    if (!metadata) throw new Error('Session not found');
    const children = getAllSessionsFromDb().filter((s) => s.spawnedBy === id && !s.isFork && this.isRunning(s.id)).length;
    const refusal = changeAccountRefusal(metadata, account, children);
    if (refusal) throw new Error(refusal);
    if (!findTranscript(metadata.cwd, metadata.claudeSessionId!, metadata.account)) {
      throw new Error('The conversation transcript was not found in any account');
    }
    assertAccountReady(account);
    const from = metadata.account;

    // Held from the stop to the end: nothing may revive or stop it while its files move.
    this.movingAccount.add(id);
    const running = this.isRunning(id);
    let moved = false;
    try {
      // No session log at the stop: it would read the transcript while it moves. It is
      // logged once below, from wherever the transcript ends up.
      if (running) await this.parkSession(id, options.beforeKill, { log: false });
      try {
        const result = await moveTranscript(metadata.cwd, metadata.claudeSessionId!, from, account);
        logger.info({ id, from, to: account, moved: result }, 'Moved a session to another account');
      } catch (error) {
        logger.warn({ id, from, to: account, error }, 'Could not move a session to another account');
        const reason = error instanceof Error ? error.message : String(error);
        throw new ChangeAccountError(`Could not move the conversation to ${account}: ${reason}`, running);
      }
      setSessionAccount(id, account);
      moved = true;
      const exited = this.activeSessions.get(id);
      if (exited) exited.account = account;
      logSessionEvent(id, 'account_changed', `${from ?? ''} -> ${account}`);
      return { resume: running };
    } finally {
      this.movingAccount.delete(id);
      if (running) this.maybeLogSession({ ...metadata, account: moved ? account : from });
    }
  }

  /**
   * What stopSession(id) would stop, children first and `id` last; throws why it would
   * refuse. The handler asks first, to find browsers viewing any of them.
   */
  stopTargets(id: string): string[] {
    if (this.movingAccount.has(id)) throw new Error('This session is moving to another account');
    const session = this.activeSessions.get(id);
    if (!session) throw new Error('Session is not running');
    if (session.status === 'terminated') throw new Error('Session has already exited');
    if (getSessionMetadata(id)?.isFork) {
      throw new Error('Forked sessions cannot be stopped; they could not be resumed');
    }
    const children = getAllSessionsFromDb()
      .filter((s) => s.spawnedBy === id && !s.isFork && this.isRunning(s.id))
      .map((s) => s.id);
    return [...children, id];
  }

  /**
   * The sessions Build & restart parks and the next boot revives: every running one but
   * forks, whose transcript is deleted at boot (project/revive-after-build-restart.md).
   * A session moving to another account is left alone: it is already parked for the move.
   */
  restartTargets(): string[] {
    return this.getRunningSessions()
      .filter((s) => !this.movingAccount.has(s.id) && !getSessionMetadata(s.id)?.isFork)
      .map((s) => s.id);
  }

  /**
   * Park `ids` as Stop does (scrollback persisted, PTY killed, row `idle`) so the next boot
   * revives them with their old output; the restart that follows is a hard kill, which
   * saves nothing. No session-log entry: the conversation continues after the restart.
   * All at once, since each touches only its own id and awaits its own shell's exit (up to
   * PTY_EXIT_WAIT_MS): one at a time, a slow shell would hold the restart for each of them.
   * One failing doesn't stop the rest. Returns the ids parked, in the order given.
   */
  async parkForRestart(ids: string[]): Promise<string[]> {
    const results = await Promise.allSettled(ids.map((id) => this.parkSession(id, undefined, { log: false })));
    return ids.filter((id, i) => {
      const result = results[i];
      if (result.status === 'rejected') {
        logger.warn({ id, error: result.reason }, 'Could not park a session for Build & restart');
        return false;
      }
      return result.value;
    });
  }

  /**
   * One session's half of stopSession(). False when it was no longer running (a second
   * click, or it exited meanwhile): nothing is done and it is not reported as stopped.
   */
  private async parkSession(
    id: string,
    beforeKill?: (id: string) => void,
    options: { log?: boolean } = {}
  ): Promise<boolean> {
    const session = this.activeSessions.get(id);
    if (!session || session.status === 'terminated') return false;
    logger.info({ id, name: session.name }, 'Stopping session');
    const metadata = getSessionMetadata(id);

    // On every platform, as shutdown() does: revive seeds the new shell from it. First, so a
    // failed write leaves the session running and its browsers still attached.
    const scrollback = await this.caughtUpScreen(id);
    if (scrollback) persistScrollback(id, scrollback);

    beforeKill?.(id);
    const { exited } = await this.teardownPty(id, session);

    updateSession(id, { status: 'idle', lastAccessedAt: new Date().toISOString() });
    logSessionEvent(id, 'stopped');
    if (options.log !== false) this.maybeLogSession(metadata);

    await exited;
    return true;
  }

  async deleteSession(id: string): Promise<boolean> {
    // Get fork metadata before any deletion
    const metadata = getSessionMetadata(id);

    if (this.activeSessions.has(id)) {
      // terminateSession handles JSONL cleanup for active forks
      await this.terminateSession(id);
    } else if (metadata?.isFork && metadata.forkJsonlPath) {
      // Already terminated fork — clean up JSONL now
      try {
        unlinkSync(metadata.forkJsonlPath);
        logger.info({ id, path: metadata.forkJsonlPath }, 'Deleted fork JSONL on delete');
      } catch (err) {
        logger.warn({ id, err }, 'Failed to delete fork JSONL on delete');
      }
    }

    deletePromptFile(id);
    deleteUploads(id);

    // Log before deleting (foreign key constraint)
    logSessionEvent(id, 'deleted');

    // Delete from database (cascades to logs)
    deleteSessionFromDb(id);

    return true;
  }

  /**
   * Delete every session row whose cwd is in `worktreePath` — running or not:
   * once Land or Delete track removes the folder, none of them can attach or
   * revive. Returns the ids deleted so the caller can tell clients.
   */
  async deleteSessionsIn(worktreePath: string): Promise<string[]> {
    const ids = sessionsInWorktree(getAllSessionsFromDb(), worktreePath).map((s) => s.id);
    for (const id of ids) await this.deleteSession(id);
    return ids;
  }

  writeToSession(id: string, data: string): boolean {
    const session = this.activeSessions.get(id);
    if (!session) {
      logger.warn({ id }, 'Attempted to write to non-existent session');
      return false;
    }

    writeToPty(session.pty, data);
    this.touchSession(id);
    return true;
  }

  resizeSession(id: string, cols: number, rows: number): boolean {
    const session = this.activeSessions.get(id);
    if (!session) {
      logger.warn({ id }, 'Attempted to resize non-existent session');
      return false;
    }

    resizePty(session.pty, cols, rows);
    this.screens.get(id)?.resize(cols, rows);
    session.cols = cols;
    session.rows = rows;
    updateSession(id, { cols, rows });
    return true;
  }

  renameSession(id: string, name: string): boolean {
    const session = this.activeSessions.get(id);
    if (!session) {
      logger.warn({ id }, 'Attempted to rename non-existent session');
      return false;
    }

    session.name = name;
    updateSession(id, { name });
    logSessionEvent(id, 'renamed', name);
    return true;
  }

  onData(id: string, listener: (data: string) => void): () => void {
    if (!this.dataListeners.has(id)) {
      this.dataListeners.set(id, new Set());
    }
    this.dataListeners.get(id)!.add(listener);

    return () => {
      this.dataListeners.get(id)?.delete(listener);
    };
  }

  /**
   * Called with the id of every session whose shell exits on its own, after its row is
   * marked 'terminated'. The sidebar learns that way that the row may now be revived;
   * `onExit` reaches only the browsers attached to that one session.
   */
  onAnyExit(listener: (id: string) => void): () => void {
    this.anyExitListeners.add(listener);
    return () => {
      this.anyExitListeners.delete(listener);
    };
  }

  /**
   * Called with a session's id whenever it stops running or runs again: an exit, a
   * terminate, a stop or park, and a revive. The factory reads it to show a unit a
   * session holds as paused the moment its terminal closes (factory/session-claims.ts).
   */
  onAnyLiveChange(listener: (id: string) => void): () => void {
    this.liveChangeListeners.add(listener);
    return () => {
      this.liveChangeListeners.delete(listener);
    };
  }

  private emitLiveChange(id: string): void {
    for (const listener of this.liveChangeListeners) {
      try {
        listener(id);
      } catch (err) {
        logger.warn({ id, err }, 'Session live-change listener failed');
      }
    }
  }

  onExit(id: string, listener: (code: number) => void): () => void {
    if (!this.exitListeners.has(id)) {
      this.exitListeners.set(id, new Set());
    }
    this.exitListeners.get(id)!.add(listener);

    return () => {
      this.exitListeners.get(id)?.delete(listener);
    };
  }

  addClient(id: string, clientId: string): void {
    const session = this.activeSessions.get(id);
    if (session) {
      session.connectedClients.add(clientId);
      this.touchSession(id);
      logSessionEvent(id, 'client_connected', clientId);
    }
  }

  removeClient(id: string, clientId: string): void {
    const session = this.activeSessions.get(id);
    if (session) {
      session.connectedClients.delete(clientId);
      logSessionEvent(id, 'client_disconnected', clientId);

      // Update status to idle if no clients connected — never for a shell that
      // exited: switching away from it would make it "idle", which
      // getRunningSessions counts, so Land would try to close a dead shell
      // and wait out PTY_EXIT_WAIT_MS for an exit that already happened.
      if (session.connectedClients.size === 0 && session.status !== 'terminated') {
        session.status = 'idle';
        updateSession(id, { status: 'idle' });
      }
    }
  }

  /**
   * The session's screen as escape sequences, for a fresh terminal of its current size.
   * Synchronous, so it can miss output still queued in the mirror: attach uses
   * withScrollback(), which can't.
   */
  getScrollback(id: string): string {
    const screen = this.screens.get(id);
    if (screen) return screen.snapshot();
    return this.storedScrollback(id);
  }

  /**
   * Calls `fn` with the session's screen once the mirror holds every byte the PTY sent
   * before this call. A caller that subscribes to onData in the same tick as this call, and
   * holds what arrives until `fn` runs, sees every byte exactly once.
   */
  withScrollback(id: string, fn: (scrollback: string) => void): void {
    const screen = this.screens.get(id);
    if (!screen) {
      fn(this.storedScrollback(id));
      return;
    }
    screen.afterQueued(() => fn(screen.snapshot()));
  }

  /** A persisted scrollback for a session with no live screen, ready to write as-is. */
  private storedScrollback(id: string): string {
    return storedToReplay(restoreScrollbackRaw(id));
  }

  /** The session's screen for storage, once it holds every byte the PTY has sent. */
  private async caughtUpScreen(id: string): Promise<string> {
    const screen = this.screens.get(id);
    if (!screen) return '';
    await screen.caughtUp();
    return screen.persistable();
  }

  private dropScreen(id: string): void {
    this.screens.get(id)?.dispose();
    this.screens.delete(id);
  }

  private touchSession(id: string): void {
    const session = this.activeSessions.get(id);
    // A session whose shell exited stays here (its scrollback is attachable),
    // and attaching or typing into it must not bring it back to 'active':
    // getRunningSessions would count it again, and Land and Delete track would
    // "close" a shell that is already gone.
    if (!session || session.status === 'terminated') return;

    session.lastAccessedAt = new Date();
    session.status = 'active';

    // Debounce database updates for session activity
    if (!this.touchDebounceTimers.has(id)) {
      this.touchDebounceTimers.set(id, setTimeout(() => {
        this.touchDebounceTimers.delete(id);
        const currentSession = this.activeSessions.get(id);
        // Re-checked: the shell may have exited within the debounce window
        // (typing `exit` does exactly that), and this write would otherwise
        // overwrite the row's 'terminated' with 'active'.
        if (currentSession && currentSession.status !== 'terminated') {
          updateSession(id, {
            lastAccessedAt: currentSession.lastAccessedAt.toISOString(),
            status: 'active',
          });
        }
      }, DB_UPDATE_DEBOUNCE_MS));
    }
  }

  private handleSessionExit(id: string, exitCode: number): void {
    revokeSessionToken(id);
    const listeners = this.exitListeners.get(id);
    if (listeners) {
      for (const listener of listeners) {
        listener(exitCode);
      }
    }

    // Mark session as terminated
    const session = this.activeSessions.get(id);
    if (session) {
      session.status = 'terminated';
      updateSession(id, { status: 'terminated', lastAccessedAt: new Date().toISOString() });
      logSessionEvent(id, 'exited', String(exitCode));
      this.emitLiveChange(id);
      for (const listener of this.anyExitListeners) {
        try {
          listener(id);
        } catch (err) {
          logger.warn({ id, err }, 'Session exit listener failed');
        }
      }

      // Persist scrollback on Windows, once the mirror has the shell's last output.
      const screen = this.screens.get(id);
      if (isWindows() && screen) {
        screen.afterQueued(() => {
          const scrollback = screen.persistable();
          if (!scrollback) return;
          try {
            persistScrollback(id, scrollback);
          } catch (error) {
            logger.warn({ id, error }, 'Failed to persist scrollback of an exited session');
          }
        });
      }

      // Delete ephemeral fork JSONL on natural exit
      const metadata = getSessionMetadata(id);

      // Project-log: capture what this session accomplished (no-op if disabled)
      this.maybeLogSession(metadata);

      if (metadata?.isFork && metadata.forkJsonlPath) {
        try {
          unlinkSync(metadata.forkJsonlPath);
          logger.info({ id, path: metadata.forkJsonlPath }, 'Deleted fork JSONL on exit');
        } catch (err) {
          logger.warn({ id, err }, 'Failed to delete fork JSONL on exit');
        }
      }
    }
  }

  /**
   * Fire-and-forget: generate a SESSION-LOG.md entry for a just-ended session.
   * Inert unless the feature is enabled; skips forks and sessions with no known
   * Claude session id. generateSessionLog handles its own skip-gate and stamping.
   */
  private maybeLogSession(metadata: SessionMetadata | null): void {
    if (!metadata) return;
    if (!getConfig().projectLog?.enabled) return;
    if (metadata.isFork || !metadata.claudeSessionId) return;
    void generateSessionLog({
      sessionId: metadata.id,
      name: metadata.name,
      cwd: metadata.cwd,
      claudeSessionId: metadata.claudeSessionId,
      createdAt: metadata.createdAt,
      account: metadata.account,
      access: metadata.access ?? null,
    });
  }

  async forkSession(sourceId: string, options: { ownerId?: string; cols?: number; rows?: number } = {}): Promise<ActiveSession> {
    return forkSessionImpl(this._registry(), sourceId, options);
  }

  /**
   * Open a Claude session recorded in a project's session history, without needing a live
   * source session. `resume` continues the original transcript in place; `fork` first copies
   * the transcript to a fresh id (ephemeral, isFork) exactly like forkSession. In both cases a
   * new PTY is created in `cwd` and `claude --resume` is injected once the shell is ready.
   */
  async openClaudeSession(options: {
    claudeSessionId: string;
    cwd: string;
    mode: 'resume' | 'fork';
    name?: string;
    ownerId?: string;
    cols?: number;
    rows?: number;
    account?: string;
  }): Promise<ActiveSession> {
    return openClaudeSessionImpl(this._registry(), options);
  }

  /**
   * Bring a stale session back to life in place. "Stale" is a DB row that outlived its PTY:
   * shutdown() deliberately marks sessions 'idle' rather than 'terminated' so they can be
   * reconnected after a restart. The row keeps its id, name, category, sort order and
   * persisted scrollback -- only the PTY is new. When the row carries a claudeSessionId the
   * conversation is resumed too, exactly as openClaudeSession does.
   *
   * Deliberately no maxSessions check: a stale row is already status != 'terminated', so it
   * counts toward countActiveSessions(). Re-checking the cap here would make every session
   * unrevivable after a restart at the limit.
   */
  reviveSession(options: { id: string; cols?: number; rows?: number }): ActiveSession {
    if (this.movingAccount.has(options.id)) throw new Error('This session is moving to another account; try again in a moment');
    const session = reviveSessionImpl(this._registry(), killPty, options);
    this.emitLiveChange(options.id);
    return session;
  }

  keepForkSession(id: string): boolean {
    clearForkFlag(id);
    logSessionEvent(id, 'fork_kept');
    logger.info({ id }, 'Fork session kept');
    return true;
  }

  async shutdown(): Promise<void> {
    logger.info('Shutting down session manager');

    // Stop idle checker
    if (this.idleCheckInterval) {
      clearInterval(this.idleCheckInterval);
      this.idleCheckInterval = null;
    }

    // Clear all debounce timers
    for (const timer of this.touchDebounceTimers.values()) {
      clearTimeout(timer);
    }
    this.touchDebounceTimers.clear();

    for (const [id, session] of this.activeSessions) {
      const meta = getSessionMetadata(id);

      if (meta?.isFork && meta.forkJsonlPath) {
        // Fork sessions are ephemeral: delete JSONL and mark terminated on shutdown
        try { unlinkSync(meta.forkJsonlPath); } catch { /* best-effort cleanup */ }
        updateSession(id, { status: 'terminated', lastAccessedAt: new Date().toISOString() });
      } else {
        // Persist scrollback
        const scrollback = await this.caughtUpScreen(id);
        if (scrollback) {
          persistScrollback(id, scrollback);
        }
        // Mark as idle (not terminated, so we can reconnect on restart)
        updateSession(id, { status: 'idle', lastAccessedAt: new Date().toISOString() });
      }

      // Kill PTY but keep tmux session alive on Linux
      if (!session.tmuxSession) {
        killPty(session.pty);
      }
    }

    revokeAllSessionTokens();
    this.activeSessions.clear();
    this.dataListeners.clear();
    this.exitListeners.clear();
    for (const screen of this.screens.values()) screen.dispose();
    this.screens.clear();
  }
}

// Singleton instance
let sessionManagerInstance: SessionManager | null = null;

/**
 * Get the singleton SessionManager instance.
 * Creates a new instance if one doesn't exist.
 */
export function getSessionManager(): SessionManager {
  if (!sessionManagerInstance) {
    sessionManagerInstance = new SessionManager();
  }
  return sessionManagerInstance;
}

/**
 * Create a new SessionManager instance.
 * Useful for testing where you need isolated instances.
 */
export function createSessionManager(): SessionManager {
  return new SessionManager();
}

/**
 * Reset the singleton instance.
 * Only use this in tests to ensure clean state between test runs.
 */
export async function resetSessionManager(): Promise<void> {
  if (sessionManagerInstance) {
    await sessionManagerInstance.shutdown();
    sessionManagerInstance = null;
  }
}

// Startup sweeps (crash recovery for forks, project-log reconciliation) live in
// boot-sweep.ts -- re-exported here since app.ts imports them alongside sessionManager.
export { cleanupOrphanedForkFiles, sweepUnloggedSessions } from './boot-sweep.js';

// Default export for backward compatibility
export const sessionManager = getSessionManager();
