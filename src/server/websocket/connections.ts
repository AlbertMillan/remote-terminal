import type { WebSocket } from 'ws';
import WebSocketModule from 'ws';
export const WS_OPEN = WebSocketModule.OPEN;
import { createMessage, type SessionInfo, type CategoryInfo } from './protocol.js';
import { sessionManager } from '../sessions/manager.js';
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

export function sessionToInfo(session: { id: string; name: string; shell: string; cwd: string; createdAt: Date | string; lastAccessedAt: Date | string; status: string; cols: number; rows: number; attachable?: boolean; categoryId?: string | null; sortOrder?: number; isFork?: boolean; claudeSessionId?: string | null }): SessionInfo {
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
  };
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
