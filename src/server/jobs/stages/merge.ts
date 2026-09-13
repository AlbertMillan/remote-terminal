import { createLogger } from '../../utils/logger.js';
import { git } from '../../agent/claude-run.js';
import { hasRemote } from '../worktree.js';

const logger = createLogger('stage-merge');

/**
 * Merge stage: land the approved work.
 *
 * Runs only after the merge gate, so by the time this executes the user has
 * seen the diff and said yes. From here it is autonomous: merge into the base,
 * push where there is a remote, and let the runner tear the worktree down.
 *
 * The merge happens in the PROJECT directory, not the worktree — a worktree
 * cannot check out the branch another worktree holds, and the base branch is
 * checked out in the project itself.
 */

export interface MergeResult {
  merged: boolean;
  pushed: boolean;
  /** Why the push did not happen, when it didn't. */
  pushSkippedReason: 'no-remote' | 'push-failed' | null;
  detail: string | null;
}

export async function runMergeStage(opts: {
  projectCwd: string;
  branch: string;
  baseBranch: string;
  title: string;
}): Promise<MergeResult> {
  const { projectCwd, branch, baseBranch, title } = opts;

  // Refuse to merge into a dirty tree: git would either refuse anyway or
  // entangle the user's uncommitted work with the job's merge commit.
  const status = await git(projectCwd, ['status', '--porcelain']);
  if (status === null) {
    throw new Error('Could not read the project repository state');
  }
  if (status.trim()) {
    throw new Error(
      'The project has uncommitted changes. Commit or stash them before merging this job.'
    );
  }

  const current = (await git(projectCwd, ['rev-parse', '--abbrev-ref', 'HEAD']))?.trim();
  if (current !== baseBranch) {
    throw new Error(
      `The project is on "${current}" but this job branched from "${baseBranch}". ` +
        `Switch back to ${baseBranch} before merging.`
    );
  }

  logger.info({ projectCwd, branch, baseBranch }, 'merge: merging job branch');
  const merged = await git(projectCwd, [
    '-c',
    'user.name=claude-remote',
    '-c',
    'user.email=claude-remote@localhost',
    'merge',
    '--no-ff',
    branch,
    '-m',
    `Merge job: ${title}`,
  ]);

  if (merged === null) {
    // Leave nothing half-merged behind.
    await git(projectCwd, ['merge', '--abort']);
    throw new Error(
      `Merging ${branch} into ${baseBranch} failed. Run the integrate stage again, or merge by hand.`
    );
  }

  if (!(await hasRemote(projectCwd))) {
    logger.info({ projectCwd }, 'merge: merged locally, no remote to push to');
    return {
      merged: true,
      pushed: false,
      pushSkippedReason: 'no-remote',
      detail: 'Merged locally. This project has no remote, so nothing was pushed.',
    };
  }

  const pushed = await git(projectCwd, ['push']);
  if (pushed === null) {
    logger.warn({ projectCwd, baseBranch }, 'merge: merged but push failed');
    return {
      merged: true,
      pushed: false,
      pushSkippedReason: 'push-failed',
      detail: `Merged into ${baseBranch}, but the push failed — push by hand.`,
    };
  }

  logger.info({ projectCwd, baseBranch }, 'merge: merged and pushed');
  return { merged: true, pushed: true, pushSkippedReason: null, detail: null };
}
