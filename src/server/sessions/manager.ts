import { randomUUID } from 'crypto';
import type { IPty } from 'node-pty';
import { createPty, resizePty, writeToPty, killPty, ScrollbackBuffer } from './pty-handler.js';
import type { Session, ActiveSession, SessionCreateOptions, SessionMetadata, SessionStatus } from './types.js';
import { getConfig } from '../config.js';
import { createLogger } from '../utils/logger.js';
import { getDefaultShell, isWindows } from '../utils/platform.js';
import {
  insertSession,
  updateSession,
  getSession as getSessionFromDb,
  getAllSessions as getAllSessionsFromDb,
  deleteSession as deleteSessionFromDb,
  countActiveSessions,
  logSessionEvent,
} from '../db/queries.js';
import {
  createTmuxSession,
  killTmuxSession,
  tmuxSessionExists,
  persistScrollback,
  restoreScrollback,
  isTmuxAvailable,
} from './persistence.js';

const logger = createLogger('session-manager');

class SessionManager {
  private activeSessions: Map<string, ActiveSession> = new Map();
  private dataListeners: Map<string, Set<(data: string) => void>> = new Map();
  private exitListeners: Map<string, Set<(code: number) => void>> = new Map();

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

    // Create PTY
    const pty = createPty({
      shell,
      cwd,
      cols,
      rows,
      env: options.env,
    });

    // Try to create tmux session on Linux/Mac
    let tmuxSession: string | undefined;
    if (!isWindows() && (await isTmuxAvailable())) {
      const tmuxName = `claude-remote-${id.slice(0, 8)}`;
      const created = await createTmuxSession(tmuxName, shell, cwd);
      if (created) {
        tmuxSession = tmuxName;
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
      scrollback: [],
      connectedClients: new Set(),
    };

    // Initialize scrollback buffer
    const scrollbackBuffer = new ScrollbackBuffer();

    // Set up data listener
    pty.onData((data: string) => {
      scrollbackBuffer.push(data);
      session.scrollback = scrollbackBuffer.getAll();

      const listeners = this.dataListeners.get(id);
      if (listeners) {
        for (const listener of listeners) {
          listener(data);
        }
      }
    });

    // Set up exit listener
    pty.onExit(({ exitCode }) => {
      logger.info({ id, exitCode }, 'Session PTY exited');
      this.handleSessionExit(id, exitCode);
    });

    // Store session
    this.activeSessions.set(id, session);

    // Persist to database
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
    };
    insertSession(metadata);
    logSessionEvent(id, 'created', JSON.stringify({ shell, cwd }));

    logger.info({ id, name, pid: pty.pid }, 'Session created successfully');

    return session;
  }

  getSession(id: string): ActiveSession | undefined {
    return this.activeSessions.get(id);
  }

  getAllSessions(): ActiveSession[] {
    return Array.from(this.activeSessions.values());
  }

  getSessionList(): SessionMetadata[] {
    return getAllSessionsFromDb();
  }

  async terminateSession(id: string): Promise<boolean> {
    const session = this.activeSessions.get(id);
    if (!session) {
      logger.warn({ id }, 'Attempted to terminate non-existent session');
      return false;
    }

    logger.info({ id, name: session.name }, 'Terminating session');

    // Persist scrollback before terminating (Windows)
    if (isWindows() && session.scrollback.length > 0) {
      persistScrollback(id, session.scrollback);
    }

    // Kill tmux session if exists
    if (session.tmuxSession) {
      await killTmuxSession(session.tmuxSession);
    }

    // Kill PTY
    killPty(session.pty);

    // Clean up listeners
    this.dataListeners.delete(id);
    this.exitListeners.delete(id);

    // Update database
    updateSession(id, { status: 'terminated', lastAccessedAt: new Date().toISOString() });
    logSessionEvent(id, 'terminated');

    // Remove from active sessions
    this.activeSessions.delete(id);

    return true;
  }

  async deleteSession(id: string): Promise<boolean> {
    // Terminate if active
    if (this.activeSessions.has(id)) {
      await this.terminateSession(id);
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
    const session = this.activeSessions.get(id);
    if (session) {
      return session.scrollback;
    }
    // Try to restore from database (Windows)
    return restoreScrollback(id);
  }

  private touchSession(id: string): void {
    const session = this.activeSessions.get(id);
    if (session) {
      session.lastAccessedAt = new Date();
      session.status = 'active';
      updateSession(id, {
        lastAccessedAt: session.lastAccessedAt.toISOString(),
        status: 'active',
      });
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
      if (isWindows() && session.scrollback.length > 0) {
        persistScrollback(id, session.scrollback);
      }
    }
  }

  async shutdown(): Promise<void> {
    logger.info('Shutting down session manager');

    for (const [id, session] of this.activeSessions) {
      // Persist scrollback
      if (session.scrollback.length > 0) {
        persistScrollback(id, session.scrollback);
      }

      // Mark as idle (not terminated, so we can reconnect on restart)
      updateSession(id, { status: 'idle', lastAccessedAt: new Date().toISOString() });

      // Kill PTY but keep tmux session alive on Linux
      if (!session.tmuxSession) {
        killPty(session.pty);
      }
    }

    this.activeSessions.clear();
    this.dataListeners.clear();
    this.exitListeners.clear();
  }
}

// Singleton instance
export const sessionManager = new SessionManager();
