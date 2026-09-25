import type { WebSocket } from 'ws';
import type { FastifyRequest } from 'fastify';
import { randomUUID } from 'crypto';
import { createLogger } from '../utils/logger.js';
import { RateLimiter } from '../utils/rate-limiter.js';
import {
  parseMessage,
  createMessage,
  type NotificationPayload,
  type JobsSummaryPayload,
} from './protocol.js';
import {
  verifyTailscaleConnection,
  extractIpFromRequest,
} from '../auth/tailscale.js';
import { notificationService, type Notification } from '../notifications/service.js';
import { jobEvents } from '../jobs/events.js';
import { buildJobsSummary } from '../jobs/summary.js';
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

export { getActiveConnections, closeAllConnections };

const logger = createLogger('websocket');

// Rate limiter: 100 messages per second with token bucket
const rateLimiter = new RateLimiter(100, 10);

// Register notification service callback
notificationService.onNotification((notification: Notification) => {
  handleNotification(notification);
});

/**
 * Push the job feed to every connected client whenever a job or stage changes.
 *
 * Rebuilt per change rather than diffed: the summary is a few hundred bytes and
 * a burst of writes inside one transition collapses into whatever the last one
 * sees, which is the state we want to send anyway.
 */
let jobsBroadcastQueued = false;

jobEvents.onChange(() => {
  // One logical transition writes several rows -- finishStage then updateJob,
  // and a stage's usage besides -- and each write fires. Collapsing them onto a
  // microtask sends the settled state once instead of broadcasting each
  // intermediate one. Writes separated by an await land in different turns and
  // are still sent separately, which is right: they are different states.
  if (jobsBroadcastQueued) return;
  jobsBroadcastQueued = true;
  queueMicrotask(() => {
    jobsBroadcastQueued = false;
    broadcastJobsSummary();
  });
});

function broadcastJobsSummary(target?: ClientConnection): void {
  const targets = (target ? [target] : [...connections.values()]).filter(
    (conn) => conn.ws.readyState === WS_OPEN
  );
  // Build nothing when nobody is listening: a job running overnight with no
  // browser open would otherwise pay for a summary on every write.
  if (targets.length === 0) return;

  let payload: JobsSummaryPayload;
  try {
    payload = buildJobsSummary();
  } catch (error) {
    logger.error({ error }, 'Failed to build job summary');
    return;
  }

  const message = createMessage('jobs.summary', payload);
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

  // Seed the job overlay before anything moves, so a freshly loaded page is not
  // blank until the next stage transition (which may be 20 minutes away).
  broadcastJobsSummary(connection);

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

    case 'session.reorder':
      handleSessionReorder(connection, message);
      break;

    case 'session.fork':
      handleSessionFork(connection, message);
      break;

    case 'session.open':
      handleSessionOpen(connection, message);
      break;

    case 'session.revive':
      handleSessionRevive(connection, message);
      break;

    case 'session.keep':
      handleSessionKeep(connection, message);
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
