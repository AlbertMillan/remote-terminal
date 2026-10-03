import { execFile, spawn } from 'child_process';
import { randomUUID } from 'crypto';
import { existsSync, readFileSync } from 'fs';
import { join, relative, resolve } from 'path';
import { promisify } from 'util';
import type { FastifyInstance } from 'fastify';
import { createLogger } from './utils/logger.js';
import { isAllowedWebSocketOrigin } from './websocket/origin.js';
import { extractIpFromRequest, verifyTailscaleConnection } from './auth/tailscale.js';
import { buildProject, type BuildResult } from './projects/project-build.js';

const logger = createLogger('server-restart');
const execFileAsync = promisify(execFile);

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
  /** The build-state check; by default one built from dist/build-info.json at registration. */
  buildChecker?: BuildStateChecker;
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
  if (!runsFromDist(deps.projectRoot, deps.entryScript)) {
    return { canRestart: false, reason: 'The server is not running from dist/ (dev mode?) — restart it where you started it.' };
  }
  return { canRestart: true, reason: null };
}

// --- Is the running server behind its build? ------------------------------
//
// `npm run build` stamps dist/build-info.json (scripts/write-build-info.mjs)
// with the commit it built. The stamp read at boot is the build this server
// *runs*; read again on demand it is the build *on disk*. Stamps, not mtimes:
// a folder's mtime doesn't change when the files in it are overwritten, and no
// mtime says which commit was built. Spec: project/server-behind-build.md.

export interface BuildStamp {
  /** HEAD when the build ran. */
  sha: string;
  builtAt: string;
  /**
   * The git tree of the working copy the build compiled (HEAD plus uncommitted
   * and untracked changes). Absent from older stamps; `sha` stands in then.
   */
  inputsTree?: string | null;
}

/**
 * `restart`: dist/ holds a build whose inputs differ from the running one's.
 * `rebuild`: a build input changed in a commit after what dist/ was built
 * from. `unknown`: no stamp, no git, or not running from dist/ — nothing is
 * shown then.
 */
export type BuildState = 'current' | 'restart' | 'rebuild' | 'unknown';

export interface BuildStatus {
  state: BuildState;
  running: BuildStamp | null;
  onDisk: BuildStamp | null;
  reason: string | null;
}

/**
 * What a build reads. A docs-only commit — a planning commit, a Land's tick
 * commit — changes none of these, and must not ask for a rebuild or restart.
 * scripts/write-build-info.mjs keeps its own copy; a test checks they match.
 */
export const BUILD_INPUTS = ['src', 'package.json', 'package-lock.json', 'tsconfig*.json', 'scripts/copy-client-assets.mjs'];

/** How long a `git diff` answer is reused: the client polls, and git costs ~100ms on Windows. */
const DIFF_CACHE_MS = 30_000;

export function buildInfoPath(projectRoot: string): string {
  return join(projectRoot, 'dist', 'build-info.json');
}

/** The stamp in dist/, or null when there is none (a dist/ built before stamps) or it has no sha. */
export function readBuildStamp(projectRoot: string): BuildStamp | null {
  try {
    const parsed = JSON.parse(readFileSync(buildInfoPath(projectRoot), 'utf-8')) as Partial<BuildStamp>;
    if (typeof parsed.sha !== 'string' || !parsed.sha || typeof parsed.builtAt !== 'string') return null;
    return {
      sha: parsed.sha,
      builtAt: parsed.builtAt,
      inputsTree: typeof parsed.inputsTree === 'string' && parsed.inputsTree ? parsed.inputsTree : null,
    };
  } catch {
    return null;
  }
}

/** What a build actually compiled: its working-tree id, or its commit for an older stamp. */
function builtFrom(stamp: BuildStamp): string {
  return stamp.inputsTree || stamp.sha;
}

/** True when this process was started from the project's dist/, not tsx (dev mode). */
export function runsFromDist(projectRoot: string, entryScript = process.argv[1] ?? ''): boolean {
  const distEntry = join(projectRoot, 'dist', 'server', 'index.js');
  return resolve(entryScript).toLowerCase() === distEntry.toLowerCase();
}

/**
 * Build inputs that differ between two tree-ish (a commit, a tree id, HEAD),
 * or null when git can't say (not a repo, or one side no longer exists after
 * a rewrite). Committed changes only, on the HEAD side: an uncommitted edit
 * says nothing about what landed, and would keep the chip lit through
 * ordinary work.
 */
async function changedInputs(projectRoot: string, from: string, to: string): Promise<string[] | null> {
  try {
    const { stdout } = await execFileAsync('git', ['diff', '--name-only', from, to, '--', ...BUILD_INPUTS], {
      cwd: projectRoot,
      windowsHide: true,
      maxBuffer: 4 * 1024 * 1024,
    });
    return stdout.split('\n').map((l) => l.trim()).filter(Boolean);
  } catch {
    return null;
  }
}

function describeStamp(stamp: BuildStamp): string {
  return `${stamp.sha.slice(0, 8)}, built ${stamp.builtAt}`;
}

function listFiles(files: string[]): string {
  return files.slice(0, 5).join(', ') + (files.length > 5 ? `, and ${files.length - 5} more` : '');
}

export interface BuildStateChecker {
  check(): Promise<BuildStatus>;
  /** Forget every cached `git diff`: after a Land, a build or a restart request. */
  invalidate(): void;
}

/**
 * The build-state check for one server. `running` is the stamp read at boot,
 * or null when it can't be trusted (dev mode, no stamp) — the state is then
 * `unknown`, whatever is on disk.
 */
export function createBuildStateChecker(
  projectRoot: string,
  running: BuildStamp | null,
  opts: {
    now?: () => number;
    unknownReason?: string;
    /** The git comparison; tests replace it to control timing. */
    diff?: (from: string, to: string) => Promise<string[] | null>;
  } = {}
): BuildStateChecker {
  const now = opts.now ?? Date.now;
  const compare = opts.diff ?? ((from: string, to: string) => changedInputs(projectRoot, from, to));
  // One entry per comparison, holding the promise rather than its answer:
  // overlapping checks (tabs, focus, the restart wait's 1s poll) share a single
  // git, and invalidate() drops the map, so a git that started before it can
  // never write its older answer back in afterwards.
  let cache = new Map<string, { at: number; result: Promise<string[] | null> }>();

  const diff = (from: string, to: string): Promise<string[] | null> => {
    const key = `${from}..${to}`;
    const hit = cache.get(key);
    if (hit && now() - hit.at < DIFF_CACHE_MS) return hit.result;
    const result = compare(from, to);
    cache.set(key, { at: now(), result });
    return result;
  };

  return {
    invalidate: () => {
      cache = new Map();
    },
    async check(): Promise<BuildStatus> {
      const onDisk = readBuildStamp(projectRoot);
      if (!running) {
        return {
          state: 'unknown',
          running,
          onDisk,
          reason: opts.unknownReason ?? 'This server started from a build with no stamp.',
        };
      }
      if (!onDisk) return { state: 'unknown', running, onDisk, reason: 'dist/ has no build stamp.' };

      const behind = await diff(builtFrom(onDisk), 'HEAD');
      if (behind === null) {
        return { state: 'unknown', running, onDisk, reason: `git could not compare ${onDisk.sha.slice(0, 8)} with HEAD.` };
      }
      // Rebuild wins: a plain restart would only load a build that is already stale.
      if (behind.length > 0) {
        return {
          state: 'rebuild',
          running,
          onDisk,
          reason: `Committed since dist/ was built (${describeStamp(onDisk)}): ${listFiles(behind)}.`,
        };
      }

      if (onDisk.sha === running.sha && onDisk.builtAt === running.builtAt) {
        return { state: 'current', running, onDisk, reason: null };
      }
      // A newer build is only worth a restart — which ends every terminal —
      // when it compiled different inputs. Every Land rebuilds, a docs-only
      // one included. If git can't compare the two, say restart: hiding a
      // build that does differ is the worse mistake.
      const newer = await diff(builtFrom(running), builtFrom(onDisk));
      if (newer !== null && newer.length === 0) {
        return { state: 'current', running, onDisk, reason: null };
      }
      return {
        state: 'restart',
        running,
        onDisk,
        reason:
          `dist/ holds ${describeStamp(onDisk)}; this server runs ${describeStamp(running)}` +
          (newer ? `. Changed: ${listFiles(newer)}.` : '.'),
      };
    },
  };
}

// The checker for this process, set when its routes are registered. Land, in
// projects/routes.ts, reaches it through the two functions below.
let serverBuild: { root: string; checker: BuildStateChecker } | null = null;

/**
 * True when `cwd` is this server's own project, the only one it can restart
 * into. `relative()` is '' for the same folder however it is spelled (slashes,
 * a trailing separator, and case on Windows only), so this stays right on Linux.
 */
export function isServerRoot(cwd: string): boolean {
  return !!serverBuild && relative(resolve(serverBuild.root), resolve(cwd)) === '';
}

/** Drop the cached answers and check again; null before the routes are registered. */
export async function recheckBuildState(): Promise<BuildStatus | null> {
  if (!serverBuild) return null;
  serverBuild.checker.invalidate();
  return serverBuild.checker.check();
}

/** What Land adds when it landed this server's own project and the server is now behind. */
export function restartHint(state: BuildState | undefined): string {
  if (state === 'restart') return ' — restart to load it';
  if (state === 'rebuild') return ' — Build & restart to load it';
  return '';
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

  // The build this process runs is the stamp in dist/ *now*, at boot — read
  // once. Under tsx (dev mode) the code comes from src/, so no stamp describes it.
  const fromDist = runsFromDist(deps.projectRoot, deps.entryScript);
  const checker =
    deps.buildChecker ??
    createBuildStateChecker(deps.projectRoot, fromDist ? readBuildStamp(deps.projectRoot) : null, {
      unknownReason: fromDist
        ? 'dist/ had no build stamp when this server started (built before stamps existed).'
        : 'The server is not running from dist/ (dev mode?), so no build describes it.',
    });
  serverBuild = { root: deps.projectRoot, checker };

  app.get('/api/server/status', async () => {
    return { bootId: BOOT_ID, ...restartAvailability(deps), build: await checker.check() };
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

    // A restart (or its build) changes what's running or on disk; a refused or
    // failed one leaves the server up, and the next status must re-check.
    checker.invalidate();

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
        checker.invalidate();
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
