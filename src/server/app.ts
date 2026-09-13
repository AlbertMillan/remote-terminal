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
import { cleanupOrphanedForkFiles, sweepUnloggedSessions } from './sessions/manager.js';
import { generateSessionLogForced, generateProjectBackfill, resyncProjectPhases } from './sessions/project-log.js';
import { discoverProjects, findProjectByCwd, getProjectBoard, pathKey } from './sessions/project-discovery.js';
import { deleteHistoryEntry, HistoryDeleteError } from './sessions/history-delete.js';
import { getRecentPaths } from './sessions/recent-paths.js';

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
  // Retroactively log sessions that ended via crash/OS-shutdown (no-op if disabled)
  sweepUnloggedSessions();

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

  // Create Fastify instance. When TLS is off, `https` must be OMITTED rather than
  // passed as undefined: a literal `https: undefined` matches none of Fastify's
  // overloads, so it falls back to inferring the HTTP/2 signature and every route
  // handler downstream then mismatches on Http2ServerRequest vs IncomingMessage.
  // The TLS branch really does produce FastifyInstance<https.Server>, which is not
  // assignable to the http default, hence the narrow cast — only the raw-server
  // generic differs; the instance is identical at runtime.
  const app: FastifyInstance = httpsOptions
    ? (Fastify({ logger: false, https: httpsOptions }) as unknown as FastifyInstance)
    : Fastify({ logger: false });

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

  // Recent working directories (for the new-session path dropdown)
  app.get('/api/recent-paths', async () => {
    return { paths: getRecentPaths().map((p) => p.cwd) };
  });

  // Project logs: cross-project board (discovery + parsed SESSION-LOG.md entries)
  app.get('/api/project-logs', async () => {
    return { projects: getProjectBoard() };
  });

  // Backfill SESSION-LOG.md for specific projects without one. Body REQUIRES
  // { cwds: string[] } — there is intentionally no "all projects" mode, so a
  // single request can't quietly queue a paid claude run for every repo on disk.
  // Jobs fire into the bounded generation queue; the request returns 202 and
  // progress is observable via GET /api/project-logs as each `hasLog` flips.
  // Projects with an existing log are never overwritten.
  app.post<{ Body?: { cwds?: string[] } }>('/api/project-logs/backfill', async (request, reply) => {
    const body = (request.body || {}) as { cwds?: string[] };
    if (!Array.isArray(body.cwds) || body.cwds.length === 0) {
      return reply.status(400).send({ error: 'cwds required (per-project backfill only)' });
    }
    const wanted = new Set(body.cwds.map(pathKey));
    const targets = discoverProjects().filter((p) => !p.hasLog && wanted.has(pathKey(p.cwd)));

    // Fire-and-forget: generateProjectBackfill is queue-bounded and never throws.
    for (const p of targets) {
      void generateProjectBackfill({ cwd: p.cwd, transcriptPaths: p.transcriptPaths });
    }
    logger.info({ accepted: targets.length }, 'project-log: backfill accepted');
    return reply.status(202).send({ accepted: targets.length, cwds: targets.map((p) => p.cwd) });
  });

  // Re-sync a single project's phases manifest from its current plan docs (no
  // session entry written). Synchronous: the client awaits and reloads the board.
  app.post<{ Body?: { cwd?: string } }>('/api/project-logs/resync', async (request, reply) => {
    const cwd = (request.body as { cwd?: string } | undefined)?.cwd;
    if (!cwd || typeof cwd !== 'string') {
      return reply.status(400).send({ error: 'cwd required' });
    }
    // Only run the write-capable agent in a directory we actually discovered —
    // never an arbitrary path supplied by the request.
    const project = findProjectByCwd(cwd);
    if (!project) {
      return reply.status(404).send({ error: 'Unknown project' });
    }
    const outcome = await resyncProjectPhases(project.cwd);
    return { cwd: project.cwd, outcome };
  });

  // Delete one session-history entry from a project's SESSION-LOG.md, and the
  // backing Claude transcript with it. The transcript is only unlinked once no
  // surviving entry references it (several entries can share one conversation),
  // so pass scope: 'conversation' to clear every entry for that session id at once.
  app.post<{
    Body?: { cwd?: string; entryIndex?: number; claudeSessionId?: string | null; scope?: string };
  }>('/api/project-logs/entry/delete', async (request, reply) => {
    const body = (request.body || {}) as {
      cwd?: string;
      entryIndex?: number;
      claudeSessionId?: string | null;
      scope?: string;
    };
    if (!body.cwd || typeof body.cwd !== 'string') {
      return reply.status(400).send({ error: 'cwd required' });
    }
    if (typeof body.entryIndex !== 'number' || !Number.isInteger(body.entryIndex) || body.entryIndex < 0) {
      return reply.status(400).send({ error: 'entryIndex required (non-negative integer)' });
    }
    try {
      return deleteHistoryEntry({
        cwd: body.cwd,
        entryIndex: body.entryIndex,
        expectedClaudeSessionId: body.claudeSessionId ?? null,
        scope: body.scope === 'conversation' ? 'conversation' : 'entry',
      });
    } catch (error) {
      if (error instanceof HistoryDeleteError) {
        return reply.status(error.status).send({ error: error.message });
      }
      logger.error({ error }, 'project-log: entry delete failed');
      return reply.status(500).send({ error: error instanceof Error ? error.message : 'Delete failed' });
    }
  });

  // Claude session ID registration (called by the Stop hook)
  app.post<{
    Params: { sessionId: string };
    Body: { claudeSessionId: string; cwd?: string };
  }>('/api/session/:sessionId/claude-session', async (request, reply) => {
    const { sessionId } = request.params;
    const body = request.body as { claudeSessionId?: string; cwd?: string };
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

    let cwd = typeof body?.cwd === 'string' && body.cwd.length > 0 ? body.cwd : undefined;
    // Convert MSYS/Git Bash Unix-style paths to Windows paths (e.g. /c/Users/... → C:\Users\...).
    // Uppercase the drive letter: Git Bash emits a lowercase /c/, but Windows convention (and
    // claude --resume's case-sensitive cwd matching) expects C:\. Preserving the lowercase here
    // previously seeded lowercase cwds into the DB, hiding sessions from the resume picker.
    if (cwd && process.platform === 'win32') {
      cwd = cwd.replace(/^\/([a-zA-Z])\//, (_, d) => `${d.toUpperCase()}:\\`).replace(/\//g, '\\');
    }
    setClaudeSessionId(sessionId, claudeSessionId, cwd);
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

  // Dev-only: smoke-test the project-log generator against an existing session.
  // Registered only when CLAUDE_REMOTE_DEV=1 so it never exists in production.
  // Runs even if projectLog.enabled is false, so you can test without flipping
  // the global config. Example:
  //   curl -X POST http://localhost:4220/api/dev/project-log/<sessionId>
  if (process.env.CLAUDE_REMOTE_DEV === '1') {
    app.post<{ Params: { sessionId: string } }>(
      '/api/dev/project-log/:sessionId',
      async (request, reply) => {
        const { sessionId } = request.params;
        const session = getSessionFromDb(sessionId);
        if (!session) {
          return reply.status(404).send({ error: 'Session not found' });
        }
        if (!session.claudeSessionId) {
          return reply.status(400).send({
            error: 'Session has no claudeSessionId — ensure the claude-session hook ran for it.',
          });
        }
        logger.info({ sessionId }, 'Dev endpoint: forcing project-log generation');
        const outcome = await generateSessionLogForced({
          sessionId: session.id,
          name: session.name,
          cwd: session.cwd,
          claudeSessionId: session.claudeSessionId,
          createdAt: session.createdAt,
        });
        return { sessionId, outcome, cwd: session.cwd, fileName: getConfig().projectLog.fileName };
      }
    );
    logger.warn('Dev endpoint enabled: POST /api/dev/project-log/:sessionId');
  }

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
