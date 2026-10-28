import { randomUUID } from 'crypto';
import { copyFileSync, unlinkSync } from 'fs';
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
  launchProfileForTranscript,
  accountForTranscript,
} from '../db/queries.js';
import { assertAccountReady, claudeJsonPath, findTranscript, projectsDir, resolveStartAccount, settingsPath } from '../accounts.js';
import { launchFlags, type LaunchProfile } from './launch-profile.js';
import { isSafeQuotedText } from '../utils/shell-quote.js';
import { restoreScrollbackRaw } from './persistence.js';
import { revokeSessionToken, sessionEnv } from './session-env.js';

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

// C4: Type `line` once the shell produces its first output (= ready for input). Debounced
// 100ms so rc-file output settles; 5s hard fallback if the shell stays silent. Shared by
// fork, history-open, revive (`claude --resume <id>`) and agent-started sessions.
export function injectCommand(session: ActiveSession, line: string): void {
  let commandSent = false;
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  const startupDisposable = session.pty.onData(() => {
    if (commandSent) return;
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      if (!commandSent) {
        commandSent = true;
        startupDisposable.dispose();
        writeToPty(session.pty, `${line}\r`);
      }
    }, 100);
  });
  setTimeout(() => {
    if (!commandSent) {
      commandSent = true;
      writeToPty(session.pty, `${line}\r`);
    }
  }, 5000);
}

/**
 * ` --name "<name>"`, so the session shows in Claude's `ListAgents` under its claude-remote
 * name instead of one derived from its folder (docs/session-orchestration.md). A name no
 * shell quotes safely gets no flag: Claude falls back to its own name, which is harmless,
 * where a broken quote would run the rest of the line as shell.
 */
export function claudeNameFlag(name: string | null | undefined): string {
  const trimmed = name?.trim();
  if (!trimmed || !isSafeQuotedText(trimmed)) return '';
  return ` --name "${trimmed}"`;
}

/**
 * `profile` is a started session's (launch-profile.ts): its permission mode and the MCP
 * servers it may load. Without it a revived or resumed started session comes back in the
 * default mode with the user's whole MCP roster, re-read on every turn.
 */
function injectResumeCommand(session: ActiveSession, resumeId: string, profile?: LaunchProfile): void {
  // A dropped server is logged in launchFlags and stays on the row: it loads again once the
  // config has it back.
  const flags = profile ? launchFlags(session.id, session.cwd, profile, claudeJsonPath(session.account)).flags : '';
  injectCommand(session, `claude ${flags}--resume ${resumeId}${claudeNameFlag(session.name)}`);
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
  assertAccountReady(sourceMetadata.account);

  const { claudeSessionId } = sourceMetadata;
  if (!claudeSessionId) {
    throw new Error(
      'No Claude session ID registered for this session. ' +
      `Ensure the claude-session hook is configured in ${settingsPath(sourceMetadata.account)} ` +
      'and Claude has stopped at least once in this terminal.'
    );
  }

  // C1: Robust project dir lookup — computed slug first, fallback scans all project dirs
  // The source's own account: the copy must sit where its `claude --resume` will look.
  const projectDir = findClaudeProjectDir(projectsDir(sourceMetadata.account), sourceMetadata.cwd, claudeSessionId);
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
    account: sourceMetadata.account,
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
    ptyProcess = createPty({ shell, cwd, cols, rows, account: metadata.account, env: sessionEnv(id) });
  } catch (error) {
    revokeSessionToken(id);
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
    account: metadata.account,
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
    account?: string;
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
  // A transcript can only be resumed from the folder it lives in: the account of the row
  // that ran it, else the account whose folder holds it, else the start's.
  const account =
    accountForTranscript(claudeSessionId) ??
    findTranscript(cwd, claudeSessionId)?.account ??
    resolveStartAccount(options.account, cwd);
  assertAccountReady(account);

  let resumeId = claudeSessionId;
  let isFork = false;
  let forkJsonlPath: string | null = null;
  let sourceJsonlPath: string | null = null;
  if (mode === 'fork') {
    const projectDir = findClaudeProjectDir(projectsDir(account), cwd, claudeSessionId);
    sourceJsonlPath = join(projectDir, `${claudeSessionId}.jsonl`);
    resumeId = randomUUID();
    forkJsonlPath = join(projectDir, `${resumeId}.jsonl`);
    isFork = true;
  }

  // A started session's transcript resumes with its profile, on a row of the user's own: no
  // spawned_by, so it neither counts against the parent's limit nor can be landed by it.
  const profile = mode === 'resume' ? launchProfileForTranscript(claudeSessionId) : null;

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
    permissionMode: profile?.permissionMode ?? null,
    mcpServers: profile?.mcpServers ?? null,
    account,
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
    ptyProcess = createPty({ shell, cwd, cols, rows, account: metadata.account, env: sessionEnv(id) });
  } catch (error) {
    revokeSessionToken(id);
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
    account: metadata.account,
    pty: ptyProcess,
    scrollback: [],
    connectedClients: new Set(),
  };

  registry.initSessionPty(session);
  registry.activeSessions.set(id, session);
  logSessionEvent(id, mode === 'fork' ? 'forked' : 'resumed', JSON.stringify({ claudeSessionId, resumeId }));

  injectResumeCommand(session, resumeId, profile ?? undefined);

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

  // Its own account, whatever the start of a new session would pick: the conversation
  // only resumes from the folder it lives in.
  assertAccountReady(metadata.account);

  const cols = options.cols || metadata.cols || 80;
  const rows = options.rows || metadata.rows || 24;
  const now = new Date();

  logger.info({ id, cwd: metadata.cwd, claudeSessionId: metadata.claudeSessionId, account: metadata.account }, 'Reviving stale session');

  let ptyProcess;
  try {
    ptyProcess = createPty({
      shell: metadata.shell,
      cwd: metadata.cwd,
      cols,
      rows,
      account: metadata.account,
      env: sessionEnv(id),
    });
  } catch (error) {
    revokeSessionToken(id);
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
    account: metadata.account,
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
    injectResumeCommand(session, metadata.claudeSessionId, {
      permissionMode: metadata.permissionMode ?? null,
      mcpServers: metadata.mcpServers ?? null,
    });
  }

  logger.info({ id, name: metadata.name, pid: ptyProcess.pid }, 'Session revived successfully');
  return session;
}
