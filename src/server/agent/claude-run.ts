import { spawn, execFile } from 'child_process';
import { randomUUID } from 'crypto';
import { unlinkSync } from 'fs';
import { join } from 'path';
import { promisify } from 'util';
import { getConfig } from '../config.js';
import { createLogger } from '../utils/logger.js';
import { recordRunEnd, recordRunStart, type RunTag } from '../usage/store.js';
import { emitRunSettled } from './run-events.js';

export type { RunTag } from '../usage/store.js';

const logger = createLogger('claude-run');
const execFileAsync = promisify(execFile);

/**
 * The one hardened path for headless `claude -p` runs: session-log generation,
 * PROJECT.md migration and every pipeline stage.
 *
 * A prompt's "only modify X" is ADVISORY — `--permission-mode acceptEdits`
 * auto-approves writes and the CLI cannot path-restrict them. Enforcement is
 * the working-tree diff taken around every run, which reverts anything touched
 * outside the allowed globs. Keep both halves.
 */

/**
 * Rejection raised when a run is aborted by its caller rather than failing.
 *
 * Distinct from a generic Error so callers can tell "the user stopped this" from
 * "this broke", and log it as the former. The job runner relies on the
 * distinction to avoid reporting a deliberate cancellation as a stage failure.
 */
export class RunAbortedError extends Error {
  constructor(message = 'run aborted') {
    super(message);
    this.name = 'RunAbortedError';
  }
}

/** "1200000ms" is not a number anyone reads as 20 minutes on a failed job row. */
function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const seconds = Math.round(ms / 1000);
  if (seconds < 120) return `${seconds}s`;
  const minutes = Math.round(seconds / 60);
  return `${minutes}m`;
}

// ---------------------------------------------------------------------------
// Concurrency queue — caps simultaneous `claude -p` runs, per lane.
// ---------------------------------------------------------------------------

/**
 * Runs queue per LANE, not globally — otherwise one project's stage waits on
 * another's, invisibly. See `docs/job-pipeline.md`.
 *
 * The lane is the project, passed by the job runner. Runs without one (the
 * session-log generator, PROJECT.md migration) share the default lane: they are
 * background work and should not multiply.
 */
const DEFAULT_LANE = '';

interface Lane {
  active: number;
  pending: (() => void)[];
}

const lanes = new Map<string, Lane>();

function laneFor(key: string): Lane {
  let lane = lanes.get(key);
  if (!lane) {
    lane = { active: 0, pending: [] };
    lanes.set(key, lane);
  }
  return lane;
}

export function runQueued<T>(task: () => Promise<T>, laneKey = DEFAULT_LANE): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const lane = laneFor(laneKey);
    const start = () => {
      lane.active++;
      task()
        .then(resolve, reject)
        .finally(() => {
          lane.active--;
          const next = lane.pending.shift();
          if (next) next();
          // An idle lane is dropped so a long-lived server does not accumulate
          // one per project it has ever touched.
          else if (lane.active === 0 && lane.pending.length === 0) lanes.delete(laneKey);
        });
    };
    if (lane.active < Math.max(1, getConfig().projectLog.maxConcurrent)) {
      start();
    } else {
      lane.pending.push(start);
    }
  });
}

/** Number of runs currently executing (for diagnostics and the job board). */
export function activeRunCount(): number {
  let total = 0;
  for (const lane of lanes.values()) total += lane.active;
  return total;
}

// ---------------------------------------------------------------------------
// Git helpers (read-only). All non-throwing — absence of git is a valid state.
// ---------------------------------------------------------------------------

/**
 * `-c` flags for commits claude-remote makes itself (merges, ticks, lands,
 * deletes), so they work on a machine with no git identity configured and are
 * recognisable in the log. Spread before the subcommand: `git(cwd, [...COMMIT_IDENTITY, 'commit', …])`.
 */
export const COMMIT_IDENTITY = [
  '-c',
  'user.name=claude-remote',
  '-c',
  'user.email=claude-remote@localhost',
];

export async function git(cwd: string, args: string[]): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('git', args, {
      cwd,
      windowsHide: true,
      maxBuffer: 16 * 1024 * 1024,
    });
    return stdout;
  } catch {
    return null;
  }
}

export async function isGitRepo(cwd: string): Promise<boolean> {
  const out = await git(cwd, ['rev-parse', '--is-inside-work-tree']);
  return out?.trim() === 'true';
}

// ---------------------------------------------------------------------------
// Headless generation
// ---------------------------------------------------------------------------

/**
 * Kill the spawned process tree. With shell:true the direct child is the shell
 * (cmd.exe on Windows); a plain kill() would leave the real `claude` grandchild
 * orphaned (and still burning quota), so on Windows we taskkill the whole tree.
 */
function killTree(child: ReturnType<typeof spawn>): void {
  if (process.platform === 'win32' && child.pid) {
    const killer = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true });
    killer.on('error', () => child.kill());
  } else {
    child.kill();
  }
}

export interface ClaudeRunResult {
  isError: boolean; // claude's own `is_error` flag
  result: string; // claude's final result text
  permissionDenials: number; // count of denied tool calls (out-of-scope attempts)
  /**
   * The Claude session id of this run, when the envelope reports one. Lets a
   * background pass be resumed interactively later ("take over"), which is the
   * escape hatch when a run needs a human decision.
   */
  sessionId: string | null;
}

/**
 * Parse the `--output-format json` envelope; tolerant of unexpected shapes.
 *
 * Usage is deliberately NOT read from here. The envelope arrives only when a
 * run completes (a killed run prints none), and on `--resume` it reports the
 * whole session's running total rather than this run's — so every figure
 * comes from the transcript ledger instead. See `docs/token-usage-feature.md`.
 */
export function parseClaudeResult(stdout: string): ClaudeRunResult {
  const empty: ClaudeRunResult = { isError: false, result: '', permissionDenials: 0, sessionId: null };
  if (!stdout.trim()) return empty;
  try {
    const j = JSON.parse(stdout) as {
      is_error?: unknown;
      result?: unknown;
      permission_denials?: unknown;
      session_id?: unknown;
    };
    return {
      isError: j.is_error === true,
      result: typeof j.result === 'string' ? j.result : '',
      permissionDenials: Array.isArray(j.permission_denials) ? j.permission_denials.length : 0,
      sessionId: typeof j.session_id === 'string' && j.session_id ? j.session_id : null,
    };
  } catch {
    return empty;
  }
}

export interface SpawnOptions {
  /** Tools the run may use. Defaults to the read + scoped-write set. */
  allowedTools?: string[];
  /** Override the run timeout; defaults to projectLog.timeoutMs. */
  timeoutMs?: number;
  /**
   * Called once the process actually starts, which is NOT when the run was
   * requested: it may have waited in its lane first. The timeout below is
   * armed here too, so queue time never counts against a stage's budget.
   */
  onSpawn?: () => void;
  /**
   * Continue this Claude session instead of starting a new one.
   *
   * The session is resolved from `cwd`, so it must be a session that ran in
   * this same worktree — which every stage of a job does.
   */
  resumeSessionId?: string;
  /**
   * Start a NEW session under this id (`--session-id`), so its transcript is
   * known before the process writes a line of it. Ignored with
   * `resumeSessionId`, which keeps the resumed session's id.
   */
  sessionId?: string;
  /**
   * Abort the run. Kills the child process tree if one is already running, and
   * skips spawning entirely if the run is still queued behind maxConcurrent —
   * which a registry of live child processes would miss.
   */
  signal?: AbortSignal;
}

export interface RunOptions extends SpawnOptions {
  /**
   * Treat any denied tool call as a hard failure. Default true.
   *
   * For the session-log generator a denial signals an attempted out-of-scope
   * WRITE, which is exactly the thing worth aborting over. For a read-only
   * pipeline stage it usually means the model reached for a shell command that
   * simply isn't in its allowlist, was refused, and carried on — the sandbox
   * working as designed. Stages that verify their own output contract set this
   * false and rely on the scope-revert below for file safety.
   */
  failOnDenial?: boolean;
  /**
   * What this run is for — its project, and job/stage for a pipeline stage.
   * The run is recorded under its session id BEFORE it spawns, which is what
   * lets the usage ledger attribute its transcript, a killed run's included.
   * Every caller passes one; an untagged run's spend reads as an interactive
   * session's.
   */
  tag?: RunTag;
  /**
   * The queue lane this run belongs to — the project, for a pipeline stage.
   * Runs in different lanes never wait for each other.
   */
  laneKey?: string;
}

const DEFAULT_TOOLS = ['Read', 'Glob', 'Grep', 'Edit', 'Write'];

/**
 * The built-in tools a run is given, derived from what it already allows.
 *
 * `--allowedTools` is a PERMISSION list: it decides what may be called, and
 * changes not a single token of the prompt. `--tools` decides which definitions
 * exist at all, and the difference is most of the prompt — the full built-in set
 * costs ~22.7k tokens per turn against ~4.5k for the six a stage uses, and a
 * stage re-reads that on every turn. The tools nobody here can call are the
 * expensive ones: Workflow alone is ~8.6k, PowerShell ~4k, Agent ~2.5k.
 *
 * Permission patterns (`Bash(git *)`) reduce to their tool name, and MCP tool
 * names are dropped: `--tools` names built-ins only.
 *
 * NOTE for whoever enables MCP for a stage (browser-driven QA is the likely
 * one): dropping `--strict-mcp-config` while `--tools` omits `ToolSearch` makes
 * every MCP tool load EAGERLY rather than deferred — measured at 134k prompt
 * tokens against 28k. Scope it with `--mcp-config` to the single server needed,
 * or keep `ToolSearch` in the set.
 */
export function builtinToolsFor(allowed: string[]): string[] {
  const names = allowed
    .map((t) => t.split('(')[0].trim())
    .filter((t) => t && !t.includes('__'));
  return [...new Set(names)];
}

/**
 * One headless `claude -p` invocation (no queue, no scope checks). Resolves with
 * the parsed result on a clean exit; rejects on non-zero exit / spawn error /
 * timeout.
 */
export function spawnClaude(
  cwd: string,
  prompt: string,
  options: SpawnOptions = {}
): Promise<ClaudeRunResult> {
  const cfg = getConfig().projectLog;
  const timeoutMs = options.timeoutMs ?? cfg.timeoutMs;
  const allowed = options.allowedTools ?? DEFAULT_TOOLS;
  const tools = allowed.join(',');
  const builtins = builtinToolsFor(allowed).join(',');

  return new Promise<ClaudeRunResult>((resolve, reject) => {
    // Nothing to kill yet, so an already-aborted signal must short-circuit before
    // the spawn rather than racing it.
    if (options.signal?.aborted) {
      reject(new RunAbortedError());
      return;
    }

    // Prompt is delivered via stdin (not argv) so shell quoting can't mangle it;
    // the static flag args are space-free, safe under shell:true (needed to
    // resolve `claude`/`claude.cmd` from PATH on Windows).
    const child = spawn(
      cfg.claudeCommand,
      [
        '-p',
        '--permission-mode',
        'acceptEdits',
        '--allowedTools',
        tools,
        // Which definitions exist at all — see builtinToolsFor above. This is
        // the single largest term in a run's prompt.
        '--tools',
        builtins,
        // Do not load the user's MCP servers. A stage's allowlist is file tools
        // only, so no MCP tool is callable from one — but without this every run
        // still starts every configured server and carries all of their tool
        // definitions in its prompt. Measured at ~7.3k tokens per run on this
        // machine, on top of the startup cost of each server process.
        '--strict-mcp-config',
        // Same argument for skills: a stage cannot invoke one, and the listing
        // is ~2.4k tokens of every prompt. Both flags pay off per TURN, because
        // the prefix is re-read on each one.
        '--disable-slash-commands',
        // Continuing the conversation that asked the question, rather than
        // starting one that has to rediscover the repository. See design.ts.
        ...(options.resumeSessionId ? ['--resume', options.resumeSessionId] : []),
        // A new session named up front, so the usage ledger can attribute its
        // transcript from the first line — before any envelope exists.
        ...(!options.resumeSessionId && options.sessionId ? ['--session-id', options.sessionId] : []),
        '--output-format',
        'json',
      ],
      { cwd, shell: true, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] }
    );

    // The run is now a real process. Until this point it was queued, and a
    // stage that reports itself as running while it waits is the reason a job
    // looks hung when it is merely behind something else.
    options.onSpawn?.();

    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
      fn();
    };

    // Same teardown as the timeout path — the only difference is who asked.
    const onAbort = () => {
      killTree(child);
      finish(() => reject(new RunAbortedError()));
    };
    options.signal?.addEventListener('abort', onAbort, { once: true });

    const timer = setTimeout(() => {
      killTree(child);
      finish(() => reject(new Error(`run timed out after ${formatDuration(timeoutMs)}`)));
    }, timeoutMs);

    child.stdout?.on('data', (d) => {
      stdout += String(d);
    });
    child.stderr?.on('data', (d) => {
      stderr += String(d);
    });
    child.on('error', (err) => finish(() => reject(err)));
    child.on('close', (code) => {
      if (code === 0) return finish(() => resolve(parseClaudeResult(stdout)));
      finish(() => reject(new Error(`claude exited with code ${code}: ${stderr.slice(0, 500)}`)));
    });

    // claude may close stdin before we finish writing (fast failure / auth
    // prompt). Without this listener the resulting EPIPE becomes an
    // uncaughtException, which the server's handler turns into process.exit.
    child.stdin?.on('error', () => {});
    child.stdin?.end(prompt);
  });
}

// --- Post-run edit-scope enforcement --------------------------------------

export interface GitStatusEntry {
  path: string;
  untracked: boolean;
}

export async function gitStatusEntries(
  cwd: string,
  opts: { allUntracked?: boolean } = {}
): Promise<GitStatusEntry[] | null> {
  // By default git collapses a new directory to one `?? dir/` entry. Callers
  // that match individual files (attribution, Delete track) need every file.
  const out = await git(cwd, [
    'status',
    '--porcelain',
    ...(opts.allUntracked ? ['--untracked-files=all'] : []),
  ]);
  if (out === null) return null; // not a git repo / git unavailable
  const entries: GitStatusEntry[] = [];
  for (const line of out.split('\n')) {
    if (!line.trim()) continue;
    const untracked = line.startsWith('??');
    let p = line.slice(3).trim();
    const arrow = p.indexOf(' -> '); // rename: keep the new path
    if (arrow !== -1) p = p.slice(arrow + 4);
    if (p.startsWith('"') && p.endsWith('"')) p = p.slice(1, -1); // git quotes odd paths
    entries.push({ path: p, untracked });
  }
  return entries;
}

function globToRegExp(glob: string): RegExp {
  let s = glob.replace(/\\/g, '/').replace(/[.+^${}()|[\]]/g, '\\$&');
  // `**/` => zero or more dir segments; `**` => anything; `*` => within-segment.
  s = s
    .replace(/\*\*\//g, 'GS_SLASH')
    .replace(/\*\*/g, 'GS_ANY')
    .replace(/\*/g, '[^/]*')
    .replace(/\?/g, '[^/]')
    .replace(/GS_SLASH/g, '(?:[^/]+/)*')
    .replace(/GS_ANY/g, '.*');
  return new RegExp(`^${s}$`, 'i');
}

export function isAllowedPath(relPath: string, allowedGlobs: string[]): boolean {
  const norm = relPath.replace(/\\/g, '/');
  return allowedGlobs.some((g) => globToRegExp(g).test(norm));
}

/**
 * Revert files the run changed outside `allowedGlobs`. `preEntries` are the
 * paths already dirty before the run (left untouched — they predate it).
 * Returns the list reverted. No-op for non-git projects (preEntries === null).
 */
export async function revertOutOfScope(
  cwd: string,
  preEntries: GitStatusEntry[] | null,
  allowedGlobs: string[]
): Promise<string[]> {
  if (preEntries === null) return [];
  const prePaths = new Set(preEntries.map((e) => e.path));
  const post = await gitStatusEntries(cwd);
  if (post === null) return [];
  const reverted: string[] = [];
  for (const { path: rel, untracked } of post) {
    if (prePaths.has(rel)) continue; // predates the run
    if (isAllowedPath(rel, allowedGlobs)) continue; // in scope
    try {
      if (untracked) unlinkSync(join(cwd, rel));
      else await git(cwd, ['checkout', '--', rel]);
      reverted.push(rel);
    } catch {
      reverted.push(`${rel} (revert failed)`);
    }
  }
  return reverted;
}

/**
 * Queued `claude -p` run with two safety layers:
 *  - hard-fail if claude reports an error or any denied tool call, and
 *  - revert any file the run touched outside `allowedGlobs` (git projects).
 */
export async function runClaude(
  cwd: string,
  prompt: string,
  allowedGlobs: string[],
  options: RunOptions = {}
): Promise<ClaudeRunResult> {
  const failOnDenial = options.failOnDenial !== false;
  return runQueued(async () => {
    // A run can sit in the queue for as long as the runs ahead of it take, which
    // is exactly when a cancel is most likely to land. Checking here means such a
    // run is dropped without ever touching the working tree.
    if (options.signal?.aborted) throw new RunAbortedError();
    const preEntries = await gitStatusEntries(cwd);

    // Name the session and record the run before the process exists: a run
    // killed a second in has already written transcript lines, and they are
    // only attributable if this row is there when the ledger reads them. A
    // resumed run keeps its session's id; the run window tells it apart.
    const sessionId = options.resumeSessionId ?? randomUUID();
    const runId = options.tag ? recordRunStart(sessionId, options.tag) : null;
    let result: ClaudeRunResult;
    try {
      result = await spawnClaude(cwd, prompt, { ...options, sessionId });
    } finally {
      recordRunEnd(runId);
      emitRunSettled();
    }
    if (result.isError || (failOnDenial && result.permissionDenials > 0)) {
      throw new Error(
        `claude run rejected (isError=${result.isError}, permissionDenials=${result.permissionDenials})` +
          (result.result ? `: ${result.result.slice(0, 200)}` : '')
      );
    }
    if (result.permissionDenials > 0) {
      // Still worth surfacing: a run repeatedly reaching for a tool it lacks may
      // mean the stage's allowlist is wrong, even when the output was fine.
      logger.warn(
        { cwd, denials: result.permissionDenials },
        'claude-run: tool calls were denied by the allowlist'
      );
    }
    const reverted = await revertOutOfScope(cwd, preEntries, allowedGlobs);
    if (reverted.length > 0) {
      logger.warn({ cwd, reverted }, 'claude-run: reverted out-of-scope edits made by the run');
    }
    return result;
  }, options.laneKey);
}
