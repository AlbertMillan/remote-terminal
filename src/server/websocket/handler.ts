import type { WebSocket } from 'ws';
import WebSocketModule from 'ws';
const WS_OPEN = WebSocketModule.OPEN;
import type { FastifyRequest } from 'fastify';
import { randomUUID } from 'crypto';
import { sessionManager } from '../sessions/manager.js';
import { createLogger } from '../utils/logger.js';
import { RateLimiter } from '../utils/rate-limiter.js';
import {
  parseMessage,
  createMessage,
  type ClientMessage,
  type SessionCreatePayload,
  type SessionAttachPayload,
  type SessionTerminatePayload,
  type SessionDeletePayload,
  type SessionRenamePayload,
  type SessionMovePayload,
  type TerminalDataPayload,
  type TerminalResizePayload,
  type SessionInfo,
  type CategoryCreatePayload,
  type CategoryRenamePayload,
  type CategoryDeletePayload,
  type CategoryReorderPayload,
  type CategoryTogglePayload,
  type CategoryInfo,
  type NotificationPreferencesSetPayload,
  type NotificationDismissPayload,
  type NotificationPayload,
} from './protocol.js';
import {
  insertCategory,
  updateCategory,
  deleteCategory as deleteCategoryFromDb,
  getAllCategories,
  updateSessionCategory,
  reorderCategories,
  getCategory,
  getSession as getSessionFromDb,
  getNotificationPreferences,
  setNotificationPreferences,
  type NotificationPreferences,
} from '../db/queries.js';
import {
  verifyTailscaleConnection,
  extractIpFromRequest,
  type TailscaleIdentity,
} from '../auth/tailscale.js';
import { notificationService, type Notification } from '../notifications/service.js';

const logger = createLogger('websocket');

// Rate limiter: 100 messages per second with token bucket
const rateLimiter = new RateLimiter(100, 10);

// Validation constants
const MAX_SESSION_NAME_LENGTH = 100;
const MAX_CWD_LENGTH = 500;
const VALID_SHELL_PATTERN = /^[a-zA-Z0-9/_.-]+$/;
const MIN_TERMINAL_DIMENSION = 1;
const MAX_TERMINAL_DIMENSION = 500;

interface ClientConnection {
  id: string;
  ws: WebSocket;
  identity: TailscaleIdentity | null;
  attachedSession: string | null;
  dataUnsubscribe: (() => void) | null;
  exitUnsubscribe: (() => void) | null;
}

const connections = new Map<string, ClientConnection>();

// Register notification service callback
notificationService.onNotification((notification: Notification) => {
  handleNotification(notification);
});

function handleNotification(notification: Notification): void {
  logger.info({ sessionId: notification.sessionId, type: notification.type }, 'Processing notification');

  // Send notification to all connected clients
  for (const conn of connections.values()) {
    if (conn.ws.readyState !== WS_OPEN) continue;

    // Check user preferences
    const userId = conn.identity?.userId;
    if (!userId) continue;

    // Check if this notification type is enabled for user
    if (!notificationService.isNotificationEnabled(userId, notification.type)) continue;

    // Send notification
    const payload: NotificationPayload = {
      sessionId: notification.sessionId,
      type: notification.type,
      timestamp: notification.timestamp.toISOString(),
    };

    conn.ws.send(createMessage('notification', payload));
  }
}

export async function handleConnection(ws: WebSocket, request: FastifyRequest): Promise<void> {
  const clientId = randomUUID();
  const ipAddress = extractIpFromRequest(request.raw);

  logger.info({ clientId, ipAddress }, 'New WebSocket connection');

  // Verify Tailscale identity
  const identity = await verifyTailscaleConnection(ipAddress);

  if (!identity) {
    logger.warn({ clientId, ipAddress }, 'Connection rejected: unauthorized');
    ws.send(createMessage('auth.failure', { message: 'Unauthorized' }));
    ws.close(4001, 'Unauthorized');
    return;
  }

  const connection: ClientConnection = {
    id: clientId,
    ws,
    identity,
    attachedSession: null,
    dataUnsubscribe: null,
    exitUnsubscribe: null,
  };

  connections.set(clientId, connection);

  // Send auth success
  ws.send(
    createMessage('auth.success', {
      userId: identity.userId,
      loginName: identity.loginName,
      displayName: identity.displayName,
    })
  );

  // Set up message handler with rate limiting
  ws.on('message', (data: Buffer | string) => {
    if (!rateLimiter.tryAcquire(clientId)) {
      ws.send(createMessage('error', { message: 'Rate limit exceeded' }));
      logger.warn({ clientId }, 'Client rate limited');
      return;
    }
    handleMessage(connection, data.toString());
  });

  // Set up close handler
  ws.on('close', () => {
    handleDisconnect(connection);
  });

  // Set up error handler
  ws.on('error', (error) => {
    logger.error({ clientId, error }, 'WebSocket error');
    handleDisconnect(connection);
  });
}

function handleMessage(connection: ClientConnection, data: string): void {
  const message = parseMessage(data);

  if (!message) {
    connection.ws.send(createMessage('error', { message: 'Invalid message format' }));
    return;
  }

  logger.debug({ clientId: connection.id, type: message.type }, 'Received message');

  switch (message.type) {
    case 'ping':
      connection.ws.send(createMessage('pong', undefined, message.id));
      break;

    case 'session.list':
      handleSessionList(connection, message);
      break;

    case 'session.create':
      handleSessionCreate(connection, message);
      break;

    case 'session.attach':
      handleSessionAttach(connection, message);
      break;

    case 'session.detach':
      handleSessionDetach(connection, message);
      break;

    case 'session.terminate':
      handleSessionTerminate(connection, message);
      break;

    case 'session.delete':
      handleSessionDelete(connection, message);
      break;

    case 'session.rename':
      handleSessionRename(connection, message);
      break;

    case 'session.move':
      handleSessionMove(connection, message);
      break;

    case 'category.create':
      handleCategoryCreate(connection, message);
      break;

    case 'category.rename':
      handleCategoryRename(connection, message);
      break;

    case 'category.delete':
      handleCategoryDelete(connection, message);
      break;

    case 'category.reorder':
      handleCategoryReorder(connection, message);
      break;

    case 'category.toggle':
      handleCategoryToggle(connection, message);
      break;

    case 'category.list':
      handleCategoryList(connection, message);
      break;

    case 'notification.preferences.get':
      handleNotificationPreferencesGet(connection, message);
      break;

    case 'notification.preferences.set':
      handleNotificationPreferencesSet(connection, message);
      break;

    case 'notification.dismiss':
      handleNotificationDismiss(connection, message);
      break;

    case 'terminal.data':
      handleTerminalData(connection, message);
      break;

    case 'terminal.resize':
      handleTerminalResize(connection, message);
      break;

    default:
      connection.ws.send(
        createMessage('error', { message: `Unknown message type: ${message.type}` }, message.id)
      );
  }
}

function handleSessionList(connection: ClientConnection, message: ClientMessage): void {
  const sessions = sessionManager.getSessionList().map(sessionToInfo);
  connection.ws.send(createMessage('session.list', { sessions }, message.id));
}

function validateSessionOptions(payload: SessionCreatePayload | undefined): {
  name?: string;
  shell?: string;
  cwd?: string;
  cols?: number;
  rows?: number;
} {
  const validated: {
    name?: string;
    shell?: string;
    cwd?: string;
    cols?: number;
    rows?: number;
  } = {};

  // Validate and sanitize name
  if (payload?.name) {
    if (typeof payload.name !== 'string') {
      throw new Error('Session name must be a string');
    }
    validated.name = payload.name.slice(0, MAX_SESSION_NAME_LENGTH).trim();
  }

  // Validate shell path
  if (payload?.shell) {
    if (typeof payload.shell !== 'string') {
      throw new Error('Shell must be a string');
    }
    if (!VALID_SHELL_PATTERN.test(payload.shell)) {
      throw new Error('Invalid shell path');
    }
    validated.shell = payload.shell;
  }

  // Validate working directory
  if (payload?.cwd) {
    if (typeof payload.cwd !== 'string') {
      throw new Error('Working directory must be a string');
    }
    if (payload.cwd.length > MAX_CWD_LENGTH) {
      throw new Error('Working directory path too long');
    }
    // Basic path traversal check
    if (payload.cwd.includes('..')) {
      throw new Error('Invalid working directory path');
    }
    validated.cwd = payload.cwd;
  }

  // Validate terminal dimensions
  if (payload?.cols !== undefined) {
    const cols = Number(payload.cols);
    if (isNaN(cols) || cols < MIN_TERMINAL_DIMENSION || cols > MAX_TERMINAL_DIMENSION) {
      throw new Error('Invalid terminal columns');
    }
    validated.cols = cols;
  }

  if (payload?.rows !== undefined) {
    const rows = Number(payload.rows);
    if (isNaN(rows) || rows < MIN_TERMINAL_DIMENSION || rows > MAX_TERMINAL_DIMENSION) {
      throw new Error('Invalid terminal rows');
    }
    validated.rows = rows;
  }

  return validated;
}

async function handleSessionCreate(connection: ClientConnection, message: ClientMessage): Promise<void> {
  const payload = message.payload as SessionCreatePayload | undefined;

  try {
    // Validate input before creating session
    const validatedOptions = validateSessionOptions(payload);

    const session = await sessionManager.createSession({
      ...validatedOptions,
      ownerId: connection.identity?.userId,
    });

    connection.ws.send(
      createMessage(
        'session.created',
        {
          session: sessionToInfo(session),
        },
        message.id
      )
    );

    // Detach from current session before auto-attaching to new one
    // Without this, the old session's data listener leaks (never unsubscribed),
    // causing duplicate terminal output when switching back to it
    if (connection.attachedSession) {
      detachFromSession(connection);
    }

    // Auto-attach to the new session
    attachToSession(connection, session.id);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Failed to create session';
    connection.ws.send(createMessage('session.error', { message: errorMessage }, message.id));
  }
}

function handleSessionAttach(connection: ClientConnection, message: ClientMessage): void {
  const payload = message.payload as SessionAttachPayload;

  if (!payload?.sessionId) {
    connection.ws.send(createMessage('session.error', { message: 'Session ID required' }, message.id));
    return;
  }

  const session = sessionManager.getSession(payload.sessionId);
  if (!session) {
    connection.ws.send(createMessage('session.error', { message: 'Session not found' }, message.id));
    return;
  }

  // Get session metadata from database to include categoryId
  const sessionMetadata = getSessionFromDb(payload.sessionId);

  // Detach from current session if any
  if (connection.attachedSession) {
    detachFromSession(connection);
  }

  attachToSession(connection, payload.sessionId);

  // Send scrollback history
  const scrollback = sessionManager.getScrollback(payload.sessionId);

  connection.ws.send(
    createMessage(
      'session.attached',
      {
        session: sessionToInfo({ ...session, categoryId: sessionMetadata?.categoryId ?? null }),
        scrollback: scrollback.join('\n'),
      },
      message.id
    )
  );
}

function handleSessionDetach(connection: ClientConnection, message: ClientMessage): void {
  if (connection.attachedSession) {
    detachFromSession(connection);
    connection.ws.send(createMessage('session.detached', {}, message.id));
  } else {
    connection.ws.send(createMessage('session.error', { message: 'Not attached to any session' }, message.id));
  }
}

async function handleSessionTerminate(connection: ClientConnection, message: ClientMessage): Promise<void> {
  const payload = message.payload as SessionTerminatePayload;

  if (!payload?.sessionId) {
    connection.ws.send(createMessage('session.error', { message: 'Session ID required' }, message.id));
    return;
  }

  // Detach if attached to this session
  if (connection.attachedSession === payload.sessionId) {
    detachFromSession(connection);
  }

  const success = await sessionManager.terminateSession(payload.sessionId);

  if (success) {
    connection.ws.send(createMessage('session.terminated', { sessionId: payload.sessionId }, message.id));
    // Notify all connected clients
    broadcastSessionUpdate(payload.sessionId, 'terminated');
  } else {
    connection.ws.send(createMessage('session.error', { message: 'Failed to terminate session' }, message.id));
  }
}

async function handleSessionDelete(connection: ClientConnection, message: ClientMessage): Promise<void> {
  const payload = message.payload as SessionDeletePayload;

  if (!payload?.sessionId) {
    connection.ws.send(createMessage('session.error', { message: 'Session ID required' }, message.id));
    return;
  }

  const success = await sessionManager.deleteSession(payload.sessionId);

  if (success) {
    connection.ws.send(createMessage('session.deleted', { sessionId: payload.sessionId }, message.id));
    broadcastSessionUpdate(payload.sessionId, 'deleted');
  } else {
    connection.ws.send(createMessage('session.error', { message: 'Failed to delete session' }, message.id));
  }
}

function handleSessionRename(connection: ClientConnection, message: ClientMessage): void {
  const payload = message.payload as SessionRenamePayload;

  if (!payload?.sessionId || !payload?.name) {
    connection.ws.send(createMessage('session.error', { message: 'Session ID and name required' }, message.id));
    return;
  }

  const success = sessionManager.renameSession(payload.sessionId, payload.name);

  if (success) {
    connection.ws.send(
      createMessage('session.renamed', { sessionId: payload.sessionId, name: payload.name }, message.id)
    );
  } else {
    connection.ws.send(createMessage('session.error', { message: 'Failed to rename session' }, message.id));
  }
}

function handleTerminalData(connection: ClientConnection, message: ClientMessage): void {
  const payload = message.payload as TerminalDataPayload;

  if (!payload?.sessionId || payload?.data === undefined) {
    return;
  }

  // Ensure client is attached to this session
  if (connection.attachedSession !== payload.sessionId) {
    connection.ws.send(createMessage('error', { message: 'Not attached to this session' }));
    return;
  }

  sessionManager.writeToSession(payload.sessionId, payload.data);
}

function handleTerminalResize(connection: ClientConnection, message: ClientMessage): void {
  const payload = message.payload as TerminalResizePayload;

  if (!payload?.sessionId || !payload?.cols || !payload?.rows) {
    return;
  }

  // Validate terminal dimensions
  const cols = Number(payload.cols);
  const rows = Number(payload.rows);
  if (
    isNaN(cols) || isNaN(rows) ||
    cols < MIN_TERMINAL_DIMENSION || cols > MAX_TERMINAL_DIMENSION ||
    rows < MIN_TERMINAL_DIMENSION || rows > MAX_TERMINAL_DIMENSION
  ) {
    return;
  }

  if (connection.attachedSession !== payload.sessionId) {
    return;
  }

  sessionManager.resizeSession(payload.sessionId, cols, rows);
}

function attachToSession(connection: ClientConnection, sessionId: string): void {
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

function detachFromSession(connection: ClientConnection): void {
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

function handleDisconnect(connection: ClientConnection): void {
  logger.info({ clientId: connection.id }, 'WebSocket disconnected');

  // Detach from session
  if (connection.attachedSession) {
    detachFromSession(connection);
  }

  // Clean up rate limiter
  rateLimiter.removeClient(connection.id);

  // Remove from connections map
  connections.delete(connection.id);
}

function broadcastSessionUpdate(sessionId: string, event: 'terminated' | 'deleted'): void {
  const messageType = event === 'terminated' ? 'session.terminated' : 'session.deleted';

  for (const conn of connections.values()) {
    if (conn.ws.readyState === WS_OPEN) {
      conn.ws.send(createMessage(messageType, { sessionId }));
    }
  }
}

function sessionToInfo(session: { id: string; name: string; shell: string; cwd: string; createdAt: Date | string; lastAccessedAt: Date | string; status: string; cols: number; rows: number; attachable?: boolean; categoryId?: string | null }): SessionInfo {
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
    attachable: session.attachable ?? true, // Default to true for active sessions
    categoryId: session.categoryId ?? null,
  };
}

// Category handlers

function handleCategoryList(connection: ClientConnection, message: ClientMessage): void {
  const categories = getAllCategories(connection.identity?.userId).map(categoryToInfo);
  connection.ws.send(createMessage('category.list', { categories }, message.id));
}

function handleCategoryCreate(connection: ClientConnection, message: ClientMessage): void {
  const payload = message.payload as CategoryCreatePayload;

  if (!payload?.name || typeof payload.name !== 'string') {
    connection.ws.send(createMessage('error', { message: 'Category name required' }, message.id));
    return;
  }

  const name = payload.name.trim().slice(0, 100);
  if (!name) {
    connection.ws.send(createMessage('error', { message: 'Category name cannot be empty' }, message.id));
    return;
  }

  const existingCategories = getAllCategories(connection.identity?.userId);
  const maxSortOrder = existingCategories.reduce((max, cat) => Math.max(max, cat.sortOrder), -1);

  const category = {
    id: randomUUID(),
    name,
    sortOrder: maxSortOrder + 1,
    collapsed: false,
    ownerId: connection.identity?.userId || null,
    createdAt: new Date().toISOString(),
  };

  insertCategory(category);

  connection.ws.send(createMessage('category.created', { category: categoryToInfo(category) }, message.id));
  broadcastCategoryUpdate('created', { category: categoryToInfo(category) }, connection.id);
}

function handleCategoryRename(connection: ClientConnection, message: ClientMessage): void {
  const payload = message.payload as CategoryRenamePayload;

  if (!payload?.categoryId || !payload?.name || typeof payload.name !== 'string') {
    connection.ws.send(createMessage('error', { message: 'Category ID and name required' }, message.id));
    return;
  }

  const name = payload.name.trim().slice(0, 100);
  if (!name) {
    connection.ws.send(createMessage('error', { message: 'Category name cannot be empty' }, message.id));
    return;
  }

  const existing = getCategory(payload.categoryId);
  if (!existing) {
    connection.ws.send(createMessage('error', { message: 'Category not found' }, message.id));
    return;
  }

  updateCategory(payload.categoryId, { name });

  connection.ws.send(createMessage('category.renamed', { categoryId: payload.categoryId, name }, message.id));
  broadcastCategoryUpdate('renamed', { categoryId: payload.categoryId, name }, connection.id);
}

function handleCategoryDelete(connection: ClientConnection, message: ClientMessage): void {
  const payload = message.payload as CategoryDeletePayload;

  if (!payload?.categoryId) {
    connection.ws.send(createMessage('error', { message: 'Category ID required' }, message.id));
    return;
  }

  const existing = getCategory(payload.categoryId);
  if (!existing) {
    connection.ws.send(createMessage('error', { message: 'Category not found' }, message.id));
    return;
  }

  deleteCategoryFromDb(payload.categoryId);

  connection.ws.send(createMessage('category.deleted', { categoryId: payload.categoryId }, message.id));
  broadcastCategoryUpdate('deleted', { categoryId: payload.categoryId }, connection.id);
}

function handleCategoryReorder(connection: ClientConnection, message: ClientMessage): void {
  const payload = message.payload as CategoryReorderPayload;

  if (!payload?.categories || !Array.isArray(payload.categories)) {
    connection.ws.send(createMessage('error', { message: 'Categories array required' }, message.id));
    return;
  }

  reorderCategories(payload.categories);

  connection.ws.send(createMessage('category.reordered', { categories: payload.categories }, message.id));
  broadcastCategoryUpdate('reordered', { categories: payload.categories }, connection.id);
}

function handleCategoryToggle(connection: ClientConnection, message: ClientMessage): void {
  const payload = message.payload as CategoryTogglePayload;

  if (!payload?.categoryId || typeof payload.collapsed !== 'boolean') {
    connection.ws.send(createMessage('error', { message: 'Category ID and collapsed state required' }, message.id));
    return;
  }

  const existing = getCategory(payload.categoryId);
  if (!existing) {
    connection.ws.send(createMessage('error', { message: 'Category not found' }, message.id));
    return;
  }

  updateCategory(payload.categoryId, { collapsed: payload.collapsed });

  connection.ws.send(createMessage('category.toggled', { categoryId: payload.categoryId, collapsed: payload.collapsed }, message.id));
  broadcastCategoryUpdate('toggled', { categoryId: payload.categoryId, collapsed: payload.collapsed }, connection.id);
}

function handleSessionMove(connection: ClientConnection, message: ClientMessage): void {
  const payload = message.payload as SessionMovePayload;

  if (!payload?.sessionId) {
    connection.ws.send(createMessage('error', { message: 'Session ID required' }, message.id));
    return;
  }

  // categoryId can be null (uncategorized)
  const categoryId = payload.categoryId || null;

  // If categoryId is provided, verify it exists
  if (categoryId) {
    const existing = getCategory(categoryId);
    if (!existing) {
      connection.ws.send(createMessage('error', { message: 'Category not found' }, message.id));
      return;
    }
  }

  updateSessionCategory(payload.sessionId, categoryId);

  connection.ws.send(createMessage('session.moved', { sessionId: payload.sessionId, categoryId }, message.id));
  broadcastSessionMoved(payload.sessionId, categoryId, connection.id);
}

function categoryToInfo(category: { id: string; name: string; sortOrder: number; collapsed: boolean }): CategoryInfo {
  return {
    id: category.id,
    name: category.name,
    sortOrder: category.sortOrder,
    collapsed: category.collapsed,
  };
}

function broadcastCategoryUpdate(event: 'created' | 'renamed' | 'deleted' | 'reordered' | 'toggled', payload: unknown, excludeClientId?: string): void {
  const messageType = `category.${event}` as const;

  for (const conn of connections.values()) {
    if (conn.id !== excludeClientId && conn.ws.readyState === WS_OPEN) {
      conn.ws.send(createMessage(messageType, payload));
    }
  }
}

function broadcastSessionMoved(sessionId: string, categoryId: string | null, excludeClientId?: string): void {
  for (const conn of connections.values()) {
    if (conn.id !== excludeClientId && conn.ws.readyState === WS_OPEN) {
      conn.ws.send(createMessage('session.moved', { sessionId, categoryId }));
    }
  }
}

// Notification handlers

function handleNotificationPreferencesGet(connection: ClientConnection, message: ClientMessage): void {
  const userId = connection.identity?.userId;
  if (!userId) {
    connection.ws.send(createMessage('error', { message: 'User not authenticated' }, message.id));
    return;
  }

  const prefs = getNotificationPreferences(userId);
  connection.ws.send(createMessage('notification.preferences', {
    browserEnabled: prefs.browserEnabled,
    visualEnabled: prefs.visualEnabled,
    notifyOnInput: prefs.notifyOnInput,
    notifyOnCompleted: prefs.notifyOnCompleted,
  }, message.id));
}

function handleNotificationPreferencesSet(connection: ClientConnection, message: ClientMessage): void {
  const userId = connection.identity?.userId;
  if (!userId) {
    connection.ws.send(createMessage('error', { message: 'User not authenticated' }, message.id));
    return;
  }

  const payload = message.payload as NotificationPreferencesSetPayload;
  if (!payload) {
    connection.ws.send(createMessage('error', { message: 'Preferences payload required' }, message.id));
    return;
  }

  // Get current preferences and merge with updates
  const current = getNotificationPreferences(userId);
  const updated: NotificationPreferences = {
    userId,
    browserEnabled: payload.browserEnabled ?? current.browserEnabled,
    visualEnabled: payload.visualEnabled ?? current.visualEnabled,
    notifyOnInput: payload.notifyOnInput ?? current.notifyOnInput,
    notifyOnCompleted: payload.notifyOnCompleted ?? current.notifyOnCompleted,
  };

  setNotificationPreferences(updated);

  connection.ws.send(createMessage('notification.preferences.updated', {
    browserEnabled: updated.browserEnabled,
    visualEnabled: updated.visualEnabled,
    notifyOnInput: updated.notifyOnInput,
    notifyOnCompleted: updated.notifyOnCompleted,
  }, message.id));
}

function handleNotificationDismiss(connection: ClientConnection, message: ClientMessage): void {
  const payload = message.payload as NotificationDismissPayload;
  if (!payload?.sessionId) {
    connection.ws.send(createMessage('error', { message: 'Session ID required' }, message.id));
    return;
  }

  // Clear notification for this session
  notificationService.clearSessionNotification(payload.sessionId);
  logger.debug({ sessionId: payload.sessionId, clientId: connection.id }, 'Notification dismissed');
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
