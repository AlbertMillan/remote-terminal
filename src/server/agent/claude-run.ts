import { spawn, execFile } from 'child_process';
import { unlinkSync } from 'fs';
import { join } from 'path';
import { promisify } from 'util';
import { getConfig } from '../config.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('claude-run');
const execFileAsync = promisify(execFile);

/**
 * Shared machinery for running headless `claude -p` passes with enforced edit
 * scoping.
 *
 * Extracted from project-log.ts so the session-log generator, the PROJECT.md
 * migration, and the job pipeline all run through one hardened path rather than
 * three near-copies. The safety properties matter more than the convenience:
 * the prompt's "only modify X" rule is advisory, since --permission-mode
 * acceptEdits auto-approves writes and the CLI cannot path-restrict them. So
 * every run is bracketed by a working-tree diff that reverts anything touched
 * outside the allowed globs, turning prompt-only scoping into enforced scoping.
 */

// ---------------------------------------------------------------------------
// Concurrency queue — caps simultaneous `claude -p` runs at maxConcurrent.
// ---------------------------------------------------------------------------
let active = 0;
const pending: (() => void)[] = [];

export function runQueued<T>(task: () => Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const start = () => {
      active++;
      task()
        .then(resolve, reject)
        .finally(() => {
          active--;
          const next = pending.shift();
          if (next) next();
        });
    };
    if (active < Math.max(1, getConfig().projectLog.maxConcurrent)) {
      start();
    } else {
      pending.push(start);
    }
  });
}

/** Number of runs currently executing (for diagnostics and the job board). */
export function activeRunCount(): number {
  return active;
}

// ---------------------------------------------------------------------------
// Git helpers (read-only). All non-throwing — absence of git is a valid state.
// ---------------------------------------------------------------------------
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

/**
 * What one run consumed, as the envelope reports it.
 *
 * Deliberately a flat, provider-neutral shape rather than the raw `usage`
 * object: the CLI's envelope carries a dozen fields that change between
 * versions, and everything downstream only needs these five.
 */
export interface RunUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  /** `total_cost_usd` — API list price for the tokens, not a subscription charge. */
  costUsd: number;
}

export const NO_USAGE: RunUsage = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheCreationTokens: 0,
  costUsd: 0,
};

/** Called with each completed run's usage, for callers that account for spend. */
export type UsageSink = (usage: RunUsage) => void;

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
  /** Tokens and list-price cost this run reported; zeros when it reported none. */
  usage: RunUsage;
}

/** Finite numbers only — a missing or malformed field reads as zero, never NaN. */
function num(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

/**
 * Pull usage out of the envelope.
 *
 * `modelUsage` is the source of truth, not the top-level `usage` block: on a
 * multi-turn run — which every pipeline stage is — `usage` reports only the
 * final turn's input, while `modelUsage` accumulates the whole run. A measured
 * two-turn run reported usage.input_tokens=19 against modelUsage 967, so
 * reading `usage` would under-report input by an order of magnitude. The
 * top-level block is kept only as the fallback for a shape that lacks
 * modelUsage.
 *
 * Tolerant by design throughout: a CLI version that renames or drops these
 * keys must degrade to zeros, not break the pipeline that merely reports them.
 */
function parseUsage(envelope: {
  usage?: unknown;
  modelUsage?: unknown;
  total_cost_usd?: unknown;
}): RunUsage {
  const perModel = Object.values((envelope.modelUsage ?? {}) as Record<string, unknown>).filter(
    (m): m is Record<string, unknown> => !!m && typeof m === 'object'
  );

  const totalled = perModel.reduce<RunUsage>(
    (acc, m) => ({
      inputTokens: acc.inputTokens + num(m.inputTokens),
      outputTokens: acc.outputTokens + num(m.outputTokens),
      cacheReadTokens: acc.cacheReadTokens + num(m.cacheReadInputTokens),
      cacheCreationTokens: acc.cacheCreationTokens + num(m.cacheCreationInputTokens),
      // Falls back to the per-model costs when the envelope omits the total.
      costUsd: acc.costUsd + num(m.costUSD),
    }),
    { ...NO_USAGE }
  );

  const u = (envelope.usage ?? {}) as Record<string, unknown>;
  const fallback: RunUsage = {
    inputTokens: num(u.input_tokens),
    outputTokens: num(u.output_tokens),
    cacheReadTokens: num(u.cache_read_input_tokens),
    cacheCreationTokens: num(u.cache_creation_input_tokens),
    costUsd: 0,
  };

  const tokens = perModel.length > 0 ? totalled : fallback;
  return {
    ...tokens,
    costUsd: num(envelope.total_cost_usd) || totalled.costUsd,
  };
}

/** Parse the `--output-format json` envelope; tolerant of unexpected shapes. */
export function parseClaudeResult(stdout: string): ClaudeRunResult {
  try {
    const j = JSON.parse(stdout) as {
      is_error?: unknown;
      result?: unknown;
      permission_denials?: unknown;
      session_id?: unknown;
      usage?: unknown;
      total_cost_usd?: unknown;
    };
    return {
      isError: j.is_error === true,
      result: typeof j.result === 'string' ? j.result : '',
      permissionDenials: Array.isArray(j.permission_denials) ? j.permission_denials.length : 0,
      sessionId: typeof j.session_id === 'string' && j.session_id ? j.session_id : null,
      usage: parseUsage(j),
    };
  } catch {
    return { isError: false, result: '', permissionDenials: 0, sessionId: null, usage: NO_USAGE };
  }
}

export interface SpawnOptions {
  /** Tools the run may use. Defaults to the read + scoped-write set. */
  allowedTools?: string[];
  /** Override the run timeout; defaults to projectLog.timeoutMs. */
  timeoutMs?: number;
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
   * Receives this run's usage as soon as the envelope is parsed — BEFORE the
   * error and denial checks below. A run that produced an envelope has already
   * spent its tokens whether or not we accept its output, so recording after
   * the checks would under-report exactly the runs worth knowing about: the
   * rejected ones.
   */
  onUsage?: UsageSink;
}

const DEFAULT_TOOLS = ['Read', 'Glob', 'Grep', 'Edit', 'Write'];

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
  const tools = (options.allowedTools ?? DEFAULT_TOOLS).join(',');

  return new Promise<ClaudeRunResult>((resolve, reject) => {
    // Prompt is delivered via stdin (not argv) so shell quoting can't mangle it;
    // the static flag args are space-free, safe under shell:true (needed to
    // resolve `claude`/`claude.cmd` from PATH on Windows).
    const child = spawn(
      cfg.claudeCommand,
      ['-p', '--permission-mode', 'acceptEdits', '--allowedTools', tools, '--output-format', 'json'],
      { cwd, shell: true, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] }
    );

    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };

    const timer = setTimeout(() => {
      killTree(child);
      finish(() => reject(new Error(`generation timed out after ${timeoutMs}ms`)));
    }, timeoutMs);

    child.stdout?.on('data', (d) => {
      stdout += String(d);
    });
    child.stderr?.on('data', (d) => {
      stderr += String(d);
    });
    child.on('error', (err) => finish(() => reject(err)));
    child.on('close', (code) => {
      if (code === 0) finish(() => resolve(parseClaudeResult(stdout)));
      else finish(() => reject(new Error(`claude exited with code ${code}: ${stderr.slice(0, 500)}`)));
    });

    // claude may close stdin before we finish writing (fast failure / auth
    // prompt). Without this listener the resulting EPIPE becomes an
    // uncaughtException, which the server's handler turns into process.exit.
    child.stdin?.on('error', () => {});
    child.stdin?.end(prompt);
  });
}

// --- Post-run edit-scope enforcement --------------------------------------

interface GitStatusEntry {
  path: string;
  untracked: boolean;
}

export async function gitStatusEntries(cwd: string): Promise<GitStatusEntry[] | null> {
  const out = await git(cwd, ['status', '--porcelain']);
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
    const preEntries = await gitStatusEntries(cwd);
    const result = await spawnClaude(cwd, prompt, options);
    if (options.onUsage) {
      // Accounting must never be able to fail a run.
      try {
        options.onUsage(result.usage);
      } catch (error) {
        logger.warn({ cwd, error }, 'claude-run: usage sink threw');
      }
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
  });
}
