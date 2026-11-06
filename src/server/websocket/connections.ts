import type { WebSocket } from 'ws';
import WebSocketModule from 'ws';
export const WS_OPEN = WebSocketModule.OPEN;
import {
  createMessage,
  type SessionInfo,
  type CategoryInfo,
  type LandNotificationPayload,
  type PromptMissingNotificationPayload,
  type SessionClaudeNamesPayload,
  type SessionAccountWarningsPayload,
  type SessionLoginEndedPayload,
  type AccountChangedNotificationPayload,
} from './protocol.js';
import { sessionManager } from '../sessions/manager.js';
import { claudeNameFor } from '../sessions/claude-registry.js';
import { defaultAccount } from '../accounts.js';
import { accountWarningFor } from '../sessions/account-watch.js';
import { reviveRefusal } from '../sessions/revivable.js';
import { createLogger } from '../utils/logger.js';
import { notificationService } from '../notifications/service.js';
import type { TailscaleIdentity } from '../auth/tailscale.js';

export const logger = createLogger('websocket');

export interface ClientConnection {
  id: string;
  ws: WebSocket;
  identity: TailscaleIdentity | null;
  attachedSession: string | null;
  dataUnsubscribe: (() => void) | null;
  exitUnsubscribe: (() => void) | null;
  /** The Android app's install id (`/ws?device=`), for push; absent for a browser. */
  deviceId?: string;
  /** Set by the app's `app.state`; a device in the foreground gets no push. */
  foreground?: boolean;
  /** When the socket last carried anything from the client: a message or a ping frame. */
  lastSeenMs?: number;
}

/**
 * A foreground socket silent for longer than this is presumed dead. The app's OkHttp pings
 * every 20 s, and the server never pings, so a phone that dropped off the tailnet while on
 * screen would otherwise look "foreground" until TCP gives up, and every push is skipped.
 */
export const FOREGROUND_STALE_MS = 45_000;

/** Whether that app install is open on screen right now (docs/android-app.md). */
export function isDeviceForeground(deviceId: string, nowMs: number = Date.now()): boolean {
  for (const conn of connections.values()) {
    if (
      conn.deviceId === deviceId &&
      conn.foreground &&
      conn.ws.readyState === WS_OPEN &&
      nowMs - (conn.lastSeenMs ?? 0) < FOREGROUND_STALE_MS
    ) {
      return true;
    }
  }
  return false;
}

export const connections = new Map<string, ClientConnection>();

export function attachToSession(connection: ClientConnection, sessionId: string): void {
  connection.attachedSession = sessionId;
  sessionManager.addClient(sessionId, connection.id);

  // Clear any pending notification for this session when user attaches
  notificationService.clearSessionNotification(sessionId);

  // Subscribe to terminal data
  connection.dataUnsubscribe = sessionManager.onData(sessionId, (data) => {
    if (connection.ws.readyState === WS_OPEN) {
      // OPEN
      connection.ws.send(createMessage('terminal.data', { sessionId, data }));
    }
  });

  // Subscribe to exit events
  connection.exitUnsubscribe = sessionManager.onExit(sessionId, (exitCode) => {
    if (connection.ws.readyState === WS_OPEN) {
      connection.ws.send(createMessage('terminal.exit', { sessionId, exitCode }));
    }
  });

  logger.debug({ clientId: connection.id, sessionId }, 'Client attached to session');
}

export function detachFromSession(connection: ClientConnection): void {
  if (!connection.attachedSession) return;

  const sessionId = connection.attachedSession;

  // Unsubscribe from events
  connection.dataUnsubscribe?.();
  connection.exitUnsubscribe?.();
  connection.dataUnsubscribe = null;
  connection.exitUnsubscribe = null;

  // Remove from session's client list
  sessionManager.removeClient(sessionId, connection.id);

  connection.attachedSession = null;

  logger.debug({ clientId: connection.id, sessionId }, 'Client detached from session');
}

export function broadcastSessionUpdate(sessionId: string, event: 'terminated' | 'deleted'): void {
  const messageType = event === 'terminated' ? 'session.terminated' : 'session.deleted';

  for (const conn of connections.values()) {
    if (conn.ws.readyState === WS_OPEN) {
      conn.ws.send(createMessage(messageType, { sessionId }));
    }
  }
}

/**
 * A session's row changed under every sidebar (its shell exited on its own): send each open
 * browser the row as the list would, so its status and play button are current. Not
 * `session.terminated`, which also closes the terminal of whoever is watching it.
 */
export function broadcastSessionRow(sessionId: string): void {
  const row = sessionManager.getSessionList().find((s) => s.id === sessionId);
  if (!row) return;
  const message = createMessage('session.updated', { session: sessionToInfo(row) });
  for (const conn of connections.values()) {
    if (conn.ws.readyState === WS_OPEN) conn.ws.send(message);
  }
}

/**
 * The fields a reply about one session (session.created, session.attached) takes from its
 * DB row rather than from the live session object, which lacks them. Every such reply goes
 * through this, so none of them drops one: a revived or resumed read-only peer that came
 * back without `access` lost its chip until the next list.
 */
export function storedSessionFields(row: {
  categoryId?: string | null;
  sortOrder?: number;
  isFork?: boolean;
  claudeSessionId?: string | null;
  spawnedBy?: string | null;
  permissionMode?: string | null;
  access?: string | null;
} | null): {
  categoryId: string | null;
  sortOrder: number;
  isFork: boolean;
  claudeSessionId: string | null;
  spawnedBy: string | null;
  permissionMode: string | null;
  access: string | null;
} {
  return {
    categoryId: row?.categoryId ?? null,
    sortOrder: row?.sortOrder ?? 0,
    isFork: row?.isFork ?? false,
    claudeSessionId: row?.claudeSessionId ?? null,
    spawnedBy: row?.spawnedBy ?? null,
    permissionMode: row?.permissionMode ?? null,
    access: row?.access ?? null,
  };
}

export function sessionToInfo(session: { id: string; name: string; shell: string; cwd: string; createdAt: Date | string; lastAccessedAt: Date | string; status: string; cols: number; rows: number; attachable?: boolean; categoryId?: string | null; sortOrder?: number; isFork?: boolean; claudeSessionId?: string | null; spawnedBy?: string | null; permissionMode?: string | null; access?: string | null; account?: string }): SessionInfo {
  return {
    id: session.id,
    name: session.name,
    shell: session.shell,
    cwd: session.cwd,
    createdAt: session.createdAt instanceof Date ? session.createdAt.toISOString() : session.createdAt,
    lastAccessedAt: session.lastAccessedAt instanceof Date ? session.lastAccessedAt.toISOString() : session.lastAccessedAt,
    status: session.status,
    cols: session.cols,
    rows: session.rows,
    attachable: session.attachable ?? true,
    categoryId: session.categoryId ?? null,
    sortOrder: session.sortOrder ?? 0,
    isFork: session.isFork ?? false,
    claudeSessionId: session.claudeSessionId ?? null,
    spawnedBy: session.spawnedBy ?? null,
    permissionMode: session.permissionMode ?? null,
    access: session.access ?? null,
    claudeName: claudeNameFor(session.claudeSessionId),
    account: session.account ?? defaultAccount(),
    accountWarning: accountWarningFor(session.id),
    // A live session (attachable and not exited) is refused before any transcript lookup,
    // so only exited and stale rows cost a filesystem check.
    revivable: reviveRefusal(session, (session.attachable ?? true) && session.status !== 'terminated') === null,
  };
}

export function broadcastClaudeNames(names: Record<string, string>): void {
  const payload: SessionClaudeNamesPayload = { names };
  for (const conn of connections.values()) {
    if (conn.ws.readyState === WS_OPEN) {
      conn.ws.send(createMessage('session.claudeNames', payload));
    }
  }
}

/**
 * A session the server started on its own (the agent-sessions API), so no
 * browser asked for it and none is told by `session.created`. Every open
 * browser lists it; none attaches.
 */
/**
 * Delete the sessions of a worktree Land or Delete track just removed, and
 * drop them from every sidebar: a terminated row there points at a folder
 * that no longer exists, so it can neither attach nor revive.
 */
export async function removeWorktreeSessions(worktreePath: string): Promise<void> {
  for (const id of await sessionManager.deleteSessionsIn(worktreePath)) {
    broadcastSessionUpdate(id, 'deleted');
  }
}

export function broadcastSessionAdded(session: SessionInfo): void {
  for (const conn of connections.values()) {
    if (conn.ws.readyState === WS_OPEN) {
      conn.ws.send(createMessage('session.added', { session }));
    }
  }
}

/**
 * A session-requested Land's outcome, to every open client. Not filtered by
 * notification preferences: those choose which session events alert, and
 * this is the only place the result of that Land is ever reported.
 */
export function broadcastLandResult(payload: LandNotificationPayload): void {
  for (const conn of connections.values()) {
    if (conn.ws.readyState === WS_OPEN) {
      conn.ws.send(createMessage('notification', payload));
    }
  }
}

export function broadcastAccountWarnings(warnings: Record<string, string>): void {
  const payload: SessionAccountWarningsPayload = { warnings };
  for (const conn of connections.values()) {
    if (conn.ws.readyState === WS_OPEN) {
      conn.ws.send(createMessage('session.accountWarnings', payload));
    }
  }
}

/** A Log in session exited: to every connection, so its retry survives a session switch. */
export function broadcastLoginEnded(payload: SessionLoginEndedPayload): void {
  for (const conn of connections.values()) {
    if (conn.ws.readyState === WS_OPEN) {
      conn.ws.send(createMessage('session.loginEnded', payload));
    }
  }
}

/** A running session's account changed login. Unfiltered, like a Land result: it is a warning about whose login runs it. */
export function broadcastAccountChanged(payload: AccountChangedNotificationPayload): void {
  for (const conn of connections.values()) {
    if (conn.ws.readyState === WS_OPEN) {
      conn.ws.send(createMessage('notification', payload));
    }
  }
}

/** A started session's prompt never arrived. Unfiltered, like a Land result: nothing else says so. */
export function broadcastPromptMissing(payload: PromptMissingNotificationPayload): void {
  for (const conn of connections.values()) {
    if (conn.ws.readyState === WS_OPEN) {
      conn.ws.send(createMessage('notification', payload));
    }
  }
}

/**
 * A project's board changed outside any client's own request (a session's
 * Update from main), so open boards fetch it again instead of showing the
 * track as still behind.
 */
export function broadcastProjectsChanged(projectCwd: string): void {
  for (const conn of connections.values()) {
    if (conn.ws.readyState === WS_OPEN) {
      conn.ws.send(createMessage('projects.changed', { projectCwd }));
    }
  }
}

export function broadcastSessionKept(sessionId: string, excludeClientId?: string): void {
  for (const conn of connections.values()) {
    if (conn.id !== excludeClientId && conn.ws.readyState === WS_OPEN) {
      conn.ws.send(createMessage('session.kept', { sessionId }));
    }
  }
}

export function categoryToInfo(category: { id: string; name: string; sortOrder: number; collapsed: boolean }): CategoryInfo {
  return {
    id: category.id,
    name: category.name,
    sortOrder: category.sortOrder,
    collapsed: category.collapsed,
  };
}

export function broadcastCategoryUpdate(event: 'created' | 'renamed' | 'deleted' | 'reordered' | 'toggled', payload: unknown, excludeClientId?: string): void {
  const messageType = `category.${event}` as const;

  for (const conn of connections.values()) {
    if (conn.id !== excludeClientId && conn.ws.readyState === WS_OPEN) {
      conn.ws.send(createMessage(messageType, payload));
    }
  }
}

export function broadcastSessionMoved(sessionId: string, categoryId: string | null, sortOrder: number, excludeClientId?: string): void {
  for (const conn of connections.values()) {
    if (conn.id !== excludeClientId && conn.ws.readyState === WS_OPEN) {
      conn.ws.send(createMessage('session.moved', { sessionId, categoryId, sortOrder }));
    }
  }
}

export function broadcastSessionReordered(sessions: { id: string; sortOrder: number }[], excludeClientId?: string): void {
  for (const conn of connections.values()) {
    if (conn.id !== excludeClientId && conn.ws.readyState === WS_OPEN) {
      conn.ws.send(createMessage('session.reordered', { sessions }));
    }
  }
}

export function getActiveConnections(): number {
  return connections.size;
}

export function closeAllConnections(): void {
  for (const conn of connections.values()) {
    conn.ws.close(1000, 'Server shutting down');
  }
  connections.clear();
}
