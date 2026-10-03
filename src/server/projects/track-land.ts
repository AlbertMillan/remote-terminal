import type { RegistryProject } from './registry.js';
import { withProjectLock } from './project-lock.js';
import { buildProject, type BuildResult } from './project-build.js';
import { isServerRoot, recheckBuildState, restartHint } from '../server-restart.js';
import {
  TrackBranchError,
  behindMain,
  landPreflight,
  landTrack,
  type LandDeps,
  type LandResult,
} from './track-branches.js';
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
