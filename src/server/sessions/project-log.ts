import { existsSync, readFileSync, statSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { getConfig } from '../config.js';
import { createLogger } from '../utils/logger.js';
import { stampSessionLogged } from '../db/queries.js';
import {
  tryGetTranscriptPath,
  readTranscript,
  transcriptHasEditsSince,
  countUserTurnsSince,
} from './transcript.js';
import {
  buildEntrySkeleton,
  entryBodyOnly,
  findEntryForSession,
} from './session-log-format.js';
import { git, isGitRepo, runClaude } from '../agent/claude-run.js';

const logger = createLogger('project-log');

// Re-exported so existing importers (and tests) keep their entry point while the
// implementation lives in the shared agent-run module.
export { isAllowedPath } from '../agent/claude-run.js';

// Bounds on how much git context we inline into the generation prompt.
const MAX_DIFF_CHARS = 12000;
const MAX_LOG_CHARS = 2000;
// Transcripts above this size are not handed to the model: reading them can
// exhaust the run's turn/context budget before it writes the log (an 8MB
// transcript routinely derails generation). Git context is used instead.
const MAX_TRANSCRIPT_BYTES = 1_000_000;

function fileSizeBytes(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

function fileMtimeMs(path: string): number {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return 0;
  }
}

/**
 * Did any currently-dirty file change during this session?
 *
 * `git status --porcelain` answers "is the tree dirty", which says nothing
 * about WHEN it became dirty — work left uncommitted last week keeps it true
 * forever. Checking each dirty file's mtime against the session start turns it
 * into a session-scoped signal, and it catches edits the transcript scan
 * misses (anything done through Bash rather than the Edit tool).
 */
export function anyDirtyFileTouchedSince(cwd: string, porcelain: string, sinceIso: string): boolean {
  const cutoff = Date.parse(sinceIso);
  if (Number.isNaN(cutoff)) return false;

  for (const line of porcelain.split('\n')) {
    if (!line.trim()) continue;
    let rel = line.slice(3).trim();
    const arrow = rel.indexOf(' -> '); // rename: the new path is the live one
    if (arrow !== -1) rel = rel.slice(arrow + 4);
    if (rel.startsWith('"') && rel.endsWith('"')) rel = rel.slice(1, -1);
    if (!rel) continue;

    // A deleted file has no mtime to read; git already told us it changed, but
    // not when, so it cannot count as evidence for this session.
    const mtime = fileMtimeMs(join(cwd, rel));
    if (mtime > 0 && mtime >= cutoff) return true;
  }
  return false;
}

export interface SessionLogContext {
  sessionId: string; // claude-remote session id (DB primary key)
  name: string;
  cwd: string;
  claudeSessionId: string;
  createdAt: string; // ISO timestamp of session creation
}

export type LogOutcome = 'generated' | 'skipped' | 'disabled' | 'error';

// ---------------------------------------------------------------------------
// Prompt
// ---------------------------------------------------------------------------

// Shared instruction for the normalized, grouped phases manifest. Real plans use
// many conventions (Phase N / M-N / SU-N / "✅ shipped" / status blockquotes /
// prose) and several parallel tracks per project, so the model interprets them
// into one consistent schema the dashboard renders.
function phasesInstruction(planGlobs: string[], currentSessionId: string | null): string {
  const attribution = currentSessionId
    ? `For items you advanced or completed in THIS session, add "${currentSessionId}" to their sessionIds (avoid duplicates). Preserve every id already present.`
    : `Best-effort attribute historical claude session ids: existing log-entry markers carry "claudeSessionId", and the transcripts show who did what — populate sessionIds when reasonably confident (an item may list several). Preserve every id already present.`;
  return `MAINTAIN THE PHASES MANIFEST (this powers the project dashboard — do it every run):
Use Glob to find this project's plan/design docs (patterns: ${planGlobs.join(', ')}) and read them.
Extract the development stages/phases. Docs differ: numbered "Phase N", "M1/M2" milestones,
"SU-N"/"DS-N" stages, "✅ shipped" suffixes, a status blockquote, or plain prose — interpret
each and normalize into this EXACT block, written once right AFTER the "# Session Log" header
and updated in place on later runs (never duplicate it):

<!-- claude-remote-phases
[
  { "group": "<track label>", "source": "<relative doc path>", "items": [
    { "id": "<e.g. Phase 1, M3, SU-2>", "title": "<short title>", "status": "done|in_progress|pending", "sessionIds": [] }
  ]}
]
-->

Rules:
- Keep each plan track / doc as its OWN group; NEVER merge different axes (don't mix "Phase 2"
  with "SU-2"). Preserve logical execution order within each track.
- status: "done" if the doc marks it shipped/complete; "in_progress" if started but not finished;
  else "pending". Be faithful to the doc's own signals.
- sessionIds: ${attribution}
- The block MUST be valid JSON.`;
}

/** Trailing git-context section shared by the per-session and backfill prompts. */
function gitContextBlock(log: string, diff: string): string {
  return `=== RECENT COMMITS ===
${log || '(none)'}

=== GIT DIFF (truncated) ===
${diff || '(no diff)'}`;
}

function buildPrompt(opts: {
  ctx: SessionLogContext;
  fileName: string;
  fileExists: boolean;
  branch: string;
  nowIso: string;
  diff: string;
  log: string;
  transcriptPath: string;
  transcriptLarge: boolean;
  editPlanFiles: boolean;
  planGlobs: string[];
  /** The entry this conversation already has, when it is being resumed. */
  existingEntry: string | null;
}): string {
  const { ctx, fileName, fileExists, branch, nowIso, diff, log, transcriptPath, transcriptLarge, editPlanFiles, planGlobs, existingEntry } = opts;

  // A very large transcript can exhaust the run before it writes the file, so
  // tell the model to skip it and lean on the git diff instead.
  const transcriptInstruction = transcriptLarge
    ? 'Read CLAUDE.md (if present) for project context. The session transcript is very large — do NOT read it; rely on the git diff below for what changed.'
    : `Read CLAUDE.md (if present) for project context, and the session transcript at ${transcriptPath} if you need to understand intent.`;

  const planInstruction = editPlanFiles
    ? `4. Find plan/design docs (glob patterns: ${planGlobs.join(', ')}) with Glob, and for objectives this session completed, tick their checkboxes ("- [ ]" -> "- [x]"). Only flip boxes you are confident are done.`
    : '4. Do not modify plan or design files.';

  const skeleton = buildEntrySkeleton({
    meta: { date: nowIso, session: ctx.name, branch, claudeSessionId: ctx.claudeSessionId, blockers: 0, openItems: 0 },
    headingDate: nowIso.slice(0, 10),
    headingTitle: ctx.name,
    hints: {
      done: '<ONE concise sentence on what THIS session changed — a delta, not a project summary>',
      changed: '<comma-separated key files/areas>',
      planProgress: '<completed objectives, or "n/a">',
      openNext: '<what remains, or "nothing pending">',
      blockers: '<blockers, or "none">',
    },
  });

  // A conversation gets ONE entry, amended as it continues. Resuming used to
  // append a second entry that mostly repeated the first; five consecutive
  // "nothing changed" entries for one conversation is what that produced.
  const writeInstruction = existingEntry
    ? `3. This conversation ALREADY has an entry in ${fileName}, shown below. UPDATE THAT ENTRY IN
   PLACE — do not add a second one, and do not move it. Keep its position in the file.
   Set the marker's "date" to ${nowIso}. Fold this session's work into the existing text so the
   entry describes the conversation as a whole: extend "Done" with what is genuinely new, and
   refresh "Plan progress", "Open / next" and "Blockers" to the CURRENT state.
   If this session changed nothing of substance, leave the entry's wording as it is and only
   update the marker date.

=== THE EXISTING ENTRY FOR THIS CONVERSATION (rewrite it in place) ===
${existingEntry}
=== END EXISTING ENTRY ===`
    : `3. Prepend ONE new entry to the top of ${fileName} at the project root${fileExists ? ' (the file already exists — keep all existing entries unchanged, newest first)' : ' (create the file with a short "# Session Log" header, then the entry)'}.`;

  return `You are recording what a development session accomplished, in a project changelog.

Project: ${ctx.cwd}
Branch: ${branch}
Date (use this exact value in the marker): ${nowIso}
Session name: ${ctx.name}
Claude session id: ${ctx.claudeSessionId}

Your job:
1. ${transcriptInstruction}
2. Use the git diff and recent commits below as the ground truth for what actually changed.
${writeInstruction}
${planInstruction}
5. ${phasesInstruction(planGlobs, ctx.claudeSessionId)}

STRICT CONSTRAINTS:
- Modify ONLY ${fileName}${editPlanFiles ? ' and the plan/design files you tick checkboxes in' : ''}. Touch no other file.
- Never rewrite, reorder, or delete entries belonging to OTHER conversations. You may only
  rewrite the one entry for claude session ${ctx.claudeSessionId}${existingEntry ? ' shown above' : ''}.
  (The phases manifest block IS updated in place.)
- Describe real work, not the act of looking: keep "Done" to a single sentence and each other
  field to one short line. Be factual; no speculation. Never pad an entry to look productive.

Use EXACTLY this entry format (fill the marker JSON's blockers/openItems with integer counts):

${skeleton}

${gitContextBlock(log, diff)}
`;
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
    let commitsDuringSession = false;
    let dirtyDuringSession = false;
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
      commitsDuringSession = Boolean(committed?.trim());
      // A dirty tree is only evidence about THIS session for the files it
      // actually touched. Treating any dirty file as evidence made the gate
      // permanently true once work sat uncommitted, which is what produced an
      // entry on every single close.
      dirtyDuringSession = anyDirtyFileTouchedSince(ctx.cwd, status || '', ctx.createdAt);
      log = (committed || '').slice(0, MAX_LOG_CHARS);
      branch = branchOut?.trim() || 'no-branch';
      diff = `${diffOut || ''}\n${diffCachedOut || ''}`.trim().slice(0, MAX_DIFF_CHARS);
    }

    // The transcript belongs to the CONVERSATION, not to this session: a
    // resumed one carries every turn it has ever had. Scan only this session's
    // slice, or a resume reports edits made days ago as its own.
    const transcript = readTranscript(transcriptPath);
    const hasEdits = transcriptHasEditsSince(transcript, ctx.createdAt);
    const userTurns = countUserTurnsSince(transcript, ctx.createdAt);

    // Skip-gate. Every signal is bounded to the session's own window, because
    // this gate is the ONLY relevance filter — nothing downstream can decline.
    // Non-git projects lose the commit signal, so they add a turn-count floor.
    const changedSomething = hasEdits || commitsDuringSession || dirtyDuringSession;
    const shouldLog = repo ? changedSomething : hasEdits && userTurns >= cfg.minTurnsToLog;

    if (!shouldLog) {
      logger.info(
        {
          sessionId: ctx.sessionId,
          repo,
          hasEdits,
          commitsDuringSession,
          dirtyDuringSession,
          userTurns,
        },
        'project-log: skip-gate skipped session'
      );
      stampSessionLogged(ctx.sessionId, new Date().toISOString());
      return 'skipped';
    }

    const fileName = cfg.fileName;
    const logPath = join(ctx.cwd, fileName);
    const fileExists = existsSync(logPath);
    const mtimeBefore = fileMtimeMs(logPath);

    // One entry per conversation: if this one already has an entry, the run
    // amends it rather than appending another. Enforces what the format has
    // always claimed about claudeSessionId being the idempotency key.
    const existing = fileExists
      ? findEntryForSession(readFileSync(logPath, 'utf-8'), ctx.claudeSessionId)
      : null;
    if (existing) {
      logger.info(
        { sessionId: ctx.sessionId, claudeSessionId: ctx.claudeSessionId },
        'project-log: amending the existing entry for this conversation'
      );
    }

    const prompt = buildPrompt({
      ctx,
      fileName,
      fileExists,
      branch,
      nowIso: new Date().toISOString(),
      diff,
      log,
      transcriptPath,
      transcriptLarge: fileSizeBytes(transcriptPath) > MAX_TRANSCRIPT_BYTES,
      editPlanFiles: cfg.editPlanFiles,
      planGlobs: cfg.planGlobs,
      existingEntry: existing ? entryBodyOnly(existing.entry) : null,
    });

    logger.info({ sessionId: ctx.sessionId, cwd: ctx.cwd }, 'project-log: generating entry');
    // Edits allowed only to the log file (+ plan files when checkbox-ticking is on).
    const allowedWrites = cfg.editPlanFiles ? [fileName, ...cfg.planGlobs] : [fileName];
    await runClaude(ctx.cwd, prompt, allowedWrites, { tag: { projectCwd: ctx.cwd, kind: 'session-log' } });

    // Verify the run actually wrote the log. A run can exit 0 without writing
    // (e.g. it got derailed), so don't report success or stamp on a no-write —
    // leaving logged_at unset lets the startup sweep retry it later.
    if (!(existsSync(logPath) && fileMtimeMs(logPath) > mtimeBefore)) {
      logger.warn({ sessionId: ctx.sessionId, cwd: ctx.cwd }, 'project-log: run completed but no entry was written');
      return 'error';
    }
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
  planGlobs: string[];
}): string {
  const { cwd, fileName, branch, nowIso, diff, log, transcriptPaths, planGlobs } = opts;
  const transcripts = transcriptPaths.length
    ? transcriptPaths.map((p) => `  - ${p}`).join('\n')
    : '  (none small enough to read — rely on git context)';

  const skeleton = buildEntrySkeleton({
    meta: { date: nowIso, session: '(backfill)', branch, claudeSessionId: 'backfill', blockers: 0, openItems: 0 },
    headingDate: nowIso.slice(0, 10),
    headingTitle: '(backfill)',
    hints: {
      done: '<what the project currently provides / major features built>',
      changed: '<key areas/modules of the codebase>',
      planProgress: '<completed vs outstanding objectives if a plan exists, else "n/a">',
      openNext: '<what appears in progress or unfinished>',
      blockers: '<known blockers, or "none">',
    },
  });

  return `You are seeding a project changelog for a project that has no ${fileName} yet.
Write ONE summary entry capturing the CURRENT STATE of the project — what has been
built so far and what appears in progress — by collapsing its whole history.

Project: ${cwd}
Branch: ${branch}
Date (use this exact value in the marker): ${nowIso}

How to gather context:
1. Read CLAUDE.md and any README for what the project is.
2. Use the recent commit history and uncommitted diff below as ground truth for what exists.
3. Optionally skim a transcript or two below for recent direction — but the git
   context above is sufficient; prioritise writing the file over reading these.
${transcripts}

Then create ${fileName} at the project root with a "# Session Log" header followed by
ONE entry in EXACTLY this format (fill the marker JSON's blockers/openItems with integer counts):

${skeleton}

${phasesInstruction(planGlobs, null)}

STRICT CONSTRAINTS:
- Create/modify ONLY ${fileName}. Touch no other file.
- Be factual and concise. This is a current-state snapshot, not per-session detail.

${gitContextBlock(log, diff)}
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
    const logPath = join(cwd, cfg.fileName);
    if (existsSync(logPath)) {
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

    // Drop oversized transcripts — handing the model an 8MB file derails the run.
    const usableTranscripts = transcriptPaths
      .filter((p) => {
        const size = fileSizeBytes(p);
        return size > 0 && size <= MAX_TRANSCRIPT_BYTES;
      })
      .slice(0, 5);

    const prompt = buildBackfillPrompt({
      cwd,
      fileName: cfg.fileName,
      branch,
      nowIso: new Date().toISOString(),
      diff,
      log,
      transcriptPaths: usableTranscripts,
      planGlobs: cfg.planGlobs,
    });

    logger.info({ cwd }, 'project-log: backfilling project');
    await runClaude(cwd, prompt, [cfg.fileName], { tag: { projectCwd: cwd, kind: 'session-log' } });

    // A run can exit 0 without writing the file (derailed); report error so the
    // dashboard surfaces it instead of silently flipping to "done".
    if (!existsSync(logPath)) {
      logger.warn({ cwd }, 'project-log: backfill run completed but no log was written');
      return 'error';
    }
    logger.info({ cwd }, 'project-log: backfill generated');
    return 'generated';
  } catch (err) {
    logger.warn({ cwd, err: err instanceof Error ? err.message : err }, 'project-log: backfill failed');
    return 'error';
  }
}

// ---------------------------------------------------------------------------
// Re-sync — refresh ONLY the phases manifest from the current plan docs, without
// adding a session entry. For when the plan changed but no session has closed.
// ---------------------------------------------------------------------------
function buildResyncPrompt(cwd: string, fileName: string, planGlobs: string[]): string {
  return `You are RE-SYNCING the plan-phases manifest in an existing ${fileName} at ${cwd}.
Your ONLY job is to update the phases manifest block to reflect the CURRENT plan docs.
Do NOT add, edit, reorder, or remove any dated log entries.

${phasesInstruction(planGlobs, null)}

STRICT CONSTRAINTS:
- Modify ONLY the <!-- claude-remote-phases ... --> block inside ${fileName}. Touch no other file and no log entry.
- Preserve every existing sessionId; only add ids you can attribute with confidence.`;
}

/**
 * Re-derive the phases manifest from the current plan docs and update it in place.
 * User-initiated (dashboard "Re-sync"); requires an existing log. No session entry
 * is written. Never throws.
 */
export async function resyncProjectPhases(cwd: string): Promise<LogOutcome> {
  const cfg = getConfig().projectLog;
  try {
    const logPath = join(cwd, cfg.fileName);
    if (!existsSync(logPath)) {
      // Nothing to update — the project has no log yet; use Generate (backfill).
      return 'skipped';
    }
    logger.info({ cwd }, 'project-log: re-syncing phases');
    await runClaude(cwd, buildResyncPrompt(cwd, cfg.fileName, cfg.planGlobs), [cfg.fileName], {
      tag: { projectCwd: cwd, kind: 'session-log' },
    });
    // A no-op re-sync (already current) is still success; just confirm the file survived.
    if (!existsSync(logPath)) {
      logger.warn({ cwd }, 'project-log: re-sync left no log file');
      return 'error';
    }
    logger.info({ cwd }, 'project-log: phases re-synced');
    return 'generated';
  } catch (err) {
    logger.warn({ cwd, err: err instanceof Error ? err.message : err }, 'project-log: re-sync failed');
    return 'error';
  }
}
