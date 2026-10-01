import { spawn } from 'child_process';
import { randomUUID } from 'crypto';
import { existsSync } from 'fs';
import { join, resolve } from 'path';
import type { FastifyInstance } from 'fastify';
import { createLogger } from './utils/logger.js';
import { isAllowedWebSocketOrigin } from './websocket/origin.js';
import { extractIpFromRequest, verifyTailscaleConnection } from './auth/tailscale.js';
import { buildProject, type BuildResult } from './projects/project-build.js';

const logger = createLogger('server-restart');

/**
 * Restart (and optionally rebuild) the server from the web UI.
 *
 * The restart itself is restart-server.vbs, the same launcher used by hand. It
 * must be spawned *detached*: every terminal is a child of this process and dies
 * with it, and so would a restart script spawned as an ordinary child — before
 * it could start the server again. The VBS hands off to restart-server.ps1 in its
 * own process tree, which stops this server, waits for the port and starts dist/.
 *
 * Sessions survive as stale rows and revive from the sidebar, exactly as after a
 * manual restart: nothing here marks them terminated.
 */

/** Changes on every boot, so the client can tell the new server from the old one. */
export const BOOT_ID = randomUUID();

/** restart-server.ps1's default port, the only one restart-server.vbs passes. */
const LAUNCHER_PORT = 4220;

/** How long to let the 202 reach the browser before the server is killed. */
const LAUNCH_DELAY_MS = 300;

export interface RestartAvailability {
  canRestart: boolean;
  /** Why not, when canRestart is false. */
  reason: string | null;
}

export interface ServerRestartDeps {
  projectRoot: string;
  /** The port this server listens on; restart-server.vbs only handles the default. */
  port: number;
  /** The script this process was started with; restart-server.ps1 only stops `dist/server/index.js`. */
  entryScript?: string;
  platform?: NodeJS.Platform;
  build?: (cwd: string) => Promise<BuildResult>;
  launch?: (vbsPath: string) => void;
  verify?: (ip: string) => Promise<unknown>;
}

export function restartAvailability(deps: ServerRestartDeps): RestartAvailability {
  const platform = deps.platform ?? process.platform;
  if (platform !== 'win32') {
    return { canRestart: false, reason: 'Restart from the UI is only wired up on Windows (restart-server.vbs).' };
  }
  if (!existsSync(join(deps.projectRoot, 'restart-server.vbs'))) {
    return { canRestart: false, reason: 'restart-server.vbs is missing from the project root.' };
  }
  // The script stops every dist/ server whatever its port, then waits on and starts
  // 4220 — so from a second instance (an isolated QA boot) it would kill the live one.
  if (deps.port !== LAUNCHER_PORT) {
    return { canRestart: false, reason: `restart-server.vbs only restarts the server on port ${LAUNCHER_PORT}; this one is on ${deps.port}.` };
  }
  // Under `npm run dev` the process is tsx, which the restart script would not
  // stop — it would then fail to bind the port, or start a second server.
  const entry = deps.entryScript ?? process.argv[1] ?? '';
  const distEntry = join(deps.projectRoot, 'dist', 'server', 'index.js');
  if (resolve(entry).toLowerCase() !== distEntry.toLowerCase()) {
    return { canRestart: false, reason: 'The server is not running from dist/ (dev mode?) — restart it where you started it.' };
  }
  return { canRestart: true, reason: null };
}

function launchDetached(vbsPath: string): void {
  const child = spawn('wscript.exe', [vbsPath], { detached: true, stdio: 'ignore', windowsHide: true });
  child.on('error', (error) => logger.error({ error: error.message }, 'restart launcher failed to spawn'));
  child.unref();
}

export function registerServerRestartRoutes(app: FastifyInstance, deps: ServerRestartDeps): void {
  const build = deps.build ?? buildProject;
  const launch = deps.launch ?? launchDetached;
  const verify = deps.verify ?? verifyTailscaleConnection;
  // Once set it never clears: a launched restart ends this process. A failed
  // build clears it, since the server stays up.
  let busy = false;

  app.get('/api/server/status', async () => {
    return { bootId: BOOT_ID, ...restartAvailability(deps) };
  });

  app.post<{ Body?: { build?: unknown } }>('/api/server/restart', async (request, reply) => {
    // Killing every terminal is the most destructive thing the API does, so it
    // gets the WebSocket's checks: same-origin (a cross-site form post always
    // carries Origin) and a Tailscale identity for the caller.
    if (!isAllowedWebSocketOrigin(request.headers.origin, request.headers.host)) {
      logger.warn({ origin: request.headers.origin }, 'restart rejected: cross-origin');
      return reply.status(403).send({ error: 'Cross-origin request refused' });
    }
    if (!(await verify(extractIpFromRequest(request)))) {
      return reply.status(403).send({ error: 'Not authorized' });
    }

    const availability = restartAvailability(deps);
    if (!availability.canRestart) {
      return reply.status(409).send({ error: availability.reason });
    }
    if (busy) {
      return reply.status(409).send({ error: 'A restart is already in progress' });
    }
    busy = true;

    const withBuild = request.body?.build === true;
    if (withBuild) {
      logger.info('build requested before restart');
      const result = await build(deps.projectRoot);
      if (!result.ok) {
        busy = false;
        // The old dist/ may now be half-written, but the running server already
        // has its code in memory; it stays up so the user can fix and retry.
        return reply.status(500).send({ error: 'Build failed — server not restarted', detail: result.detail });
      }
    }

    const vbsPath = join(deps.projectRoot, 'restart-server.vbs');
    logger.info({ withBuild }, 'restarting server');
    setTimeout(() => launch(vbsPath), LAUNCH_DELAY_MS);
    return reply.status(202).send({ restarting: true, built: withBuild, bootId: BOOT_ID });
  });
}
