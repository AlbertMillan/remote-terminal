import { randomUUID } from 'crypto';
import { unlinkSync } from 'fs';
import { createPty, resizePty, writeToPty, killPty, ScrollbackBuffer } from './pty-handler.js';
import { generateSessionLog } from './project-log.js';
import type { ActiveSession, SessionCreateOptions, SessionMetadata } from './types.js';
import { getConfig } from '../config.js';
import { createLogger } from '../utils/logger.js';
import { getDefaultShell, isWindows } from '../utils/platform.js';
import {
  insertSession,
  updateSession,
  getAllSessions as getAllSessionsFromDb,
  deleteSession as deleteSessionFromDb,
  getSession as getSessionMetadata,
  countActiveSessions,
  logSessionEvent,
  getMaxSessionSortOrder,
  clearForkFlag,
} from '../db/queries.js';
import {
  createTmuxSession,
  killTmuxSession,
  persistScrollback,
  restoreScrollback,
  isTmuxAvailable,
} from './persistence.js';
import {
  forkSession as forkSessionImpl,
  openClaudeSession as openClaudeSessionImpl,
  reviveSession as reviveSessionImpl,
  type SessionRegistry,
} from './session-open.js';

const logger = createLogger('session-manager');


// Configuration constants
const IDLE_CHECK_INTERVAL_MS = 60000; // Check for idle sessions every minute
const DB_UPDATE_DEBOUNCE_MS = 5000; // Debounce database updates for session activity

class SessionManager {
  private activeSessions: Map<string, ActiveSession> = new Map();
  private dataListeners: Map<string, Set<(data: string) => void>> = new Map();
  private exitListeners: Map<string, Set<(code: number) => void>> = new Map();
  private scrollbackBuffers: Map<string, ScrollbackBuffer> = new Map();
  private touchDebounceTimers: Map<string, NodeJS.Timeout> = new Map();
  private idleCheckInterval: NodeJS.Timeout | null = null;

  constructor() {
    this.startIdleChecker();
  }

  // N1: Shared PTY wiring — scrollback buffer + data/exit listeners.
  // Called by both createSession and forkSession to avoid duplication.
  private _initSessionPty(session: ActiveSession): void {
    const { id, pty } = session;
    const scrollbackBuffer = new ScrollbackBuffer();
    this.scrollbackBuffers.set(id, scrollbackBuffer);

    pty.onData((data: string) => {
      scrollbackBuffer.push(data);
      const listeners = this.dataListeners.get(id);
      if (listeners) {
        for (const listener of listeners) listener(data);
      }
    });

    pty.onExit(({ exitCode }) => {
      logger.info({ id, exitCode }, 'Session PTY exited');
      this.handleSessionExit(id, exitCode);
    });
  }

  // The slice of this manager's private bookkeeping that forkSession, openClaudeSession and
  // reviveSession need in session-open.ts -- passed explicitly rather than reached into, so
  // that module stays free functions over these Maps instead of methods on this class.
  private _registry(): SessionRegistry {
    return {
      activeSessions: this.activeSessions,
      scrollbackBuffers: this.scrollbackBuffers,
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
    const config = getConfig();

    // Check session limit
    const activeCount = countActiveSessions();
    if (activeCount >= config.sessions.maxSessions) {
      throw new Error(`Maximum session limit (${config.sessions.maxSessions}) reached`);
    }

    const id = randomUUID();
    const name = options.name || `Session ${activeCount + 1}`;
    const shell = options.shell || config.sessions.defaultShell || getDefaultShell();
    const cwd = options.cwd || process.cwd();
    const cols = options.cols || 80;
    const rows = options.rows || 24;
    const now = new Date();

    logger.info({ id, name, shell, cwd }, 'Creating new session');

    // Create PTY with session ID environment variable for webhook notifications
    const pty = createPty({
      shell,
      cwd,
      cols,
      rows,
      env: {
        ...options.env,
        CLAUDE_REMOTE_SESSION_ID: id,
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
    };

    try {
      insertSession(metadata);
      logSessionEvent(id, 'created', JSON.stringify({ shell, cwd }));
    } catch (error) {
      // Database insert failed - clean up PTY to avoid zombie process
      logger.error({ id, error }, 'Failed to persist session to database, cleaning up PTY');
      killPty(pty);
      if (tmuxSession) {
        killTmuxSession(tmuxSession).catch(() => {});
      }
      this.scrollbackBuffers.delete(id);
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
    const scrollback = this.scrollbackBuffers.get(id)?.getAll() || [];
    if (isWindows() && scrollback.length > 0) {
      persistScrollback(id, scrollback);
    }

    // Kill tmux session if exists
    if (session.tmuxSession) {
      await killTmuxSession(session.tmuxSession);
    }

    // Kill PTY
    killPty(session.pty);

    // Clean up listeners and buffers
    this.dataListeners.delete(id);
    this.exitListeners.delete(id);
    this.scrollbackBuffers.delete(id);

    // Clean up debounce timer
    const debounceTimer = this.touchDebounceTimers.get(id);
    if (debounceTimer) {
      clearTimeout(debounceTimer);
      this.touchDebounceTimers.delete(id);
    }

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

    // Remove from active sessions
    this.activeSessions.delete(id);

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

    // Log before deleting (foreign key constraint)
    logSessionEvent(id, 'deleted');

    // Delete from database (cascades to logs)
    deleteSessionFromDb(id);

    return true;
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

      // Update status to idle if no clients connected
      if (session.connectedClients.size === 0) {
        session.status = 'idle';
        updateSession(id, { status: 'idle' });
      }
    }
  }

  getScrollback(id: string): string[] {
    // Get from in-memory buffer first
    const buffer = this.scrollbackBuffers.get(id);
    if (buffer) {
      return buffer.getAll();
    }
    // Try to restore from database (Windows)
    return restoreScrollback(id);
  }

  private touchSession(id: string): void {
    const session = this.activeSessions.get(id);
    if (!session) return;

    session.lastAccessedAt = new Date();
    session.status = 'active';

    // Debounce database updates for session activity
    if (!this.touchDebounceTimers.has(id)) {
      this.touchDebounceTimers.set(id, setTimeout(() => {
        this.touchDebounceTimers.delete(id);
        const currentSession = this.activeSessions.get(id);
        if (currentSession) {
          updateSession(id, {
            lastAccessedAt: currentSession.lastAccessedAt.toISOString(),
            status: 'active',
          });
        }
      }, DB_UPDATE_DEBOUNCE_MS));
    }
  }

  private handleSessionExit(id: string, exitCode: number): void {
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

      // Persist scrollback on Windows
      const scrollback = this.scrollbackBuffers.get(id)?.getAll() || [];
      if (isWindows() && scrollback.length > 0) {
        persistScrollback(id, scrollback);
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
    return reviveSessionImpl(this._registry(), killPty, options);
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
        const scrollback = this.scrollbackBuffers.get(id)?.getAll() || [];
        if (scrollback.length > 0) {
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

    this.activeSessions.clear();
    this.dataListeners.clear();
    this.exitListeners.clear();
    this.scrollbackBuffers.clear();
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
