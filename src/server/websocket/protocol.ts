// WebSocket message protocol definitions
import type { ServerPayloads } from '../../shared/protocol.js';

/**
 * Every message type, as values: the Android app mirrors them in Kotlin, and
 * tests/protocol-fixture.test.ts fails when tests/fixtures/protocol/messages.json (read by
 * both test suites) is missing one. A new type goes here, in that fixture and in
 * android/app/src/main/java/com/clauderemote/app/protocol/Protocol.kt. docs/android-app.md
 */
export const CLIENT_MESSAGE_TYPES = [
  'auth',
  'session.create',
  'session.attach',
  'session.detach',
  'session.terminate',
  'session.delete',
  'session.rename',
  'session.move',
  'session.reorder',
  'session.list',
  'session.fork',
  'session.open',
  'session.revive',
  'session.stop',
  'session.changeAccount',
  'session.keep',
  'terminal.data',
  'terminal.resize',
  'category.create',
  'category.rename',
  'category.delete',
  'category.reorder',
  'category.toggle',
  'category.list',
  'notification.preferences.get',
  'notification.preferences.set',
  'notification.dismiss',
  'app.state',
  'ping',
] as const;

export type ClientMessageType = (typeof CLIENT_MESSAGE_TYPES)[number];

// Server -> client payloads are defined with the client in shared/protocol.ts.
export type {
  AccountChangedNotificationPayload,
  AnyNotificationPayload,
  CategoryInfo,
  ErrorPayload,
  LandNotificationPayload,
  NotificationPayload,
  NotificationPreferencesPayload,
  PromptMissingNotificationPayload,
  ServerPayloads,
  SessionInfo,
} from '../../shared/protocol.js';

export const SERVER_MESSAGE_TYPES = [
  'auth.success',
  'auth.failure',
  'session.created',
  'session.added',
  'session.updated',
  'session.attached',
  'session.detached',
  'session.terminated',
  'session.deleted',
  'session.renamed',
  'session.moved',
  'session.reordered',
  'session.list',
  'session.forked',
  'session.kept',
  'session.stopped',
  'session.accountChanged',
  'session.claudeNames',
  'session.accountWarnings',
  'session.loginEnded',
  'session.error',
  'terminal.data',
  'terminal.exit',
  'category.created',
  'category.renamed',
  'category.deleted',
  'category.reordered',
  'category.toggled',
  'category.list',
  'notification.preferences',
  'notification.preferences.updated',
  'notification',
  'jobs.summary',
  'projects.changed',
  'error',
  'pong',
] as const;

export type ServerMessageType = (typeof SERVER_MESSAGE_TYPES)[number];

// A message in SERVER_MESSAGE_TYPES without a payload in ServerPayloads (or the reverse)
// fails to compile here: the list feeds the Android fixture, the map types every send.
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
const serverTypesMatch: Same<ServerMessageType, keyof ServerPayloads> = true;
void serverTypesMatch;

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
  /**
   * Create `cwd` first (only inside the user folder; sessions/folder-picker.ts), with
   * `git init` and a starter PROJECT.md as asked. An existing folder is opened as it is.
   */
  createCwd?: { git: boolean; projectDoc: boolean };
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

/** Stop a running session so it can be resumed later (project/stop-sessions.md). */
export interface SessionStopPayload {
  sessionId: string;
  /** Stop even though another browser is viewing one of the sessions. */
  force?: boolean;
}

/**
 * Move a session's conversation to another account (project/move-conversation-account.md).
 * A running session is stopped for it; refused with `code: 'viewers'` while another browser
 * views it, unless `force`.
 */
export interface SessionChangeAccountPayload {
  sessionId: string;
  account: string;
  force?: boolean;
}

export interface SessionKeepPayload {
  sessionId: string;
}

// Notification payloads

export interface NotificationPreferencesSetPayload {
  browserEnabled?: boolean;
  visualEnabled?: boolean;
  notifyOnInput?: boolean;
  notifyOnCompleted?: boolean;
}

/**
 * The Android app says whether it is on screen. A device in the foreground gets no push
 * (it shows the event itself); the socket names the device with `/ws?device=<id>`.
 */
export interface AppStatePayload {
  foreground: boolean;
}

export interface NotificationDismissPayload {
  sessionId: string;
}


// Helper functions
/** The one way a server message is built: `payload` is checked against what the client reads. */
export function createMessage<K extends ServerMessageType>(type: K, payload: ServerPayloads[K], id?: string): string {
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
