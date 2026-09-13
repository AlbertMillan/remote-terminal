import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { createLogger } from '../../utils/logger.js';
import { getConfig } from '../../config.js';
import { runClaude, type UsageSink } from '../../agent/claude-run.js';
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

function buildImplementPrompt(opts: { job: Job; specPath: string; spec: string }): string {
  const { job, specPath, spec } = opts;

  return `Implement the feature described by the approved spec below. The spec has
already been reviewed and approved — follow it rather than redesigning it.

Feature: ${job.title}
Spec file: ${specPath}

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
export async function runImplementStage(opts: {
  job: Job;
  worktreePath: string;
  specPath: string;
  baseBranch: string;
  onUsage?: UsageSink;
}): Promise<ImplementResult> {
  const { job, worktreePath, specPath, baseBranch, onUsage } = opts;

  const specAbs = join(worktreePath, specPath);
  if (!existsSync(specAbs)) {
    throw new Error(`The approved spec is missing at ${specPath}`);
  }
  const spec = readFileSync(specAbs, 'utf-8');

  const prompt = buildImplementPrompt({ job, specPath, spec });

  logger.info({ jobId: job.id }, 'implement: running');
  // Bash is granted here so the run can actually execute the tests it writes.
  // `['**']` allows the whole worktree; the revert guard still catches writes
  // that escape it entirely.
  const result = await runClaude(worktreePath, prompt, ['**'], {
    allowedTools: ['Read', 'Glob', 'Grep', 'Edit', 'Write', 'Bash'],
    timeoutMs: getConfig().projectLog.timeoutMs,
    failOnDenial: false,
    onUsage,
  });

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
