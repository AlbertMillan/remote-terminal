import { randomUUID } from 'crypto';
import { copyFileSync, existsSync, readdirSync, unlinkSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { createPty, resizePty, writeToPty, killPty, ScrollbackBuffer } from './pty-handler.js';
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

const logger = createLogger('session-manager');

// C1: Robust JSONL location — tries computed slug first, falls back to scanning all project dirs.
// Claude Code derives its project folder by replacing path separators with '-', but the exact
// algorithm may vary. Scanning by known session ID is always correct.
function findClaudeProjectDir(homeDir: string, cwd: string, claudeSessionId: string): string {
  const projectsDir = join(homeDir, '.claude', 'projects');
  const slug = cwd.replace(/[:\\/]/g, '-').replace(/^-+/, '');
  const computedDir = join(projectsDir, slug);
  if (existsSync(join(computedDir, `${claudeSessionId}.jsonl`))) {
    return computedDir;
  }
  try {
    const entries = readdirSync(projectsDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (existsSync(join(projectsDir, entry.name, `${claudeSessionId}.jsonl`))) {
        return join(projectsDir, entry.name);
      }
    }
  } catch {
    // projectsDir not readable
  }
  throw new Error(
    `Claude session transcript not found for session "${claudeSessionId}". ` +
    `Searched in ${projectsDir}. Ensure the claude-session hook is configured ` +
    `and Claude has stopped at least once in this terminal.`
  );
}

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

  async forkSession(sourceId: string, options: { ownerId?: string; cols?: number; rows?: number } = {}): Promise<ActiveSession> {
    // C5: Reject immediately if source session is not active
    if (!this.activeSessions.has(sourceId)) {
      throw new Error('Source session is not active');
    }

    const config = getConfig();
    const activeCount = countActiveSessions();
    if (activeCount >= config.sessions.maxSessions) {
      throw new Error(`Maximum session limit (${config.sessions.maxSessions}) reached`);
    }

    const sourceMetadata = getSessionMetadata(sourceId);
    if (!sourceMetadata) throw new Error('Source session not found');

    const { claudeSessionId } = sourceMetadata;
    if (!claudeSessionId) {
      throw new Error(
        'No Claude session ID registered for this session. ' +
        'Ensure the claude-session hook is configured in ~/.claude/settings.json ' +
        'and Claude has stopped at least once in this terminal.'
      );
    }

    // C1: Robust project dir lookup — computed slug first, fallback scans all project dirs
    const projectDir = findClaudeProjectDir(homedir(), sourceMetadata.cwd, claudeSessionId);
    const sourceJsonlPath = join(projectDir, `${claudeSessionId}.jsonl`);
    const newClaudeSessionId = randomUUID();
    const destJsonlPath = join(projectDir, `${newClaudeSessionId}.jsonl`);

    const id = randomUUID();
    const name = `Fork: ${sourceMetadata.name}`;
    const shell = sourceMetadata.shell;
    const cwd = sourceMetadata.cwd;
    const cols = options.cols || sourceMetadata.cols;
    const rows = options.rows || sourceMetadata.rows;
    const now = new Date();
    const sortOrder = getMaxSessionSortOrder(null) + 1;

    logger.info({ id, sourceId, name }, 'Creating fork session');

    // C3: Insert DB record FIRST so forkJsonlPath is tracked before any file operations.
    // If the server crashes after this point, cleanupOrphanedForkFiles() recovers on next start.
    const metadata: SessionMetadata = {
      id, name, shell, cwd,
      createdAt: now.toISOString(),
      lastAccessedAt: now.toISOString(),
      ownerId: options.ownerId || null,
      status: 'active',
      cols, rows,
      tmuxSession: null,
      categoryId: null,
      sortOrder,
      claudeSessionId: newClaudeSessionId,
      isFork: true,
      forkJsonlPath: destJsonlPath,
    };
    insertSession(metadata);

    // Copy transcript (DB record exists, so crash here is recoverable on next startup)
    try {
      copyFileSync(sourceJsonlPath, destJsonlPath);
    } catch (error) {
      updateSession(id, { status: 'terminated', lastAccessedAt: now.toISOString() });
      throw new Error(`Failed to copy session transcript: ${error instanceof Error ? error.message : error}`);
    }

    // Create PTY
    let ptyProcess;
    try {
      ptyProcess = createPty({ shell, cwd, cols, rows, env: { CLAUDE_REMOTE_SESSION_ID: id } });
    } catch (error) {
      try { unlinkSync(destJsonlPath); } catch {}
      updateSession(id, { status: 'terminated', lastAccessedAt: now.toISOString() });
      throw error;
    }

    const session: ActiveSession = {
      id, name, shell, cwd,
      createdAt: now, lastAccessedAt: now,
      ownerId: options.ownerId,
      status: 'active',
      cols, rows,
      pty: ptyProcess,
      scrollback: [],
      connectedClients: new Set(),
    };

    // N1: shared PTY init
    this._initSessionPty(session);
    this.activeSessions.set(id, session);
    logSessionEvent(id, 'forked', JSON.stringify({ sourceId, claudeSessionId: newClaudeSessionId }));

    // C4: Inject resume command after the shell produces first output (= ready for input).
    // Debounced 100ms so rc-file output settles; 5s hard fallback if shell stays silent.
    let commandSent = false;
    let debounceTimer: ReturnType<typeof setTimeout> | null = null;
    const startupDisposable = ptyProcess.onData(() => {
      if (commandSent) return;
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        if (!commandSent) {
          commandSent = true;
          startupDisposable.dispose();
          writeToPty(session.pty, `claude --resume ${newClaudeSessionId}\r`);
        }
      }, 100);
    });
    setTimeout(() => {
      if (!commandSent) {
        commandSent = true;
        writeToPty(session.pty, `claude --resume ${newClaudeSessionId}\r`);
      }
    }, 5000);

    logger.info({ id, name, pid: ptyProcess.pid }, 'Fork session created successfully');
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
        try { unlinkSync(meta.forkJsonlPath); } catch {}
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

/**
 * Called on server startup to recover from crashes mid-fork.
 * Any fork session that isn't 'terminated' at startup has no live PTY —
 * delete its JSONL and mark it terminated so it doesn't reappear as stale.
 */
export function cleanupOrphanedForkFiles(): void {
  const dbSessions = getAllSessionsFromDb();
  for (const session of dbSessions) {
    if (!session.isFork || session.status === 'terminated') continue;
    if (session.forkJsonlPath) {
      try {
        unlinkSync(session.forkJsonlPath);
        logger.info({ id: session.id, path: session.forkJsonlPath }, 'Cleaned up orphaned fork JSONL');
      } catch {
        // File may not exist if crash happened before copy completed
      }
    }
    updateSession(session.id, { status: 'terminated', lastAccessedAt: new Date().toISOString() });
  }
}

// Default export for backward compatibility
export const sessionManager = getSessionManager();
