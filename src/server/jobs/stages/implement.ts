import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { createLogger } from '../../utils/logger.js';
import { getConfig } from '../../config.js';
import { RunAbortedError, runClaude, type UsageSink } from '../../agent/claude-run.js';
import { COMPANION_DIR } from '../../projects/project-store.js';
import { commitAll, diffStat } from '../worktree.js';
import type { Job } from '../types.js';

const logger = createLogger('stage-implement');

/**
 * Implement stage: build what the approved spec describes.
 *
 * The spec has already been through gate 1, so this stage's job is fidelity,
 * not invention. It gets Bash — unlike design — because writing code without
 * being able to run the tests you just wrote produces code nobody should trust.
 */

export interface ImplementResult {
  claudeSessionId: string | null;
  /** Files changed against the base, for the board. */
  stat: { files: number; insertions: number; deletions: number };
  /** Set when the run stopped for a decision rather than finishing. */
  openQuestion: string | null;
}

/** Marker the stage writes when it cannot proceed without a decision. */
export const BLOCKED_MARKER = '## Blocked';

function buildImplementPrompt(opts: {
  job: Job;
  specPath: string;
  spec: string;
  answer?: string | null;
}): string {
  const { job, specPath, spec, answer = null } = opts;

  // Only reached when the session that asked could not be resumed; the answer
  // must still arrive, or the stage re-runs into the wall it stopped at.
  const answered = answer
    ? `
A previous attempt stopped on a question, and the user answered it:

"${answer}"

Act on that answer, and remove the "${BLOCKED_MARKER}" block from the spec.
`
    : '';

  return `Implement the feature described by the approved spec below. The spec has
already been reviewed and approved — follow it rather than redesigning it.

Feature: ${job.title}
Spec file: ${specPath}
${answered}
=== APPROVED SPEC ===
${spec}
=== END SPEC ===

WHAT TO DO
1. Make the changes listed under "Planned changes". Match the surrounding code's
   conventions, naming and comment density — the result should read as though
   the people who wrote this repo wrote it.
2. Write the tests the "Verification" section calls for, and RUN them. Use the
   project's own test command. A stage that reports success without having run
   anything is worse than one that reports failure.
3. Run the project's lint/typecheck if it has one, and fix what you broke.
4. Stay inside "Out of scope". Do not refactor adjacent code, do not add
   features the spec does not ask for, and do not upgrade dependencies.

IF THE SPEC TURNS OUT TO BE WRONG
If implementing reveals the spec is unworkable — it contradicts the code, or a
planned change is impossible — do NOT improvise a different design. Append this
section to ${specPath} and stop:

${BLOCKED_MARKER}
- <what you found, and the options as you see them>

Do this only for something that genuinely invalidates the approved plan. A
detail the spec left unspecified is yours to decide sensibly and note in your
summary.

CONSTRAINTS
- Do not commit. The pipeline handles commits.
- Do not modify ${COMPANION_DIR}/ files other than appending the block above.
- Report at the end: what you changed, what you ran, and the result.`;
}

/**
 * Run the implement pass in the job's worktree.
 *
 * Write scope is the whole worktree: this stage is supposed to change source.
 * Isolation comes from the worktree itself rather than from path globs — the
 * user's real tree is a different directory on a different branch.
 */
/**
 * The follow-up sent to a RESUMED implement session.
 *
 * The run parked because the approved spec did not hold, and wrote what it
 * found into the spec. It already has the codebase in context, so this carries
 * only the decision it was waiting on.
 */
function buildAnswerPrompt(answer: string): string {
  return `The user has answered the question you stopped on:

"${answer}"

Carry on from there: make the changes, run the tests and the project's lint or
typecheck, and stay inside the approved spec's "Out of scope". Remove the
"${BLOCKED_MARKER}" block you appended. Stop again only if this answer turns
out not to resolve it.`;
}

export async function runImplementStage(opts: {
  job: Job;
  worktreePath: string;
  specPath: string;
  baseBranch: string;
  /** The user's answer to the question this stage parked on, if any. */
  answer?: string | null;
  /** The session that asked it, continued rather than replaced. */
  resumeSessionId?: string | null;
  onUsage?: UsageSink;
  /** Aborts the underlying claude run when the job is cancelled. */
  signal?: AbortSignal;
  /** Queue lane and spawn notification; see runner.ts. */
  laneKey?: string;
  onSpawn?: () => void;
}): Promise<ImplementResult> {
  const {
    job,
    worktreePath,
    specPath,
    baseBranch,
    answer = null,
    resumeSessionId = null,
    onUsage,
    signal,
    laneKey,
    onSpawn,
  } = opts;

  const specAbs = join(worktreePath, specPath);
  if (!existsSync(specAbs)) {
    throw new Error(`The approved spec is missing at ${specPath}`);
  }
  const spec = readFileSync(specAbs, 'utf-8');

  const canResume = Boolean(answer && resumeSessionId);
  // Without a session to continue, the answer still has to reach the run: it
  // was previously recorded on the job and then read by nobody, so answering an
  // implement question re-ran the identical prompt into the same wall.
  const fullPrompt = () => buildImplementPrompt({ job, specPath, spec, answer });

  logger.info({ jobId: job.id, resumed: canResume }, 'implement: running');
  // Bash is granted here so the run can actually execute the tests it writes.
  // `['**']` allows the whole worktree; the revert guard still catches writes
  // that escape it entirely.
  const runOptions = {
    allowedTools: ['Read', 'Glob', 'Grep', 'Edit', 'Write', 'Bash'],
    timeoutMs: getConfig().jobs.stageTimeoutMs,
    signal,
    failOnDenial: false,
    onUsage,
    laneKey,
    onSpawn,
  };

  let result;
  if (canResume) {
    try {
      result = await runClaude(worktreePath, buildAnswerPrompt(answer as string), ['**'], {
        ...runOptions,
        resumeSessionId: resumeSessionId as string,
      });
    } catch (error) {
      if (error instanceof RunAbortedError) throw error;
      logger.warn(
        { jobId: job.id, error: (error as Error).message },
        'implement: resume failed, re-running the stage from scratch'
      );
      result = await runClaude(worktreePath, fullPrompt(), ['**'], runOptions);
    }
  } else {
    result = await runClaude(worktreePath, fullPrompt(), ['**'], runOptions);
  }

  const updatedSpec = existsSync(specAbs) ? readFileSync(specAbs, 'utf-8') : spec;
  const openQuestion = extractBlocked(updatedSpec);

  await commitAll(worktreePath, `implement: ${job.title}`);
  const stat = await diffStat(worktreePath, baseBranch);

  logger.info({ jobId: job.id, ...stat, blocked: !!openQuestion }, 'implement: finished');
  return { claudeSessionId: result.sessionId, stat, openQuestion };
}

/** Pull the blocked note out of a spec, or null when implementation proceeded. */
export function extractBlocked(spec: string): string | null {
  const index = spec.indexOf(BLOCKED_MARKER);
  if (index === -1) return null;
  const after = spec.slice(index + BLOCKED_MARKER.length);
  const end = after.search(/\n#{1,2}\s/);
  const body = (end === -1 ? after : after.slice(0, end)).trim();
  return body || null;
}
