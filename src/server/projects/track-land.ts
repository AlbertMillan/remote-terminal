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
import { installDependencies, type InstallResult } from './project-deps.js';
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
  /** Reinstall over the worktree's existing `node_modules`. */
  install(worktreePath: string): Promise<InstallResult>;
  /** Tell open boards the track changed. */
  announce(projectCwd: string): void;
}

export const defaultUpdateDeps: Omit<UpdateAndInstallDeps, 'announce'> = {
  install: (worktreePath) => installDependencies(worktreePath, undefined, { refresh: true }),
};

/**
 * Update from main as its callers run it: the board's button (POST
 * /api/projects/track/update) and a track's session (POST /api/agent/update).
 * The merge runs under the project try lock; a reinstall, when the merge
 * changed a lockfile, runs after it, as landAndBuild's build does: holding the
 * lock for minutes would refuse every Land, Delete and job merge meanwhile.
 * The install marks the folder busy (isInstalling) as soon as it starts, with
 * no await in between, so a Land or Delete arriving after the lock is free
 * still refuses while it runs.
 *
 * A failed install keeps the merge and says what to do in `detail`.
 */
export async function updateAndInstall(
  project: RegistryProject,
  track: string,
  deps: UpdateAndInstallDeps
): Promise<UpdateResult & { install: InstallResult | null }> {
  const updated = await withProjectLock(project.cwd, `updating "${track}" from main`, () =>
    updateTrackFromMain(project, track)
  );
  let install: InstallResult | null = null;
  let note = '';
  const worktree = updated.lockfileChanged ? getActiveTrackBranch(project.cwd, track)?.worktreePath : undefined;
  if (worktree) {
    try {
      install = await deps.install(worktree);
    } catch (error) {
      install = { ran: true, ok: false, detail: error instanceof Error ? error.message : String(error) };
    }
    if (!install.ran) install = null;
    else if (install.ok) note = ` The lockfile changed, so dependencies were reinstalled (${install.detail}).`;
    else {
      note =
        ` The lockfile changed, but reinstalling dependencies failed: ${install.detail}. The merge is kept. ` +
        'Stop anything running in the track’s worktree (a dev server, vitest), then run the install there.';
    }
  }
  if (updated.mergeSha) deps.announce(project.cwd);
  return { ...updated, install, detail: updated.detail + note };
}
