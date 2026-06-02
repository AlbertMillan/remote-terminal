import Fastify, { type FastifyInstance } from 'fastify';
import fastifyWebsocket from '@fastify/websocket';
import fastifyStatic from '@fastify/static';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import { getConfig, loadConfig } from './config.js';
import { createLogger } from './utils/logger.js';
import { initDatabase, closeDatabase } from './db/schema.js';
import { handleConnection, closeAllConnections } from './websocket/handler.js';
import { sessionManager } from './sessions/manager.js';
import { getTailscaleCertPaths, getTailscaleStatus } from './auth/tailscale.js';
import { notificationService, type NotificationType } from './notifications/service.js';
import { setClaudeSessionId, getSession as getSessionFromDb } from './db/queries.js';
import { cleanupOrphanedForkFiles } from './sessions/manager.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const logger = createLogger('app');

export async function createApp(): Promise<FastifyInstance> {
  // Load configuration
  loadConfig();
  const config = getConfig();

  // Initialize database
  initDatabase();
  cleanupOrphanedForkFiles();

  // Determine TLS configuration
  let httpsOptions: { key: Buffer; cert: Buffer } | undefined;

  if (config.tls.enabled) {
    if (config.tls.certPath && config.tls.keyPath) {
      // Use configured cert paths
      try {
        httpsOptions = {
          key: readFileSync(config.tls.keyPath),
          cert: readFileSync(config.tls.certPath),
        };
        logger.info('Using configured TLS certificates');
      } catch (error) {
        logger.error({ error }, 'Failed to load TLS certificates');
      }
    } else {
      // Try to get Tailscale certs
      const tailscaleCerts = await getTailscaleCertPaths();
      if (tailscaleCerts) {
        try {
          httpsOptions = {
            key: readFileSync(tailscaleCerts.keyPath),
            cert: readFileSync(tailscaleCerts.certPath),
          };
          logger.info({ certPath: tailscaleCerts.certPath }, 'Using Tailscale TLS certificates');
        } catch (error) {
          logger.warn({ error }, 'Failed to load Tailscale certificates, falling back to HTTP');
        }
      }
    }
  }

  // Create Fastify instance
  const app = Fastify({
    logger: false, // We use our own logger
    https: httpsOptions,
  });

  // Register WebSocket plugin
  await app.register(fastifyWebsocket);

  // Determine static files path
  // In dev mode, __dirname is src/server, so we need to go up to project root
  // In production, __dirname is dist/server
  const projectRoot = join(__dirname, '..', '..');
  const clientDistPath = join(projectRoot, 'dist', 'client');
  const clientSrcPath = join(projectRoot, 'src', 'client');

  // Use dist/client if it exists (has built JS files), otherwise fall back to src/client
  const staticPath = existsSync(join(clientDistPath, 'terminal.js')) ? clientDistPath : clientSrcPath;

  logger.debug({ staticPath }, 'Serving static files from');

  // Register static file serving
  await app.register(fastifyStatic, {
    root: staticPath,
    prefix: '/',
  });

  // Health check endpoint
  app.get('/health', async () => {
    const tailscaleStatus = await getTailscaleStatus();
    return {
      status: 'ok',
      timestamp: new Date().toISOString(),
      sessions: sessionManager.getAllSessions().length,
      tailscale: tailscaleStatus,
    };
  });

  // API endpoints
  app.get('/api/sessions', async () => {
    return { sessions: sessionManager.getSessionList() };
  });

  // Claude session ID registration (called by the Stop hook)
  app.post<{
    Params: { sessionId: string };
    Body: { claudeSessionId: string };
  }>('/api/session/:sessionId/claude-session', async (request, reply) => {
    const { sessionId } = request.params;
    const body = request.body as { claudeSessionId?: string };
    const claudeSessionId = body?.claudeSessionId;

    if (!claudeSessionId || typeof claudeSessionId !== 'string') {
      return reply.status(400).send({ error: 'claudeSessionId required' });
    }

    const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (!uuidPattern.test(claudeSessionId)) {
      return reply.status(400).send({ error: 'Invalid claudeSessionId format' });
    }

    // C2: Validate session exists to prevent arbitrary ID poisoning
    const activeSession = sessionManager.getSession(sessionId);
    if (!activeSession) {
      const dbSession = getSessionFromDb(sessionId);
      if (!dbSession) {
        return reply.status(404).send({ error: 'Session not found' });
      }
    }

    setClaudeSessionId(sessionId, claudeSessionId);
    return { success: true };
  });

  // Notification webhook endpoint
  app.post<{
    Params: { sessionId: string; type: string };
  }>('/api/notify/:sessionId/:type', async (request, reply) => {
    const { sessionId, type } = request.params;

    // Validate notification type
    if (type !== 'needs-input' && type !== 'completed') {
      return reply.status(400).send({ error: 'Invalid notification type. Use "needs-input" or "completed".' });
    }

    // Validate session exists
    const session = sessionManager.getSession(sessionId);
    if (!session) {
      // Session might not be active but still valid - allow notification
      logger.debug({ sessionId, type }, 'Notification for inactive session');
    }

    // Trigger notification
    notificationService.notify(sessionId, type as NotificationType);

    return { success: true, sessionId, type };
  });

  // WebSocket endpoint
  app.get('/ws', { websocket: true }, (socket, request) => {
    handleConnection(socket, request);
  });

  // Graceful shutdown handler
  const shutdown = async () => {
    logger.info('Shutting down...');

    // Close all WebSocket connections
    closeAllConnections();

    // Shutdown session manager
    await sessionManager.shutdown();

    // Close database
    closeDatabase();

    // Close server
    await app.close();

    logger.info('Shutdown complete');
  };

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);

  return app;
}
