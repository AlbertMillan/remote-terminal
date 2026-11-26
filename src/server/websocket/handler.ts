import type { WebSocket } from 'ws';
import type { FastifyRequest } from 'fastify';
import { randomUUID } from 'crypto';
import { createLogger } from '../utils/logger.js';
import { RateLimiter } from '../utils/rate-limiter.js';
import { deviceIdFromUrl } from './validation.js';
import {
  parseMessage,
  createMessage,
  type ClientMessage,
  type ClientMessageType,
  type NotificationPayload,
  type AppStatePayload,
} from './protocol.js';
import {
  verifyTailscaleConnection,
  extractIpFromRequest,
} from '../auth/tailscale.js';
import { notificationService, type Notification } from '../notifications/service.js';
import { factoryEvents } from '../factory/events.js';
import { buildFactorySummary } from '../factory/board.js';
import { getDispatcher } from '../factory/dispatcher.js';
import {
  WS_OPEN,
  connections,
  type ClientConnection,
  detachFromSession,
  getActiveConnections,
  closeAllConnections,
} from './connections.js';
import {
  handleSessionList,
  handleSessionCreate,
  handleSessionAttach,
  handleSessionDetach,
  handleSessionTerminate,
  handleSessionDelete,
  handleSessionRename,
  handleSessionMove,
  handleSessionReorder,
  handleSessionFork,
  handleSessionOpen,
  handleSessionRevive,
  handleSessionStop,
  handleSessionChangeAccount,
  handleSessionKeep,
  handleTerminalData,
  handleTerminalResize,
} from './handlers/sessions.js';
import {
  handleCategoryList,
  handleCategoryCreate,
  handleCategoryRename,
  handleCategoryDelete,
  handleCategoryReorder,
  handleCategoryToggle,
} from './handlers/categories.js';
import {
  handleNotificationPreferencesGet,
  handleNotificationPreferencesSet,
  handleNotificationDismiss,
} from './handlers/notifications.js';
import type { FactorySummary } from '../../shared/protocol.js';

export { getActiveConnections, closeAllConnections };

const logger = createLogger('websocket');

// Rate limiter: 100 messages per second with token bucket
const rateLimiter = new RateLimiter(100, 10);

// Register notification service callback
notificationService.onNotification((notification: Notification) => {
  handleNotification(notification);
});

/**
 * Push the factory feed (the Factory overlay's cards) on every factory write.
 * Rebuilt per change rather than diffed, and one microtask collapses a
 * transition's several writes (a park updates the run state and every item of
 * a track) into one send of the settled state.
 */
let factoryBroadcastQueued = false;

factoryEvents.onChange(() => {
  if (factoryBroadcastQueued) return;
  factoryBroadcastQueued = true;
  queueMicrotask(() => {
    factoryBroadcastQueued = false;
    broadcastFactorySummary();
  });
});

function broadcastFactorySummary(target?: ClientConnection): void {
  const targets = (target ? [target] : [...connections.values()]).filter(
    (conn) => conn.ws.readyState === WS_OPEN
  );
  // Nobody listening: a factory working overnight pays for no summaries.
  if (targets.length === 0) return;

  let payload: FactorySummary;
  try {
    payload = buildFactorySummary({ dispatch: getDispatcher()?.status() ?? null });
  } catch (error) {
    logger.error({ error }, 'Failed to build factory summary');
    return;
  }

  const message = createMessage('factory.summary', payload);
  for (const conn of targets) conn.ws.send(message);
}

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
    deviceId: deviceIdFromUrl(request.url),
    lastSeenMs: Date.now(),
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

  // Seed the Factory overlay before anything moves, so a freshly loaded page is
  // not blank until the next factory write (which may be many minutes away).
  broadcastFactorySummary(connection);

  // Set up message handler with rate limiting
  ws.on('message', (data: Buffer | string) => {
    connection.lastSeenMs = Date.now();
    if (!rateLimiter.tryAcquire(clientId)) {
      ws.send(createMessage('error', { message: 'Rate limit exceeded' }));
      logger.warn({ clientId }, 'Client rate limited');
      return;
    }
    handleMessage(connection, data.toString());
  });

  // The app's OkHttp pings every 20 s (`ws` answers by itself): proof the socket is alive,
  // which isDeviceForeground() needs before it skips a push.
  ws.on('ping', () => {
    connection.lastSeenMs = Date.now();
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

type MessageHandler = (connection: ClientConnection, message: ClientMessage) => void | Promise<void>;

/**
 * One handler per client message type. Typed over ClientMessageType, so a type added to
 * protocol.ts without a handler here fails to compile. `auth` has none: identity comes from
 * the caller's IP when the socket opens, never from a message.
 */
const HANDLERS: Record<Exclude<ClientMessageType, 'auth'>, MessageHandler> = {
  ping: (connection, message) => connection.ws.send(createMessage('pong', undefined, message.id)),
  'session.list': handleSessionList,
  'session.create': handleSessionCreate,
  'session.attach': handleSessionAttach,
  'session.detach': handleSessionDetach,
  'session.terminate': handleSessionTerminate,
  'session.delete': handleSessionDelete,
  'session.rename': handleSessionRename,
  'session.move': handleSessionMove,
  'session.reorder': handleSessionReorder,
  'session.fork': handleSessionFork,
  'session.open': handleSessionOpen,
  'session.revive': handleSessionRevive,
  'session.stop': handleSessionStop,
  'session.changeAccount': handleSessionChangeAccount,
  'session.keep': handleSessionKeep,
  'category.create': handleCategoryCreate,
  'category.rename': handleCategoryRename,
  'category.delete': handleCategoryDelete,
  'category.reorder': handleCategoryReorder,
  'category.toggle': handleCategoryToggle,
  'category.list': handleCategoryList,
  'notification.preferences.get': handleNotificationPreferencesGet,
  'notification.preferences.set': handleNotificationPreferencesSet,
  'notification.dismiss': handleNotificationDismiss,
  'terminal.data': handleTerminalData,
  'terminal.resize': handleTerminalResize,
  'app.state': (connection, message) => {
    const payload = message.payload as AppStatePayload | undefined;
    connection.foreground = payload?.foreground === true;
  },
};

export function handlerFor(type: string): MessageHandler | undefined {
  return Object.prototype.hasOwnProperty.call(HANDLERS, type) ? HANDLERS[type as keyof typeof HANDLERS] : undefined;
}

function handleMessage(connection: ClientConnection, data: string): void {
  const message = parseMessage(data);

  if (!message) {
    connection.ws.send(createMessage('error', { message: 'Invalid message format' }));
    return;
  }

  logger.debug({ clientId: connection.id, type: message.type }, 'Received message');

  const handler = handlerFor(message.type);
  if (!handler) {
    connection.ws.send(createMessage('error', { message: `Unknown message type: ${message.type}` }, message.id));
    return;
  }
  // An async handler's failure is logged, never left as an unhandled rejection.
  const result = handler(connection, message);
  if (result instanceof Promise) {
    result.catch((error: unknown) => logger.error({ clientId: connection.id, type: message.type, error }, 'Message handler failed'));
  }
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
