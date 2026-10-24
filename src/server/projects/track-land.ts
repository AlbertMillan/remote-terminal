import type { RegistryProject } from './registry.js';
import { withProjectLock } from './project-lock.js';
import { buildProject, type BuildResult } from './project-build.js';
import { isServerRoot, recheckBuildState, restartHint } from '../server-restart.js';
import {
  TrackBranchError,
  behindMain,
  getActiveTrackBranch,
  landPreflight,
  landTrack,
  updateTrackFromMain,
  type LandDeps,
  type LandResult,
  type UpdateResult,
} from './track-branches.js';
import { installDependencies, needsInstall, type InstallResult } from './project-deps.js';
import { broadcastProjectsChanged } from '../websocket/connections.js';
import { mergeTrapAdvice, nameFiles } from './track-plan.js';

/**
 * Land as its callers run it: the board's Land button (POST
 * /api/projects/track/land) and a track's own session (POST /api/agent/land,
 * docs/session-orchestration.md). The routes only connect HTTP to these.
 */

/**
 * Land under the project try lock, then rebuild the main checkout, so every
 * caller gets the build result and the restart hint in `detail`.
 */
export async function landAndBuild(
  project: RegistryProject,
  track: string,
  deps: LandDeps
): Promise<LandResult & { build: BuildResult }> {
  const landed = await withProjectLock(project.cwd, `landing "${track}"`, () => landTrack(project, track, deps));
  // Outside the lock: a build touches no git state, and holding the lock
  // for minutes would refuse every Land/Delete/merge meanwhile. A failed
  // build does not undo the land — it is reported alongside it.
  const build = await buildProject(project.cwd);
  // Landing this server's own project changes nothing it runs until a
  // restart, and "build passed" alone reads as though nothing more is
  // needed. Re-check (the cache predates the merge) and say which.
  const hint = isServerRoot(project.cwd) ? restartHint((await recheckBuildState())?.state) : '';
  return {
    ...landed,
    build,
    detail: (build.ran ? `${landed.detail} — ${build.detail}` : landed.detail) + hint,
  };
}

/**
 * What a session's Land checks before it answers: Land's checks that need no
 * session closed (landPreflight), plus a merge that would conflict. A session
 * learns of a refusal only while it is still running, so a conflict the board
 * would discover at merge time is looked for here (behindMain's dry run).
 *
 * Holds the project lock for the checks only — never across the reply, which
 * is sent before the Land itself runs and takes the lock again.
 */
export function landPreflightForSession(project: RegistryProject, trackName: string): Promise<void> {
  return withProjectLock(project.cwd, `checking "${trackName}" before a session's Land`, async () => {
    const { track } = await landPreflight(project, trackName);
    const behind = await behindMain(project, track);
    if (behind?.wouldConflict?.length) {
      throw new TrackBranchError(
        `Landing "${trackName}" would conflict with ${track.baseBranch} in ${nameFiles(behind.wouldConflict)}. ` +
          `Make those files agree on either side, then use Update from ${track.baseBranch} on the track and land again. ` +
          mergeTrapAdvice(track.baseBranch),
        409
      );
    }
  });
}


// --- Update from main ----------------------------------------------------

export interface UpdateAndInstallDeps {
  /** Reinstall over the worktree's `node_modules`, whether or not it exists. */
  install(worktreePath: string): Promise<InstallResult>;
  /** Tell open boards the track changed. */
  announce(projectCwd: string): void;
}

const defaultUpdateDeps: UpdateAndInstallDeps = {
  install: (worktreePath) => installDependencies(worktreePath, undefined, { refresh: true }),
  announce: broadcastProjectsChanged,
};

/**
 * Update from main as its callers run it: the board's button (POST
 * /api/projects/track/update) and a track's session (POST /api/agent/update).
 *
 * The merge runs under the project try lock. A reinstall follows when the
 * merge changed a lockfile, or when the worktree's dependencies are missing
 * or were left incomplete (needsInstall), so an Update run again after a
 * failed or interrupted install retries it even when nothing is left to merge.
 * The install is STARTED inside the lock, which marks the folder busy
 * (isInstalling) before the lock is free, so a Land or Delete that takes it
 * next refuses; and AWAITED outside it, as landAndBuild's build is: holding
 * the lock for minutes would refuse every Land, Delete and job merge.
 *
 * Boards hear of a merge as soon as it is committed, not after the install.
 * A failed install keeps the merge and says what to do in `detail`.
 */
export async function updateAndInstall(
  project: RegistryProject,
  track: string,
  deps: UpdateAndInstallDeps = defaultUpdateDeps
): Promise<UpdateResult & { install: InstallResult | null }> {
  const { updated, why, pending } = await withProjectLock(project.cwd, `updating "${track}" from main`, async () => {
    const updated = await updateTrackFromMain(project, track);
    const worktree = getActiveTrackBranch(project.cwd, track)?.worktreePath;
    const why: 'lockfile' | 'incomplete' | null = !worktree
      ? null
      : updated.lockfileChanged
        ? 'lockfile'
        : needsInstall(worktree)
          ? 'incomplete'
          : null;
    const pending = worktree && why ? installSafely(deps, worktree) : null;
    return { updated, why, pending };
  });
  if (updated.mergeSha) deps.announce(project.cwd);

  const install = pending ? await pending : null;
  let note = '';
  if (install?.ran) {
    const cause =
      why === 'lockfile' ? 'The lockfile changed' : 'The worktree’s dependencies were missing or incomplete';
    note = install.ok
      ? ` ${cause}, so they were reinstalled (${install.detail}).`
      : ` ${cause}, but reinstalling them failed: ${install.detail}. The merge is kept. ` +
        'Stop anything running in the track’s worktree (a dev server, vitest), then Update again: it retries the install.';
  } else if (updated.lockfileChanged === null) {
    note =
      ' Could not tell whether the lockfile changed: if the tests fail on a missing package, ' +
      'install the dependencies in the track’s worktree.';
  }
  // "Already up to date with main" has no full stop of its own.
  const detail = note && !/[.!?]$/.test(updated.detail) ? `${updated.detail}.${note}` : updated.detail + note;
  return { ...updated, install: install?.ran ? install : null, detail };
}

/** deps.install, with a throw reported as a failed install: the merge is already committed. */
function installSafely(deps: UpdateAndInstallDeps, worktree: string): Promise<InstallResult> {
  try {
    return deps.install(worktree).catch((error: unknown) => failedInstall(error));
  } catch (error) {
    return Promise.resolve(failedInstall(error));
  }
}

function failedInstall(error: unknown): InstallResult {
  return { ran: true, ok: false, detail: error instanceof Error ? error.message : String(error) };
}
