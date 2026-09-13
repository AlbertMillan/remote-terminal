import { createLogger } from '../../utils/logger.js';
import { git } from '../../agent/claude-run.js';
import { diffStat } from '../worktree.js';

const logger = createLogger('stage-integrate');

/**
 * Integrate stage: rebase the job branch onto the current base.
 *
 * Without this, what you review at the merge gate is the job's work against the
 * base as it stood when the job started — which may be hours or days stale. The
 * point is that approving a diff approves what will actually land.
 *
 * Conflicts are NOT resolved automatically. A rebase conflict means two changes
 * disagree about the same lines, and guessing which wins is exactly the class of
 * decision that should reach a human.
 */

export type IntegrateOutcome = 'rebased' | 'already-current' | 'conflict';

export interface IntegrateResult {
  outcome: IntegrateOutcome;
  /** Files left conflicted, when the rebase could not complete. */
  conflicts: string[];
  stat: { files: number; insertions: number; deletions: number };
  detail: string | null;
}

/** Commits on the base that the job branch does not have yet. */
async function behindBy(worktreePath: string, baseBranch: string): Promise<number> {
  const out = await git(worktreePath, ['rev-list', '--count', `HEAD..${baseBranch}`]);
  const n = Number((out || '').trim());
  return Number.isFinite(n) ? n : 0;
}

/** Paths git reports as unmerged during a stopped rebase. */
async function conflictedPaths(worktreePath: string): Promise<string[]> {
  const out = await git(worktreePath, ['diff', '--name-only', '--diff-filter=U']);
  return (out || '')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
}

export async function runIntegrateStage(opts: {
  worktreePath: string;
  baseBranch: string;
}): Promise<IntegrateResult> {
  const { worktreePath, baseBranch } = opts;

  const behind = await behindBy(worktreePath, baseBranch);
  if (behind === 0) {
    const stat = await diffStat(worktreePath, baseBranch);
    logger.info({ baseBranch }, 'integrate: already current');
    return { outcome: 'already-current', conflicts: [], stat, detail: null };
  }

  logger.info({ baseBranch, behind }, 'integrate: rebasing');
  const rebased = await git(worktreePath, ['rebase', baseBranch]);

  if (rebased === null) {
    const conflicts = await conflictedPaths(worktreePath);
    // Abort so the worktree is left in a usable state rather than mid-rebase:
    // a half-rebased tree is confusing to take over and impossible to review.
    await git(worktreePath, ['rebase', '--abort']);
    const stat = await diffStat(worktreePath, baseBranch);
    logger.warn({ baseBranch, conflicts }, 'integrate: rebase conflicted, aborted');
    return {
      outcome: 'conflict',
      conflicts,
      stat,
      detail:
        conflicts.length > 0
          ? `Rebase onto ${baseBranch} conflicts in: ${conflicts.join(', ')}`
          : `Rebase onto ${baseBranch} failed`,
    };
  }

  const stat = await diffStat(worktreePath, baseBranch);
  logger.info({ baseBranch, ...stat }, 'integrate: rebased');
  return { outcome: 'rebased', conflicts: [], stat, detail: null };
}
