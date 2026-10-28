// WebSocket message protocol definitions
import type { JobsSummary } from '../jobs/summary.js';
import type { PreflightRefusal } from '../accounts.js';

export type ClientMessageType =
  | 'auth'
  | 'session.create'
  | 'session.attach'
  | 'session.detach'
  | 'session.terminate'
  | 'session.delete'
  | 'session.rename'
  | 'session.move'
  | 'session.reorder'
  | 'session.list'
  | 'session.fork'
  | 'session.open'
  | 'session.revive'
  | 'session.keep'
  | 'terminal.data'
  | 'terminal.resize'
  | 'category.create'
  | 'category.rename'
  | 'category.delete'
  | 'category.reorder'
  | 'category.toggle'
  | 'category.list'
  | 'notification.preferences.get'
  | 'notification.preferences.set'
  | 'notification.dismiss'
  | 'ping';

export type ServerMessageType =
  | 'auth.success'
  | 'auth.failure'
  | 'session.created'
  | 'session.added'
  | 'session.attached'
  | 'session.detached'
  | 'session.terminated'
  | 'session.deleted'
  | 'session.renamed'
  | 'session.moved'
  | 'session.reordered'
  | 'session.list'
  | 'session.forked'
  | 'session.kept'
  | 'session.claudeNames'
  | 'session.accountWarnings'
  | 'session.loginEnded'
  | 'session.error'
  | 'terminal.data'
  | 'terminal.exit'
  | 'category.created'
  | 'category.renamed'
  | 'category.deleted'
  | 'category.reordered'
  | 'category.toggled'
  | 'category.list'
  | 'notification.preferences'
  | 'notification.preferences.updated'
  | 'notification'
  | 'jobs.summary'
  | 'projects.changed'
  | 'error'
  | 'pong';

export interface ClientMessage {
  type: ClientMessageType;
  id?: string; // Message ID for request/response correlation
  payload?: unknown;
}

export interface ServerMessage {
  type: ServerMessageType;
  id?: string; // Correlation ID from client message
  payload?: unknown;
}

// Client message payloads
export interface AuthPayload {
  token?: string; // Future: optional auth token
}

export interface SessionCreatePayload {
  name?: string;
  shell?: string;
  cwd?: string;
  cols?: number;
  rows?: number;
  /** The Claude login to run under (accounts.ts); unset is the project's or configured default. */
  account?: string;
  /**
   * A Log in session for `account`: `claude` in its folder and clean env, with no preflight,
   * where the user runs `/login` (docs/accounts.md). Name and cwd are the server's.
   */
  login?: boolean;
  /** With `login`: first delete the org-pushed `remote-settings*.json` in that folder. */
  cleanup?: boolean;
}

export interface SessionAttachPayload {
  sessionId: string;
}

export interface SessionDetachPayload {
  sessionId: string;
}

export interface SessionTerminatePayload {
  sessionId: string;
}

export interface SessionDeletePayload {
  sessionId: string;
}

export interface SessionRenamePayload {
  sessionId: string;
  name: string;
}

export interface SessionMovePayload {
  sessionId: string;
  categoryId: string | null;
}

export interface SessionReorderPayload {
  sessions: { id: string; sortOrder: number }[];
}

export interface TerminalDataPayload {
  sessionId: string;
  data: string;
}

export interface TerminalResizePayload {
  sessionId: string;
  cols: number;
  rows: number;
}

// Category payloads
export interface CategoryCreatePayload {
  name: string;
}

export interface CategoryRenamePayload {
  categoryId: string;
  name: string;
}

export interface CategoryDeletePayload {
  categoryId: string;
}

export interface CategoryReorderPayload {
  categories: { id: string; sortOrder: number }[];
}

export interface CategoryTogglePayload {
  categoryId: string;
  collapsed: boolean;
}

// Server message payloads
export interface SessionInfo {
  id: string;
  name: string;
  shell: string;
  cwd: string;
  createdAt: string;
  lastAccessedAt: string;
  status: string;
  cols: number;
  rows: number;
  attachable: boolean;
  categoryId: string | null;
  sortOrder: number;
  isFork: boolean;
  /** The Claude conversation this session last reported, if any. Drives the sidebar's
   *  revive tooltip: with an id we resume the conversation, without one we only respawn
   *  the shell. */
  claudeSessionId: string | null;
  /** The session that started this one through the agent-sessions API; the sidebar
   *  nests it under that session while it is in the list. */
  spawnedBy: string | null;
  /** The `--permission-mode` a started session's `claude` runs with. */
  permissionMode: string | null;
  /** What Claude calls the conversation running here (`ListAgents`' name), or null when
   *  none is running. Kept current by `session.claudeNames`. */
  claudeName: string | null;
  /** The Claude login it runs under (accounts.ts). */
  account: string;
  /** Why its account no longer holds the expected login (account-watch.ts), or null. */
  accountWarning: string | null;
}

/** Every session with a running Claude, by session id → Claude's name; sent on change. */
export interface SessionClaudeNamesPayload {
  names: Record<string, string>;
}

export interface SessionForkPayload {
  sessionId: string;
}

// Open a historical Claude session (from a project's session history) directly.
// `resume` continues the original transcript; `fork` copies it to a new id first.
export interface SessionOpenPayload {
  claudeSessionId: string;
  cwd: string;
  mode: 'resume' | 'fork';
  /** The account its SESSION-LOG entry names, for a transcript no session row ran. */
  account?: string;
  cols?: number;
  rows?: number;
}

// Bring a stale session (a DB row whose PTY died with the server) back to life in place:
// same id, same cwd, and `claude --resume` when the row carries a claudeSessionId.
export interface SessionRevivePayload {
  sessionId: string;
  cols?: number;
  rows?: number;
}

export interface SessionKeepPayload {
  sessionId: string;
}

export interface SessionKeptPayload {
  sessionId: string;
}

export interface CategoryInfo {
  id: string;
  name: string;
  sortOrder: number;
  collapsed: boolean;
}

export interface SessionCreatedPayload {
  session: SessionInfo;
  scrollback?: string;
}

export interface SessionAttachedPayload {
  session: SessionInfo;
  scrollback: string;
}

export interface SessionListPayload {
  sessions: SessionInfo[];
}

export interface TerminalDataServerPayload {
  sessionId: string;
  data: string;
}

export interface TerminalExitPayload {
  sessionId: string;
  exitCode: number;
}

export interface ErrorPayload {
  message: string;
  code?: string;
}

// Category server payloads
export interface CategoryCreatedPayload {
  category: CategoryInfo;
}

export interface CategoryRenamedPayload {
  categoryId: string;
  name: string;
}

export interface CategoryDeletedPayload {
  categoryId: string;
}

export interface CategoryReorderedPayload {
  categories: { id: string; sortOrder: number }[];
}

export interface CategoryToggledPayload {
  categoryId: string;
  collapsed: boolean;
}

export interface CategoryListPayload {
  categories: CategoryInfo[];
}

export interface SessionMovedPayload {
  sessionId: string;
  categoryId: string | null;
  sortOrder: number;
}

export interface SessionReorderedPayload {
  sessions: { id: string; sortOrder: number }[];
}

// Notification payloads

export interface NotificationPreferencesPayload {
  browserEnabled: boolean;
  visualEnabled: boolean;
  notifyOnInput: boolean;
  notifyOnCompleted: boolean;
}

export interface NotificationPreferencesSetPayload {
  browserEnabled?: boolean;
  visualEnabled?: boolean;
  notifyOnInput?: boolean;
  notifyOnCompleted?: boolean;
}

export interface NotificationDismissPayload {
  sessionId: string;
}

/**
 * The live job feed behind the overlay. Pushed on every job or stage write and
 * once per client just after auth, so a fresh page is populated before anything
 * moves. Mirrors JobSummary in src/server/jobs/summary.ts.
 */
export type JobsSummaryPayload = JobsSummary;

export interface NotificationPayload {
  sessionId: string;
  type: 'needs-input' | 'completed';
  timestamp: string;
}

/**
 * The outcome of a Land a session asked for (POST /api/agent/land), sent once
 * it has run. Same `notification` message, told apart by `kind`: the session
 * that asked is closed by then, so it can't key a session notification.
 */
export interface LandNotificationPayload {
  kind: 'land';
  projectCwd: string;
  track: string;
  ok: boolean;
  /** Land's detail (with the build and restart hint), or why it failed. */
  detail: string;
  timestamp: string;
}

/**
 * A started session's prompt never reached its agent (agent/prompt-delivery.ts).
 * Sent once, a grace period after the start; the same `notification` message,
 * told apart by `kind`, because a session badge would read as "needs input".
 */
export interface PromptMissingNotificationPayload {
  kind: 'prompt-missing';
  sessionId: string;
  name: string;
  detail: string;
  timestamp: string;
}

/** A running session's account changed login under it (account-watch.ts). */
export interface AccountChangedNotificationPayload {
  kind: 'account-changed';
  sessionId: string;
  name: string;
  detail: string;
  timestamp: string;
}

/** Every running session whose account is on the wrong login, by id → why. */
export interface SessionAccountWarningsPayload {
  warnings: Record<string, string>;
}

/**
 * A Log in session's process exited: the client that opened it retries the launch
 * it was opened for. Sent to every connection, not just attached ones (unlike
 * `terminal.exit`), so switching sessions during the login doesn't lose the retry.
 */
export interface SessionLoginEndedPayload {
  sessionId: string;
  exitCode: number;
}

/** `session.error`; `refusal` when a launch was refused by preflight (accounts.ts). */
export interface SessionErrorPayload {
  message: string;
  refusal?: PreflightRefusal;
}

// Helper functions
export function createMessage(type: ServerMessageType, payload?: unknown, id?: string): string {
  const message: ServerMessage = { type };
  if (payload !== undefined) message.payload = payload;
  if (id !== undefined) message.id = id;
  return JSON.stringify(message);
}

export function parseMessage(data: string): ClientMessage | null {
  try {
    const message = JSON.parse(data);
    if (typeof message.type !== 'string') {
      return null;
    }
    return message as ClientMessage;
  } catch {
    return null;
  }
}
