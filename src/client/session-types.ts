// Shared payload/info types for session-manager.ts: session and category state,
// the project-log board, and the server's WebSocket message envelope.
import type { JobsSummary } from './job-overlay.js';

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
  /** Set once the session reports a Claude conversation (SessionStart/Stop hooks).
   *  Decides whether reviving resumes that conversation or only respawns the shell. */
  claudeSessionId: string | null;
  /** The session that started this one (agent-sessions API). The sidebar nests it under
   *  that session while it is in the list, and shows it top-level otherwise. */
  spawnedBy?: string | null;
  /** The `--permission-mode` a started session runs with; a chip when not `default`. */
  permissionMode?: string | null;
  /** Claude's name for the conversation running here (what `ListAgents` shows and agents
   *  message), or null when none runs. The status line shows it when it differs from
   *  `name`. Kept current by `session.claudeNames`. */
  claudeName?: string | null;
  /** The Claude login it runs under (server `accounts.ts`). */
  account?: string;
  /** Why its account no longer holds the expected login, or null. Kept current by `session.accountWarnings`. */
  accountWarning?: string | null;
}

/** Who a preflight found logged in, and what it refused (server `accounts.ts` PreflightRefusal). */
export interface AccountIdentity {
  accountUuid?: string;
  organizationUuid?: string;
  emailAddress?: string;
  organizationName?: string;
}

export interface AccountRefusal {
  ok: false;
  account: string;
  configDir: string;
  reason: 'no-expected-identity' | 'unreadable' | 'no-login' | 'mismatch' | 'org-settings';
  found: AccountIdentity | null;
  expected: { accountUuid?: string; organizationUuid?: string };
  remoteSettings?: string[];
  message: string;
}

export interface SessionAccountWarningsPayload {
  warnings: Record<string, string>;
}

/** A Log in session exited (sent to every connection): retry the launch it was opened for. */
export interface SessionLoginEndedPayload {
  sessionId: string;
  exitCode: number;
}

export interface AccountChangedNotificationPayload {
  kind: 'account-changed';
  sessionId: string;
  name: string;
  detail: string;
  timestamp: string;
}

/** Every session with a running Claude, by session id → Claude's name. */
export interface SessionClaudeNamesPayload {
  names: Record<string, string>;
}

export interface CategoryInfo {
  id: string;
  name: string;
  sortOrder: number;
  collapsed: boolean;
}

// Project-log board (mirrors server's ProjectBoardItem / ParsedLogEntry / LogEntryMeta)
export interface LogEntryMeta {
  date: string;
  session: string;
  branch: string;
  claudeSessionId: string;
  /** The Claude login the session ran under; absent on older entries. */
  account?: string;
  blockers: number;
  openItems: number;
}
export interface ParsedLogEntry {
  meta: LogEntryMeta | null;
  body: string;
}
export interface PhaseItem {
  id: string;
  title: string;
  status: 'done' | 'in_progress' | 'pending';
  sessionIds: string[];
}
export interface PhaseGroup {
  group: string;
  source: string;
  items: PhaseItem[];
}
export interface ProjectBoardItem {
  cwd: string;
  name: string;
  hasLog: boolean;
  lastActivity: string | null;
  transcriptCount: number;
  entries: ParsedLogEntry[];
  latest: LogEntryMeta | null;
  phaseGroups: PhaseGroup[];
}

// Type-safe server message definitions (issue #14)
export interface AuthSuccessPayload {
  userId: string;
  loginName: string;
  displayName: string;
}

export interface AuthFailurePayload {
  message: string;
}

export interface SessionListPayload {
  sessions: SessionInfo[];
}

export interface SessionCreatedPayload {
  session: SessionInfo;
}

export interface SessionAttachedPayload {
  session: SessionInfo;
  scrollback: string;
}

export interface SessionTerminatedPayload {
  sessionId: string;
}

export interface SessionDeletedPayload {
  sessionId: string;
}

export interface SessionRenamedPayload {
  sessionId: string;
  name: string;
}

export interface SessionMovedPayload {
  sessionId: string;
  categoryId: string | null;
  sortOrder: number;
}

export interface SessionReorderedPayload {
  sessions: { id: string; sortOrder: number }[];
}

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

export interface TerminalDataPayload {
  sessionId: string;
  data: string;
}

export interface TerminalExitPayload {
  sessionId: string;
  exitCode: number;
}

export interface ErrorPayload {
  message: string;
  /** A launch refused by the account preflight: offer Log in / Clean up (account-refusal-modal.ts). */
  refusal?: AccountRefusal;
}

export interface NotificationPreferencesPayload {
  browserEnabled: boolean;
  visualEnabled: boolean;
  notifyOnInput: boolean;
  notifyOnCompleted: boolean;
}

export interface NotificationPayload {
  sessionId: string;
  type: 'needs-input' | 'completed';
  timestamp: string;
}

/** A session-requested Land's outcome (server: LandNotificationPayload). */
export interface LandNotificationPayload {
  kind: 'land';
  projectCwd: string;
  track: string;
  ok: boolean;
  detail: string;
  timestamp: string;
}

/** A started session's prompt never reached its agent (server: PromptMissingNotificationPayload). */
export interface PromptMissingNotificationPayload {
  kind: 'prompt-missing';
  sessionId: string;
  name: string;
  detail: string;
  timestamp: string;
}

export type ServerMessage =
  | { type: 'auth.success'; id?: string; payload: AuthSuccessPayload }
  | { type: 'auth.failure'; id?: string; payload: AuthFailurePayload }
  | { type: 'session.list'; id?: string; payload: SessionListPayload }
  | { type: 'session.created'; id?: string; payload: SessionCreatedPayload }
  | { type: 'session.added'; id?: string; payload: SessionCreatedPayload }
  | { type: 'session.attached'; id?: string; payload: SessionAttachedPayload }
  | { type: 'session.terminated'; id?: string; payload: SessionTerminatedPayload }
  | { type: 'session.deleted'; id?: string; payload: SessionDeletedPayload }
  | { type: 'session.renamed'; id?: string; payload: SessionRenamedPayload }
  | { type: 'session.claudeNames'; id?: string; payload: SessionClaudeNamesPayload }
  | { type: 'session.accountWarnings'; id?: string; payload: SessionAccountWarningsPayload }
  | { type: 'session.loginEnded'; id?: string; payload: SessionLoginEndedPayload }
  | { type: 'session.moved'; id?: string; payload: SessionMovedPayload }
  | { type: 'session.reordered'; id?: string; payload: SessionReorderedPayload }
  | { type: 'session.forked'; id?: string; payload: SessionCreatedPayload }
  | { type: 'session.kept'; id?: string; payload: { sessionId: string } }
  | { type: 'session.error'; id?: string; payload: ErrorPayload }
  | { type: 'terminal.data'; id?: string; payload: TerminalDataPayload }
  | { type: 'terminal.exit'; id?: string; payload: TerminalExitPayload }
  | { type: 'category.created'; id?: string; payload: CategoryCreatedPayload }
  | { type: 'category.renamed'; id?: string; payload: CategoryRenamedPayload }
  | { type: 'category.deleted'; id?: string; payload: CategoryDeletedPayload }
  | { type: 'category.reordered'; id?: string; payload: CategoryReorderedPayload }
  | { type: 'category.toggled'; id?: string; payload: CategoryToggledPayload }
  | { type: 'category.list'; id?: string; payload: CategoryListPayload }
  | { type: 'notification.preferences'; id?: string; payload: NotificationPreferencesPayload }
  | { type: 'notification.preferences.updated'; id?: string; payload: NotificationPreferencesPayload }
  | { type: 'notification'; id?: string; payload: NotificationPayload | LandNotificationPayload | PromptMissingNotificationPayload | AccountChangedNotificationPayload }
  | { type: 'jobs.summary'; id?: string; payload: JobsSummary }
  | { type: 'projects.changed'; id?: string; payload: { projectCwd: string } }
  | { type: 'error'; id?: string; payload: ErrorPayload }
  | { type: 'pong'; id?: string; payload?: undefined };

export type ConnectionStatus = 'disconnected' | 'connecting' | 'connected';
