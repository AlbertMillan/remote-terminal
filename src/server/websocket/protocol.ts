// WebSocket message protocol definitions
import type { JobsSummary } from '../jobs/summary.js';

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
