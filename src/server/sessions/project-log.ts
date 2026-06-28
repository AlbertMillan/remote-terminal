import { spawn, execFile } from 'child_process';
import { existsSync, readFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { promisify } from 'util';
import { getConfig } from '../config.js';
import { createLogger } from '../utils/logger.js';
import { stampSessionLogged } from '../db/queries.js';
import { tryGetTranscriptPath } from './transcript.js';

const logger = createLogger('project-log');
const execFileAsync = promisify(execFile);

// Bounds on how much git context we inline into the generation prompt.
const MAX_DIFF_CHARS = 12000;
const MAX_LOG_CHARS = 2000;
const EDIT_TOOL_RE = /"name"\s*:\s*"(Edit|Write|MultiEdit|NotebookEdit)"/;

export interface SessionLogContext {
  sessionId: string; // claude-remote session id (DB primary key)
  name: string;
  cwd: string;
  claudeSessionId: string;
  createdAt: string; // ISO timestamp of session creation
}

export type LogOutcome = 'generated' | 'skipped' | 'disabled' | 'error';

// ---------------------------------------------------------------------------
// Concurrency queue — caps simultaneous `claude -p` runs at maxConcurrent.
// ---------------------------------------------------------------------------
let active = 0;
const pending: (() => void)[] = [];

function runQueued<T>(task: () => Promise<T>): Promise<T> {
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

// ---------------------------------------------------------------------------
// Git helpers (read-only). All non-throwing — absence of git is a valid state.
// ---------------------------------------------------------------------------
async function git(cwd: string, args: string[]): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('git', args, { cwd, windowsHide: true, maxBuffer: 16 * 1024 * 1024 });
    return stdout;
  } catch {
    return null;
  }
}

async function isGitRepo(cwd: string): Promise<boolean> {
  const out = await git(cwd, ['rev-parse', '--is-inside-work-tree']);
  return out?.trim() === 'true';
}

// ---------------------------------------------------------------------------
// Skip-gate signals
// ---------------------------------------------------------------------------
function readTranscript(path: string): string {
  try {
    return readFileSync(path, 'utf-8');
  } catch {
    return '';
  }
}

function transcriptHasEdits(transcript: string): boolean {
  return EDIT_TOOL_RE.test(transcript);
}

function countUserTurns(transcript: string): number {
  let count = 0;
  const re = /"type"\s*:\s*"user"/g;
  while (re.exec(transcript)) count++;
  return count;
}

// ---------------------------------------------------------------------------
// Prompt
// ---------------------------------------------------------------------------
function buildPrompt(opts: {
  ctx: SessionLogContext;
  fileName: string;
  fileExists: boolean;
  branch: string;
  nowIso: string;
  diff: string;
  log: string;
  transcriptPath: string;
  editPlanFiles: boolean;
  planGlobs: string[];
}): string {
  const { ctx, fileName, fileExists, branch, nowIso, diff, log, transcriptPath, editPlanFiles, planGlobs } = opts;

  const planInstruction = editPlanFiles
    ? `4. Find plan/design docs (glob patterns: ${planGlobs.join(', ')}) with Glob, and for objectives this session completed, tick their checkboxes ("- [ ]" -> "- [x]"). Only flip boxes you are confident are done.`
    : '4. Do not modify plan or design files.';

  return `You are writing a single changelog entry for a development session that just ended.

Project: ${ctx.cwd}
Branch: ${branch}
Date (use this exact value in the marker): ${nowIso}
Session name: ${ctx.name}
Claude session id: ${ctx.claudeSessionId}

Your job:
1. Read CLAUDE.md (if present) for project context, and the session transcript at
   ${transcriptPath} if you need to understand intent (it may be large — skim it).
2. Use the git diff and recent commits below as the ground truth for what actually changed.
3. Prepend ONE new entry to the top of ${fileName} at the project root${fileExists ? ' (the file already exists — keep all existing entries unchanged, newest first)' : ' (create the file with a short "# Session Log" header, then the entry)'}.
${planInstruction}

STRICT CONSTRAINTS:
- Modify ONLY ${fileName}${editPlanFiles ? ' and the plan/design files you tick checkboxes in' : ''}. Touch no other file.
- Never rewrite, reorder, or delete existing log entries.
- Keep the entry concise and factual. No speculation.

Use EXACTLY this entry format (fill the marker JSON's blockers/openItems with integer counts):

<!-- claude-remote-log {"date":"${nowIso}","session":${JSON.stringify(ctx.name)},"branch":${JSON.stringify(branch)},"claudeSessionId":"${ctx.claudeSessionId}","blockers":0,"openItems":0} -->
## ${nowIso.slice(0, 10)} · ${ctx.name} · ${branch}
**Done:** <one or two sentences on what was accomplished>
**Changed:** <comma-separated key files/areas>
**Plan progress:** <completed objectives, or "n/a">
**Open / next:** <what remains, or "nothing pending">
**Blockers:** <blockers, or "none">

=== GIT DIFF (truncated) ===
${diff || '(no diff)'}

=== RECENT COMMITS ===
${log || '(none)'}
`;
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

function runClaude(cwd: string, prompt: string): Promise<void> {
  const cfg = getConfig().projectLog;
  return runQueued(
    () =>
      new Promise<void>((resolve, reject) => {
        // Prompt is delivered via stdin (not argv) so shell quoting can't mangle
        // it; the static flag args are space-free, safe under shell:true (needed
        // to resolve `claude`/`claude.cmd` from PATH on Windows).
        const child = spawn(
          cfg.claudeCommand,
          ['-p', '--permission-mode', 'acceptEdits', '--allowedTools', 'Read,Glob,Grep,Edit,Write', '--output-format', 'json'],
          { cwd, shell: true, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] }
        );

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
          finish(() => reject(new Error(`generation timed out after ${cfg.timeoutMs}ms`)));
        }, cfg.timeoutMs);

        child.stdout?.on('data', () => {});
        child.stderr?.on('data', (d) => {
          stderr += String(d);
        });
        child.on('error', (err) => finish(() => reject(err)));
        child.on('close', (code) => {
          if (code === 0) finish(() => resolve());
          else finish(() => reject(new Error(`claude exited with code ${code}: ${stderr.slice(0, 500)}`)));
        });

        // claude may close stdin before we finish writing (fast failure / auth
        // prompt). Without this listener the resulting EPIPE becomes an
        // uncaughtException, which the server's handler turns into process.exit.
        child.stdin?.on('error', () => {});
        child.stdin?.end(prompt);
      })
  );
}

/**
 * Evaluate a just-ended session and, if it shows evidence of real work, generate
 * a SESSION-LOG.md entry via a headless `claude -p` run. Stamps logged_at on skip
 * or success so it is never reprocessed; leaves it unset on error so the startup
 * sweep can retry. Fire-and-forget safe — never throws.
 */
export async function generateSessionLog(ctx: SessionLogContext): Promise<LogOutcome> {
  if (!getConfig().projectLog.enabled) return 'disabled';
  return generateSessionLogForced(ctx);
}

/**
 * Same as generateSessionLog but ignores the enabled flag. Intended for the
 * dev-only smoke-test endpoint so the pipeline can be exercised without flipping
 * the global config. Not wired into any automatic trigger.
 */
export async function generateSessionLogForced(ctx: SessionLogContext): Promise<LogOutcome> {
  const cfg = getConfig().projectLog;

  try {
    const transcriptPath = tryGetTranscriptPath(homedir(), ctx.cwd, ctx.claudeSessionId);
    if (!transcriptPath) {
      // No transcript on disk → nothing to summarize. Treat as handled.
      logger.info({ sessionId: ctx.sessionId }, 'project-log: no transcript found, skipping');
      stampSessionLogged(ctx.sessionId, new Date().toISOString());
      return 'skipped';
    }

    const repo = await isGitRepo(ctx.cwd);
    let gitChanges = false;
    let diff = '';
    let log = '';
    let branch = 'no-branch';

    if (repo) {
      const [status, committed, branchOut, diffOut, diffCachedOut] = await Promise.all([
        git(ctx.cwd, ['status', '--porcelain']),
        git(ctx.cwd, ['log', `--since=${ctx.createdAt}`, '--oneline']),
        git(ctx.cwd, ['rev-parse', '--abbrev-ref', 'HEAD']),
        git(ctx.cwd, ['diff']),
        git(ctx.cwd, ['diff', '--cached']),
      ]);
      gitChanges = Boolean(status?.trim()) || Boolean(committed?.trim());
      log = (committed || '').slice(0, MAX_LOG_CHARS);
      branch = branchOut?.trim() || 'no-branch';
      diff = `${diffOut || ''}\n${diffCachedOut || ''}`.trim().slice(0, MAX_DIFF_CHARS);
    }

    // Read the transcript only when git can't already decide — it can be many MB
    // and for a git repo with changes the edit-scan/turn-count are unused.
    let hasEdits = false;
    let userTurns = 0;
    if (!repo || !gitChanges) {
      const transcript = readTranscript(transcriptPath);
      hasEdits = transcriptHasEdits(transcript);
      userTurns = countUserTurns(transcript);
    }

    // Skip-gate: primary signal is evidence of change. For non-git projects we
    // fall back to edit tool-calls plus a turn-count floor (lower fidelity).
    const shouldLog = repo ? gitChanges || hasEdits : hasEdits && userTurns >= cfg.minTurnsToLog;

    if (!shouldLog) {
      logger.info({ sessionId: ctx.sessionId, repo, hasEdits, gitChanges, userTurns }, 'project-log: skip-gate skipped session');
      stampSessionLogged(ctx.sessionId, new Date().toISOString());
      return 'skipped';
    }

    const fileName = cfg.fileName;
    const fileExists = existsSync(join(ctx.cwd, fileName));
    const prompt = buildPrompt({
      ctx,
      fileName,
      fileExists,
      branch,
      nowIso: new Date().toISOString(),
      diff,
      log,
      transcriptPath,
      editPlanFiles: cfg.editPlanFiles,
      planGlobs: cfg.planGlobs,
    });

    logger.info({ sessionId: ctx.sessionId, cwd: ctx.cwd }, 'project-log: generating entry');
    await runClaude(ctx.cwd, prompt);
    stampSessionLogged(ctx.sessionId, new Date().toISOString());
    logger.info({ sessionId: ctx.sessionId }, 'project-log: entry generated');
    return 'generated';
  } catch (err) {
    // Leave logged_at unset so the startup sweep can retry.
    logger.warn({ sessionId: ctx.sessionId, err: err instanceof Error ? err.message : err }, 'project-log: generation failed');
    return 'error';
  }
}

// ---------------------------------------------------------------------------
// Backfill — seed a SESSION-LOG.md for an existing project with no log yet.
// Collapses the whole project history into one "state of the project" entry.
// ---------------------------------------------------------------------------
function buildBackfillPrompt(opts: {
  cwd: string;
  fileName: string;
  branch: string;
  nowIso: string;
  diff: string;
  log: string;
  transcriptPaths: string[];
}): string {
  const { cwd, fileName, branch, nowIso, diff, log, transcriptPaths } = opts;
  const transcripts = transcriptPaths.length
    ? transcriptPaths.map((p) => `  - ${p}`).join('\n')
    : '  (none on disk)';

  return `You are seeding a project changelog for a project that has no ${fileName} yet.
Write ONE summary entry capturing the CURRENT STATE of the project — what has been
built so far and what appears in progress — by collapsing its whole history.

Project: ${cwd}
Branch: ${branch}
Date (use this exact value in the marker): ${nowIso}

How to gather context:
1. Read CLAUDE.md and any README for what the project is.
2. Use the recent commit history and uncommitted diff below as ground truth for what exists.
3. The most recent session transcripts are listed below — skim a few (newest first)
   for intent and recent direction. They may be large.
${transcripts}

Then create ${fileName} at the project root with a "# Session Log" header followed by
ONE entry in EXACTLY this format (fill the marker JSON's blockers/openItems with integer counts):

<!-- claude-remote-log {"date":"${nowIso}","session":"(backfill)","branch":${JSON.stringify(branch)},"claudeSessionId":"backfill","blockers":0,"openItems":0} -->
## ${nowIso.slice(0, 10)} · (backfill) · ${branch}
**Done:** <what the project currently provides / major features built>
**Changed:** <key areas/modules of the codebase>
**Plan progress:** <completed vs outstanding objectives if a plan exists, else "n/a">
**Open / next:** <what appears in progress or unfinished>
**Blockers:** <known blockers, or "none">

STRICT CONSTRAINTS:
- Create/modify ONLY ${fileName}. Touch no other file.
- Be factual and concise. This is a current-state snapshot, not per-session detail.

=== RECENT COMMITS ===
${log || '(none)'}

=== UNCOMMITTED DIFF (truncated) ===
${diff || '(no diff)'}
`;
}

/**
 * Seed a whole-history SESSION-LOG.md for a project that doesn't have one. User-
 * initiated (via the backfill endpoint), so it runs regardless of the enabled
 * flag. No session row is involved, so nothing is stamped. Never throws.
 */
export async function generateProjectBackfill(opts: { cwd: string; transcriptPaths: string[] }): Promise<LogOutcome> {
  const cfg = getConfig().projectLog;
  const { cwd, transcriptPaths } = opts;

  try {
    if (existsSync(join(cwd, cfg.fileName))) {
      return 'skipped'; // already has a log
    }

    const repo = await isGitRepo(cwd);
    let diff = '';
    let log = '';
    let branch = 'no-branch';
    if (repo) {
      const [branchOut, logOut, diffOut] = await Promise.all([
        git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']),
        git(cwd, ['log', '-n', '40', '--oneline']),
        git(cwd, ['diff']),
      ]);
      branch = branchOut?.trim() || 'no-branch';
      log = (logOut || '').slice(0, MAX_LOG_CHARS);
      diff = (diffOut || '').slice(0, MAX_DIFF_CHARS);
    }

    const prompt = buildBackfillPrompt({
      cwd,
      fileName: cfg.fileName,
      branch,
      nowIso: new Date().toISOString(),
      diff,
      log,
      transcriptPaths: transcriptPaths.slice(0, 5),
    });

    logger.info({ cwd }, 'project-log: backfilling project');
    await runClaude(cwd, prompt);
    logger.info({ cwd }, 'project-log: backfill generated');
    return 'generated';
  } catch (err) {
    logger.warn({ cwd, err: err instanceof Error ? err.message : err }, 'project-log: backfill failed');
    return 'error';
  }
}
