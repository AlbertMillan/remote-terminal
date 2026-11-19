import { createLogger } from '../utils/logger.js';
import { COMMIT_IDENTITY, git, gitStatusEntries, hasRemote, offBranch, type GitStatusEntry } from '../utils/git.js';
import { deletePeerNotes } from '../sessions/prompt-file.js';
import { sessionsInWorktree } from '../utils/paths.js';
import { describeLinksLeft, removeWorktree } from '../jobs/worktree.js';
import { type RegistryProject } from './registry.js';
import { getActiveTrackBranch, markLanded, type TrackBranch } from './track-store.js';
import { isInstalling } from './project-deps.js';
import {
  commitWorktreePlanning,
  docRelOf,
  isPlanningPath,
  isSessionLogPath,
  mergeTrapAdvice,
  nameFiles,
  returnSectionToMain,
} from './track-plan.js';

const logger = createLogger('track-branches');
import { TrackBranchError, liveJobsOf, reattachIfMissing } from './track-branches.js';

/**
 * Land's git half (docs/track-branches.md): copy the section back to main, merge, reset the
 * branch's copy, mark the row landed. track-land.ts runs it under the project lock and rebuilds.
 */

// --- Land --------------------------------------------------------------

export interface LandResult {
  mergeSha: string;
  pushed: boolean;
  /** Feature ids in the section Land put back on main. */
  synced: string[];
  /** Running sessions in the worktree that Land closed before merging. */
  closedSessions: number;
  detail: string;
}

/** What Land needs from the session manager — injected, as Delete track's deps are. */
export interface LandDeps {
  /** Running sessions only (`getRunningSessions`): an exited shell holds nothing open. */
  sessions: { id: string; cwd: string }[];
  /** Must resolve only once the PTY is gone. */
  terminateSession: (id: string) => Promise<unknown>;
  /**
   * Delete every session row in the worktree (running or not) once it is
   * removed, and drop them from the sidebar (`removeWorktreeSessions`).
   */
  removeSessions: (worktreePath: string) => Promise<unknown>;
}

/**
 * Land a track: put its plan back on main, merge its branch into the base
 * once, then retire the worktree.
 *
 * Refused unless every job for the track has finished, no install is running
 * in the worktree, the project is on the base branch, and the checkouts hold
 * nothing Land can't account for:
 *  - the worktree: uncommitted planning files are committed there first
 *    (it belongs to this track and never pushes); anything else refuses;
 *  - main: uncommitted planning files (backlog edits) and the session log
 *    (worktree sessions are logged into main's copy) are let through and
 *    left uncommitted; anything else refuses, since code edited on main may
 *    be this track's work. Nothing may be STAGED: git refuses to merge then.
 * Every refusal names the files.
 *
 * Once nothing refuses, Land closes the sessions running inside the worktree
 * itself, awaiting each (on Windows an open shell holds the directory and
 * `git worktree remove` fails half-way).
 *
 * PROJECT.md never goes through the merge. The branch's copy is reset to its
 * merge-base first, and the section is copied onto main by its own commit
 * (returnSectionToMain), so the merge cannot conflict on the file every track
 * touches.
 */
export async function landTrack(
  project: RegistryProject,
  trackName: string,
  deps: LandDeps
): Promise<LandResult> {
  const { track, mainEntries } = await landPreflight(project, trackName);
  const docRel = docRelOf(project);

  // Every refusal is behind us, so closing now never kills a session for a
  // Land that then refuses — and the dirty-code check above means a session
  // with uncommitted code is never closed. Awaited one by one: on Windows an
  // open shell's cwd makes `git worktree remove` fail half-way, so each shell
  // must be gone before the merge and teardown start. Their session-log runs
  // go to the main checkout (worktreeOwner), so nothing waits on those; their
  // first git reads in the worktree take no index lock, so they cannot make
  // resetDocToMergeBase below fail.
  const toClose = sessionsInWorktree(deps.sessions, track.worktreePath);
  for (const s of toClose) await deps.terminateSession(s.id);

  // 1. The plan back onto main, then PROJECT.md out of the merge.
  const returned = await returnSectionToMain({ project, worktreePath: track.worktreePath, trackName });
  let beforeReset: string | null = null;
  try {
    beforeReset = await resetDocToMergeBase(track, docRel);
  } catch (error) {
    await returned.rollback();
    throw error;
  }

  // 2. Merge.
  const merged = await git(project.cwd, [
    ...COMMIT_IDENTITY,
    'merge',
    '--no-ff',
    track.branch,
    '-m',
    `Merge track: ${trackName}`,
  ]);
  if (merged === null) {
    await git(project.cwd, ['merge', '--abort']);
    await returned.rollback();
    // Take the reset commit back off the track branch. Without this the next
    // Land reads the already-reset copy and the track's section is gone for
    // good. Safe: the worktree was committed clean above, so --hard discards
    // nothing else.
    if (beforeReset) await git(track.worktreePath, ['reset', '--hard', beforeReset]);
    const planning = mainEntries.map((e) => e.path);
    throw new TrackBranchError(
      `Merging ${track.branch} into ${track.baseBranch} failed. Use Update from ${track.baseBranch} on the track; if it names conflicting files, make them agree on either side and Update again, then land. ${mergeTrapAdvice(track.baseBranch)}` +
        (planning.length > 0
          ? ` If the uncommitted planning files on main are in the way (${nameFiles(planning)}), commit or stash them.`
          : ''),
      409
    );
  }
  const mergeSha = (await git(project.cwd, ['rev-parse', 'HEAD']))?.trim() || '';
  markLanded(track.id, mergeSha);

  // 3. Publish, as the merge stage does for a job. Only commits go: the
  // uncommitted backlog edits on main stay where they are.
  let pushed = false;
  if (await hasRemote(project.cwd)) {
    pushed = (await git(project.cwd, ['push'])) !== null;
  }

  // 4. The branch's commits now live on the base; only the label goes.
  const torn = await removeWorktree(project.cwd, track.id, {
    path: track.worktreePath,
    deleteBranch: track.branch,
  });
  // The track's read-only peers' references and findings ledger: the track is done.
  deletePeerNotes(track.id);
  // The land itself stands. A link the teardown could not remove leaves the
  // worktree registered and the branch checked out there, with nothing else
  // recording either, so the result has to say where they are.
  // Unless a link kept the worktree registered: its sessions can still revive
  // there. (A busy folder is deregistered and retried, so it goes.) A failure here is logged, never
  // thrown — the land itself stands.
  if (torn.linksLeft.length === 0) {
    await deps.removeSessions(track.worktreePath).catch((error: Error) => {
      logger.warn({ track: trackName, error: error.message }, 'land: removing worktree sessions failed');
    });
  }
  const leftover =
    torn.linksLeft.length > 0
      ? ` ${describeLinksLeft(track.worktreePath, torn.linksLeft)} ` +
        `Then run "git worktree remove ${track.worktreePath}" and "git branch -D ${track.branch}".`
      : '';

  const synced = returned.featureIds;
  const closed = toClose.length;
  logger.info({ cwd: project.cwd, track: trackName, mergeSha, pushed, synced, closed }, 'track landed');
  return {
    mergeSha,
    pushed,
    synced,
    closedSessions: closed,
    detail:
      (pushed ? `Landed into ${track.baseBranch} and pushed` : `Landed into ${track.baseBranch}`) +
      (closed > 0 ? ` — closed ${closed} open session${closed === 1 ? '' : 's'} in its worktree` : '') +
      leftover,
  };
}

/**
 * Land's checks that need no session, in Land's order: no live job, no
 * running install, the project on the base branch, no code (and nothing
 * staged) on main, no code in the worktree. Uncommitted planning in the
 * worktree is committed on the track branch, as Land does. A session that
 * asks to Land runs this first, while its agent can still act on a refusal
 * (POST /api/agent/land); Land itself runs it again.
 *
 * Returns the track and main's status, which Land's merge-failure message
 * names.
 */
export async function landPreflight(
  project: RegistryProject,
  trackName: string
): Promise<{ track: TrackBranch; mainEntries: GitStatusEntry[] }> {
  const track = getActiveTrackBranch(project.cwd, trackName);
  if (!track) throw new TrackBranchError('This track has no branch to land', 404);
  const docRel = docRelOf(project);

  const liveJobs = liveJobsOf(project, track);
  if (liveJobs.length > 0) {
    throw new TrackBranchError(
      `${liveJobs.length} job(s) for this track are still active — let them finish or cancel them first`,
      409
    );
  }

  // No session exists yet while Open session waits on the install, so the
  // sessions Land closes can't include it; the teardown would delete under a
  // running npm.
  if (isInstalling(track.worktreePath)) {
    throw new TrackBranchError(
      'Dependencies are still installing in this track’s worktree — land once the session has opened',
      409
    );
  }

  await reattachIfMissing(project, track);
  const current = await offBranch(project.cwd, track.baseBranch);
  if (current !== null) {
    throw new TrackBranchError(
      `The project is on "${current}" but this track branched from "${track.baseBranch}". ` +
        `Switch back to ${track.baseBranch} before landing.`,
      409
    );
  }
  const mainEntries = await gitStatusEntries(project.cwd, { allUntracked: true });
  if (mainEntries === null) {
    throw new TrackBranchError(`Could not read the repository state at ${project.cwd}`, 500);
  }
  const mainCode = mainEntries
    .filter((e) => !isPlanningPath(e.path, docRel) && !isSessionLogPath(e.path))
    .map((e) => e.path);
  if (mainCode.length > 0) {
    throw new TrackBranchError(
      `The project has uncommitted changes outside the plan: ${nameFiles(mainCode)}. ` +
        'Commit or stash them before landing this track — code edited on main may be this track’s work.',
      409
    );
  }
  const mainStaged = mainEntries.filter((e) => !e.untracked && e.staged !== ' ').map((e) => e.path);
  if (mainStaged.length > 0) {
    throw new TrackBranchError(
      `These files are staged on main: ${nameFiles(mainStaged)}. git refuses to merge while anything ` +
        'is staged — commit or unstage them (they can stay uncommitted), then land again.',
      409
    );
  }
  const worktreeCode = await commitWorktreePlanning(
    track.worktreePath,
    docRel,
    `chore: commit "${trackName}" planning before landing`
  );
  if (worktreeCode) {
    throw new TrackBranchError(
      `The track worktree has uncommitted changes (${track.worktreePath}): ${nameFiles(worktreeCode)}. ` +
        'Commit or discard them first.',
      409
    );
  }
  return { track, mainEntries };
}


/**
 * Commit the branch's PROJECT.md back to its merge-base version, if it moved.
 * Returns the HEAD from before that commit, so a failed land can take it back
 * off — or null when nothing was committed.
 *
 * Throws when a step fails rather than carrying on: a reset that silently
 * didn't happen sends the branch's PROJECT.md into the merge, which is the
 * conflict this function exists to prevent (a held `index.lock` is enough).
 */
async function resetDocToMergeBase(track: TrackBranch, docRel: string): Promise<string | null> {
  const wt = track.worktreePath;
  const base = (await git(wt, ['merge-base', 'HEAD', track.baseBranch]))?.trim();
  if (!base) return null;
  const changedOut = await git(wt, ['diff', '--name-only', base, 'HEAD', '--', docRel]);
  if (changedOut === null) throw resetFailed(track, docRel);
  if (!changedOut.trim()) return null;
  const before = (await git(wt, ['rev-parse', 'HEAD']))?.trim() ?? null;

  const existedAtBase = (await git(wt, ['cat-file', '-e', `${base}:${docRel}`])) !== null;
  const staged = existedAtBase
    ? await git(wt, ['checkout', base, '--', docRel])
    : await git(wt, ['rm', '-q', '--', docRel]);
  const committed =
    staged === null
      ? null
      : await git(wt, [
          ...COMMIT_IDENTITY,
          'commit',
          '-m',
          `Leave ${docRel} to the main checkout`,
          '--no-verify',
          '--',
          docRel,
        ]);
  if (committed === null) {
    // Put the file back as HEAD has it, so the worktree is as Land found it
    // (it was committed clean above) and the next Land starts from there.
    await git(wt, ['reset', '-q', '--', docRel]);
    await git(wt, ['checkout', 'HEAD', '--', docRel]);
    throw resetFailed(track, docRel);
  }
  return before;
}

function resetFailed(track: TrackBranch, docRel: string): TrackBranchError {
  return new TrackBranchError(
    `Could not take ${docRel} out of the merge in the track worktree (${track.worktreePath}) — ` +
      'another git process may have held its index. Nothing was merged; land again.',
    409
  );
}
