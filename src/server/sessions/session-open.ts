import { randomUUID } from 'crypto';
import { copyFileSync, unlinkSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { createPty, writeToPty, type ScrollbackBuffer } from './pty-handler.js';
import { findClaudeProjectDir } from './transcript.js';
import type { ActiveSession, SessionMetadata } from './types.js';
import { getConfig } from '../config.js';
import { createLogger } from '../utils/logger.js';
import { getDefaultShell } from '../utils/platform.js';
import {
  insertSession,
  updateSession,
  getSession as getSessionMetadata,
  countActiveSessions,
  logSessionEvent,
  getMaxSessionSortOrder,
} from '../db/queries.js';
import { restoreScrollbackRaw } from './persistence.js';

const logger = createLogger('session-manager');

/**
 * The slice of SessionManager's private bookkeeping that forkSession, openClaudeSession and
 * reviveSession need. Passed explicitly by the manager rather than reached into, so these
 * stay free functions over the manager's own Maps instead of methods on the class.
 */
export interface SessionRegistry {
  activeSessions: Map<string, ActiveSession>;
  scrollbackBuffers: Map<string, ScrollbackBuffer>;
  dataListeners: Map<string, Set<(data: string) => void>>;
  exitListeners: Map<string, Set<(code: number) => void>>;
  initSessionPty(session: ActiveSession): void;
}

// C4: Inject `claude --resume <id>` once the shell produces its first output (= ready for
// input). Debounced 100ms so rc-file output settles; 5s hard fallback if the shell stays
// silent. Shared by forkSession and openClaudeSession.
export function injectResumeCommand(session: ActiveSession, resumeId: string): void {
  let commandSent = false;
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  const startupDisposable = session.pty.onData(() => {
    if (commandSent) return;
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      if (!commandSent) {
        commandSent = true;
        startupDisposable.dispose();
        writeToPty(session.pty, `claude --resume ${resumeId}\r`);
      }
    }, 100);
  });
  setTimeout(() => {
    if (!commandSent) {
      commandSent = true;
      writeToPty(session.pty, `claude --resume ${resumeId}\r`);
    }
  }, 5000);
}

export async function forkSession(
  registry: SessionRegistry,
  sourceId: string,
  options: { ownerId?: string; cols?: number; rows?: number } = {}
): Promise<ActiveSession> {
  // C5: Reject immediately if source session is not active
  if (!registry.activeSessions.has(sourceId)) {
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
    try { unlinkSync(destJsonlPath); } catch { /* best-effort cleanup */ }
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
  registry.initSessionPty(session);
  registry.activeSessions.set(id, session);
  logSessionEvent(id, 'forked', JSON.stringify({ sourceId, claudeSessionId: newClaudeSessionId }));

  injectResumeCommand(session, newClaudeSessionId);

  logger.info({ id, name, pid: ptyProcess.pid }, 'Fork session created successfully');
  return session;
}

/**
 * Open a Claude session recorded in a project's session history, without needing a live
 * source session. `resume` continues the original transcript in place; `fork` first copies
 * the transcript to a fresh id (ephemeral, isFork) exactly like forkSession. In both cases a
 * new PTY is created in `cwd` and `claude --resume` is injected once the shell is ready.
 */
export async function openClaudeSession(
  registry: SessionRegistry,
  options: {
    claudeSessionId: string;
    cwd: string;
    mode: 'resume' | 'fork';
    name?: string;
    ownerId?: string;
    cols?: number;
    rows?: number;
  }
): Promise<ActiveSession> {
  const { claudeSessionId, cwd, mode } = options;

  const config = getConfig();
  const activeCount = countActiveSessions();
  if (activeCount >= config.sessions.maxSessions) {
    throw new Error(`Maximum session limit (${config.sessions.maxSessions}) reached`);
  }

  const shell = config.sessions.defaultShell || getDefaultShell();
  const cols = options.cols || 80;
  const rows = options.rows || 24;
  const now = new Date();
  const id = randomUUID();
  const sortOrder = getMaxSessionSortOrder(null) + 1;

  // In fork mode we must locate and copy the source transcript. In resume mode we run against
  // the original id directly and let `claude --resume` surface any missing-transcript error.
  let resumeId = claudeSessionId;
  let isFork = false;
  let forkJsonlPath: string | null = null;
  let sourceJsonlPath: string | null = null;
  if (mode === 'fork') {
    const projectDir = findClaudeProjectDir(homedir(), cwd, claudeSessionId);
    sourceJsonlPath = join(projectDir, `${claudeSessionId}.jsonl`);
    resumeId = randomUUID();
    forkJsonlPath = join(projectDir, `${resumeId}.jsonl`);
    isFork = true;
  }

  const shortId = claudeSessionId.slice(0, 8);
  const name = options.name || (mode === 'fork' ? `Fork: ${shortId}` : `Resume: ${shortId}`);

  logger.info({ id, claudeSessionId, cwd, mode }, 'Opening historical Claude session');

  // Insert DB record FIRST so forkJsonlPath is tracked before any file operations (matches
  // forkSession: cleanupOrphanedForkFiles() can recover if the server crashes mid-open).
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
    claudeSessionId: resumeId,
    isFork,
    forkJsonlPath,
  };
  insertSession(metadata);

  if (mode === 'fork') {
    try {
      copyFileSync(sourceJsonlPath as string, forkJsonlPath as string);
    } catch (error) {
      updateSession(id, { status: 'terminated', lastAccessedAt: now.toISOString() });
      throw new Error(`Failed to copy session transcript: ${error instanceof Error ? error.message : error}`);
    }
  }

  let ptyProcess;
  try {
    ptyProcess = createPty({ shell, cwd, cols, rows, env: { CLAUDE_REMOTE_SESSION_ID: id } });
  } catch (error) {
    if (forkJsonlPath) { try { unlinkSync(forkJsonlPath); } catch { /* best-effort cleanup */ } }
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

  registry.initSessionPty(session);
  registry.activeSessions.set(id, session);
  logSessionEvent(id, mode === 'fork' ? 'forked' : 'resumed', JSON.stringify({ claudeSessionId, resumeId }));

  injectResumeCommand(session, resumeId);

  logger.info({ id, name, pid: ptyProcess.pid }, 'Historical session opened successfully');
  return session;
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
export function reviveSession(
  registry: SessionRegistry,
  killPty: (ptyProcess: ActiveSession['pty']) => void,
  options: { id: string; cols?: number; rows?: number }
): ActiveSession {
  const { id } = options;

  const metadata = getSessionMetadata(id);
  if (!metadata) throw new Error('Session not found');
  if (registry.activeSessions.has(id)) throw new Error('Session is already running');
  if (metadata.status === 'terminated') throw new Error('Session has been terminated');
  // Fork transcripts are unlinked at boot by cleanupOrphanedForkFiles(), so a revived fork
  // would resume a conversation whose JSONL no longer exists.
  if (metadata.isFork) throw new Error('Forked sessions cannot be revived; their transcript is removed on restart');

  const cols = options.cols || metadata.cols || 80;
  const rows = options.rows || metadata.rows || 24;
  const now = new Date();

  logger.info({ id, cwd: metadata.cwd, claudeSessionId: metadata.claudeSessionId }, 'Reviving stale session');

  let ptyProcess;
  try {
    ptyProcess = createPty({
      shell: metadata.shell,
      cwd: metadata.cwd,
      cols,
      rows,
      env: { CLAUDE_REMOTE_SESSION_ID: id },
    });
  } catch (error) {
    // Nearly always a cwd that no longer exists. Say which directory failed rather than
    // silently falling back to home, which would resume the conversation somewhere else.
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to start shell in ${metadata.cwd}: ${reason}`);
  }

  const session: ActiveSession = {
    id,
    name: metadata.name,
    shell: metadata.shell,
    cwd: metadata.cwd,
    createdAt: new Date(metadata.createdAt),
    lastAccessedAt: now,
    ownerId: metadata.ownerId ?? undefined,
    status: 'active',
    cols,
    rows,
    pty: ptyProcess,
    tmuxSession: metadata.tmuxSession ?? undefined,
    scrollback: [],
    connectedClients: new Set(),
  };

  registry.initSessionPty(session);

  // initSessionPty installs a fresh, empty buffer, and getScrollback() prefers the
  // in-memory one -- without this seed the scrollback persisted at shutdown would be
  // silently dropped on the first attach. Empty after a hard kill, since persistScrollback
  // only runs on a graceful shutdown.
  const persisted = restoreScrollbackRaw(id);
  if (persisted) {
    // The trailing newline matters: ScrollbackBuffer holds an unterminated final line as
    // `partialLine`, which getAll() drops once the buffer has any complete lines.
    registry.scrollbackBuffers.get(id)?.push(persisted.endsWith('\n') ? persisted : `${persisted}\n`);
  }

  registry.activeSessions.set(id, session);
  try {
    updateSession(id, { status: 'active', lastAccessedAt: now.toISOString() });
    logSessionEvent(id, 'revived', JSON.stringify({ claudeSessionId: metadata.claudeSessionId }));
  } catch (error) {
    // Mirrors createSession's DB-failure path. The caller is about to be told the revive
    // failed, so nothing may be left running behind its back. Drop the registrations before
    // killing the PTY so the resulting exit event finds no session and no-ops.
    logger.error({ id, error }, 'Failed to record revived session, cleaning up PTY');
    registry.activeSessions.delete(id);
    registry.dataListeners.delete(id);
    registry.exitListeners.delete(id);
    registry.scrollbackBuffers.delete(id);
    killPty(ptyProcess);
    throw error;
  }

  // No claudeSessionId means this row never reported a conversation (a plain shell, or the
  // SessionStart hook never fired). Respawning the shell in the right cwd is the whole job.
  if (metadata.claudeSessionId) {
    injectResumeCommand(session, metadata.claudeSessionId);
  }

  logger.info({ id, name: metadata.name, pid: ptyProcess.pid }, 'Session revived successfully');
  return session;
}
