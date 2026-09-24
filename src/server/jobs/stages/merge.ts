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
 * The merge happens where the base branch is checked out — a worktree cannot
 * check out the branch another worktree holds. That is the PROJECT directory
 * for main, and the track's worktree for a job inside a branched track
 * (`mergeCwd`). Track branches are local, so those merges never push.
 */

export interface MergeResult {
  merged: boolean;
  pushed: boolean;
  /** Why the push did not happen, when it didn't. */
  pushSkippedReason: 'no-remote' | 'push-failed' | 'track-branch' | null;
  detail: string | null;
  /** The merge commit, so deleting the track later can revert exactly it. */
  mergeSha: string | null;
}

export async function runMergeStage(opts: {
  projectCwd: string;
  branch: string;
  baseBranch: string;
  title: string;
  /** Where `baseBranch` is checked out, when not the project itself. */
  mergeCwd?: string;
}): Promise<MergeResult> {
  const { branch, baseBranch, title } = opts;
  const projectCwd = opts.mergeCwd || opts.projectCwd;
  const intoTrack = Boolean(opts.mergeCwd);

  // Refuse to merge into a dirty tree: git would either refuse anyway or
  // entangle the user's uncommitted work with the job's merge commit.
  const status = await git(projectCwd, ['status', '--porcelain']);
  if (status === null) {
    throw new Error('Could not read the project repository state');
  }
  if (status.trim()) {
    throw new Error(
      intoTrack
        ? `The track worktree has uncommitted changes (${projectCwd}). Commit them in the track's session before merging this job.`
        : 'The project has uncommitted changes. Commit or stash them before merging this job.'
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

  const mergeSha = (await git(projectCwd, ['rev-parse', 'HEAD']))?.trim() || null;

  if (intoTrack) {
    logger.info({ projectCwd, baseBranch, mergeSha }, 'merge: merged into the track branch');
    return {
      merged: true,
      pushed: false,
      pushSkippedReason: 'track-branch',
      detail: `Merged into the track branch ${baseBranch}. Land the track to bring it to main.`,
      mergeSha,
    };
  }

  if (!(await hasRemote(projectCwd))) {
    logger.info({ projectCwd }, 'merge: merged locally, no remote to push to');
    return {
      merged: true,
      pushed: false,
      pushSkippedReason: 'no-remote',
      detail: 'Merged locally. This project has no remote, so nothing was pushed.',
      mergeSha,
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
      mergeSha,
    };
  }

  logger.info({ projectCwd, baseBranch }, 'merge: merged and pushed');
  return { merged: true, pushed: true, pushSkippedReason: null, detail: null, mergeSha };
}
