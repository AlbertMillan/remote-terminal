/**
 * The /ws wire format the server sends and the web client reads: one definition for both.
 *
 * Types only, and no imports: the client type-checks without Node's types, so anything
 * imported from here must not pull a server module into its program. The server checks
 * every send against `ServerPayloads` (`createMessage()` in websocket/protocol.ts), and the
 * client reads `ServerMessage`, so a payload that changes on one side and not the other
 * is a compile error rather than a silent `undefined` on screen.
 *
 * The message-type list itself (`SERVER_MESSAGE_TYPES`) stays in websocket/protocol.ts,
 * where the Android fixture test reads it; a type-level check there keeps it and
 * `ServerPayloads` naming the same messages. A field or message added here still goes into
 * tests/fixtures/protocol/messages.json and the Android app's Protocol.kt (docs/android-app.md).
 */

// --- Sessions and categories ----------------------------------------------

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
  /** The Claude conversation this session last reported, if any: reviving resumes it when
   *  set, and only respawns the shell when not. */
  claudeSessionId: string | null;
  /** The session that started this one through the agent-sessions API; the sidebar nests it
   *  under that session while it is in the list. */
  spawnedBy: string | null;
  /** The `--permission-mode` a started session's `claude` runs with; a chip when not `default`. */
  permissionMode: string | null;
  /** `read` for a read-only peer beside its track's builder (project/builder-critic-pairs.md);
   *  null is write. The sidebar chips it and orders it after its builder. */
  access?: string | null;
  /** What Claude calls the conversation running here (`ListAgents`' name), or null when none
   *  runs. Kept current by `session.claudeNames`. */
  claudeName: string | null;
  /** The Claude login it runs under (server accounts.ts). */
  account: string;
  /** Why its account no longer holds the expected login (account-watch.ts), or null. Kept
   *  current by `session.accountWarnings`. */
  accountWarning: string | null;
  /** The sidebar's play button: `reviveRefusal()` (sessions/revivable.ts) found nothing against
   *  reviving it. The server decides, so the client never re-derives which rows come back. */
  revivable: boolean;
  /** Why the header's account chip can't move it (`moveBlockedReason()`), or null. */
  accountMoveBlocked: string | null;
}

export interface CategoryInfo {
  id: string;
  name: string;
  sortOrder: number;
  collapsed: boolean;
}

// --- Accounts ---------------------------------------------------------------

/** Who a preflight found logged in. */
export interface AccountIdentity {
  accountUuid?: string;
  organizationUuid?: string;
  emailAddress?: string;
  organizationName?: string;
}

/** A launch the account preflight refused (server accounts.ts `PreflightRefusal`): offer Log in / Clean up. */
export interface AccountRefusal {
  ok: false;
  account: string;
  configDir: string;
  reason: 'no-expected-identity' | 'unreadable' | 'no-login' | 'mismatch' | 'org-settings';
  /** Who is logged in there, or null for nobody. */
  found: AccountIdentity | null;
  expected: { accountUuid?: string; organizationUuid?: string };
  /** For `org-settings`: the files an org login left behind (Clean up deletes them). */
  remoteSettings?: string[];
  message: string;
}

// --- Code factory (project/code-factory.md; server factory/board.ts builds these) ---------

/** The board's columns, left to right. `done` is today's (server-local midnight on). */
export type FactoryColumn = 'intake' | 'ready' | 'running' | 'review' | 'merging' | 'done';

/** A unit's state, from its items: parked if any waits for the user, then running, then done. */
export type FactoryUnitStatus = 'open' | 'in_progress' | 'parked' | 'done';

export type FactoryMergeStatus = 'queued' | 'holding' | 'running' | 'merged' | 'parked';

/** One feature of a track unit, in plan order. */
export interface FactoryFeatureProgress {
  id: string;
  title: string;
  state: 'done' | 'now' | 'todo';
}

/**
 * One unit of factory work: a loose item, or a whole track worked by one agent. A card in
 * the Factory overlay and on the board.
 */
export interface FactoryUnitSummary {
  /** Stable per project and unit, for the DOM; never parsed. */
  key: string;
  projectCwd: string;
  projectName: string;
  /** The feature id of a loose item, `track:<name>` for a track. */
  unitId: string;
  isTrack: boolean;
  trackName: string;
  title: string;
  /** Its items' feature ids, in plan order. Actions address the first. */
  featureIds: string[];
  column: FactoryColumn;
  status: FactoryUnitStatus;
  /** The step running, or parked at; null before the first run. */
  step: string | null;
  needsYou: boolean;
  /** In the review column: the reviewer agent is at it, or it waits for you. */
  reviewer: 'agent' | 'you' | null;
  /** Parked by the reviewer's escalation rules (review-step.ts). */
  escalated: boolean;
  /** Filed by an agent (`discovered-from`) and waiting for accept / backlog / dismiss. */
  triage: boolean;
  /** One line on why it stops or waits: its park reason, merge detail or blocker. */
  reason: string | null;
  /** A track's features; empty for a loose item. */
  features: FactoryFeatureProgress[];
  /** Feature ids whose open `blocks` edge holds it back. */
  waitsFor: string[];
  mergeId: string | null;
  mergeStatus: FactoryMergeStatus | null;
  /** Ledger tokens its runs spent (input, output and cache writes, as the runaway guard counts). */
  tokens: number;
  modelTier: string | null;
  /** Why it looks stuck (no heartbeat; ready and unclaimed while a seat is free), or null. */
  stalled: string | null;
  heartbeatAt: string | null;
  updatedAt: string;
  /** A terminal session holds it (Take over, or a session started on its track); null otherwise. */
  claim: FactoryUnitClaim | null;
}

/**
 * A terminal session's hold on a unit. No heartbeat: liveness is the open terminal, so a
 * closed one leaves the unit paused and still claimed by you until Return to factory.
 */
export interface FactoryUnitClaim {
  sessionId: string;
  /** Null once the session's row is gone (deleted); the claim stays until returned. */
  sessionName: string | null;
  /** Its terminal is open. False: paused, claimed by you. */
  live: boolean;
}

/** One merge-queue entry, a session's Land included. */
export interface FactoryMergeSummary {
  id: string;
  projectCwd: string;
  projectName: string;
  kind: 'item' | 'track' | 'session-land';
  title: string;
  branch: string;
  featureIds: string[];
  status: FactoryMergeStatus;
  /** The resolver's progress, why it holds, or why it parked. */
  detail: string | null;
  /** For a parked conflict: the files it could not settle. */
  conflictPaths: string[];
  mergeSha: string | null;
  updatedAt: string;
}

export interface FactoryCounts {
  /** Intake, ready and running units that do not wait for you. */
  running: number;
  /** In review with the reviewer agent. */
  reviewing: number;
  needsYou: number;
  merging: number;
  done: number;
}

export interface FactoryDispatchState {
  /** The dispatcher runs in this server. */
  started: boolean;
  /** Why nothing new starts at all, or null. */
  paused: string | null;
  /** Projects held back by plan usage, by cwd → why. */
  capped: Record<string, string>;
  seats: number;
  running: number;
}

/**
 * The factory feed behind the overlay (`factory.summary`), pushed on every factory write
 * and once per client after auth. Built from the store, never by parsing PROJECT.md per
 * event (titles come from a cache).
 */
export interface FactorySummary {
  units: FactoryUnitSummary[];
  /** Unfinished and parked entries, plus those merged today. */
  merges: FactoryMergeSummary[];
  counts: FactoryCounts;
  dispatch: FactoryDispatchState;
  /** Ledger tokens of factory runs (and merge resolvers) since `since`. */
  tokensToday: number;
  /** Start of "today" on the server, ISO. */
  since: string;
}

/** A shaping question (JSON from the shaping pass): options and the default it would take. */
export interface FactoryQuestion {
  id: string;
  question: string;
  options: string[];
  default: string | null;
}

/** What the board's drawer shows beyond the card (GET /api/factory/board only). */
export interface FactoryUnitDetail {
  /** The whole park reason. */
  parkReason: string | null;
  /** The reviewer's last verdict, as formatted for the fix step. */
  verdict: string | null;
  questions: FactoryQuestion[];
  /** A summary page exists (GET /api/factory/summary). */
  hasSummary: boolean;
  worktreePath: string | null;
  branch: string | null;
  baseBranch: string | null;
  lastCommit: string | null;
}

export interface FactoryBoardUnit extends FactoryUnitSummary {
  detail: FactoryUnitDetail;
}

/** GET /api/factory/board: the summary with every card's drawer detail. */
export interface FactoryBoard extends Omit<FactorySummary, 'units'> {
  units: FactoryBoardUnit[];
}

/** GET /api/factory/report?since=: what happened while you were away. */
export interface FactoryReport {
  since: string;
  /** Merge entries merged since then, newest first. */
  landed: FactoryMergeSummary[];
  /** Units that look stuck now. */
  stalls: FactoryUnitSummary[];
  /** Tokens per unit (and merge resolver) since then, most first. */
  tokens: { projectName: string; title: string; tokens: number }[];
  totalTokens: number;
}

// --- Payloads -----------------------------------------------------------------

export interface AuthSuccessPayload {
  userId: string;
  loginName: string;
  displayName: string;
}

export interface MessagePayload {
  message: string;
}

export interface SessionIdPayload {
  sessionId: string;
}

export interface SessionPayload {
  session: SessionInfo;
}

/** `session.created`; a revive answers with the same id, and with its replayed screen. */
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

/** The requester's answer to session.stop: every id stopped, children first. */
export interface SessionStoppedPayload {
  sessionIds: string[];
}

/** The requester's answer to session.changeAccount (project/move-conversation-account.md); `resume`: revive it. */
export interface SessionAccountChangedPayload {
  sessionId: string;
  account: string;
  resume: boolean;
}

/** Every session with a running Claude, by session id → Claude's name; the full set each time. */
export interface SessionClaudeNamesPayload {
  names: Record<string, string>;
}

/** Every running session whose account is on the wrong login, by id → why. */
export interface SessionAccountWarningsPayload {
  warnings: Record<string, string>;
}

/**
 * A Log in session's process exited: the client that opened it retries the launch it was
 * opened for. Sent to every connection, not just attached ones (unlike `terminal.exit`).
 */
export interface SessionLoginEndedPayload {
  sessionId: string;
  exitCode: number;
}

/** `error` and `session.error`. */
export interface ErrorPayload {
  message: string;
  /**
   * 'viewers': session.stop or session.changeAccount refused because another browser is
   * viewing (resend with force). 'stopped': session.changeAccount failed after stopping the
   * session, which still has its old account (revive it).
   */
  code?: string;
  /** A launch refused by the account preflight. */
  refusal?: AccountRefusal;
}

export interface TerminalDataPayload {
  sessionId: string;
  data: string;
}

export interface TerminalExitPayload {
  sessionId: string;
  exitCode: number;
}

/**
 * Another viewer resized the session's PTY. Output from now on is drawn at this size, so a
 * viewer of another size must re-attach (replaying the server's screen) before it takes the
 * size back, or its scrollback keeps text drawn for the other width.
 */
/**
 * RIS (full reset, scrollback included). A `terminal.data` starting with it is the server's
 * catch-up for a socket that fell behind (`terminal-output.ts`): the session's screen as a
 * snapshot drawn at the PTY's size, which a viewer of another size replays at that size.
 */
export const CATCH_UP_RESET = '\x1bc';

export interface TerminalResizedPayload {
  sessionId: string;
  cols: number;
  rows: number;
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

/**
 * The outcome of a Land a session asked for (POST /api/agent/land), sent once it has run.
 * Same `notification` message, told apart by `kind`: the session that asked is closed by
 * then, so it can't key a session notification.
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
 * A started session's prompt never reached its agent (agent/prompt-delivery.ts). A toast,
 * never a badge: an idle session badged would read as "needs input".
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

export type AnyNotificationPayload =
  | NotificationPayload
  | LandNotificationPayload
  | PromptMissingNotificationPayload
  | AccountChangedNotificationPayload;

// --- Messages -------------------------------------------------------------------

/** Every server → client message type and the payload it carries. */
export interface ServerPayloads {
  'auth.success': AuthSuccessPayload;
  'auth.failure': MessagePayload;
  'session.created': SessionCreatedPayload;
  /** A session the server started on its own (a main session's agent did): listed, never attached. */
  'session.added': SessionPayload;
  /** A row changed server-side (its shell exited): refreshed in place. */
  'session.updated': SessionPayload;
  'session.attached': SessionAttachedPayload;
  'session.detached': Record<string, never>;
  'session.terminated': SessionIdPayload;
  'session.deleted': SessionIdPayload;
  'session.renamed': SessionRenamedPayload;
  'session.moved': SessionMovedPayload;
  'session.reordered': SessionReorderedPayload;
  'session.list': SessionListPayload;
  'session.forked': SessionPayload;
  'session.kept': SessionIdPayload;
  'session.stopped': SessionStoppedPayload;
  'session.accountChanged': SessionAccountChangedPayload;
  'session.claudeNames': SessionClaudeNamesPayload;
  'session.accountWarnings': SessionAccountWarningsPayload;
  'session.loginEnded': SessionLoginEndedPayload;
  'session.error': ErrorPayload;
  'terminal.data': TerminalDataPayload;
  'terminal.exit': TerminalExitPayload;
  'terminal.resized': TerminalResizedPayload;
  'category.created': CategoryCreatedPayload;
  'category.renamed': CategoryRenamedPayload;
  'category.deleted': CategoryDeletedPayload;
  'category.reordered': CategoryReorderedPayload;
  'category.toggled': CategoryToggledPayload;
  'category.list': CategoryListPayload;
  'notification.preferences': NotificationPreferencesPayload;
  'notification.preferences.updated': NotificationPreferencesPayload;
  'notification': AnyNotificationPayload;
  'factory.summary': FactorySummary;
  'projects.changed': { projectCwd: string };
  'error': ErrorPayload;
  'pong': undefined;
}

/** A message as the client receives it: its `type` decides its `payload`. */
export type ServerMessage = {
  [K in keyof ServerPayloads]: { type: K; id?: string; payload: ServerPayloads[K] };
}[keyof ServerPayloads];
