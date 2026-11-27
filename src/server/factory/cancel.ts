import { existsSync } from 'fs';
import { getSession } from '../db/queries.js';
import { createLogger } from '../utils/logger.js';
import { describeLinksLeft, removeWorktree, worktreePathFor, type TeardownResult } from '../worktrees/worktree.js';
import { getDispatcher } from './dispatcher.js';
import { deleteParkedMerge, latestMergeFor } from './merge-queue-store.js';
import { deleteRunState, getRunState, saveRunState, unitKey } from './run-state.js';
import { updateItem } from './store.js';
import { ClaimError, unitOf, unitSessionHolder } from './takeover.js';

const logger = createLogger('factory-cancel');

/**
 * Cancel a factory unit from the board or `cr factory cancel` (docs/code-factory.md).
 *
 * Order matters, as it did for the old pipeline's cancel:
 *  1. every refusal first (a session holds it; its merge is under way), so a
 *     refused cancel changes nothing;
 *  2. the items are marked `cancelled` FIRST: that clears their claims, so the
 *     run's heartbeat and owner-checked release touch nothing, the dispatcher
 *     never claims them again, and a session can no longer take them;
 *  3. the run is aborted and AWAITED: on Windows `git worktree remove` fails
 *     against files a dying `claude` still holds open;
 *  4. a parked merge entry is dropped (Retry merge would land cancelled work);
 *  5. a loose item's worktree and branch are torn down under removeWorktree's
 *     rules. A track's worktree is the track's (Land or Delete retires it).
 *
 * The PROJECT.md line stays unticked: ticking is the merge's job.
 */

export interface CancelDeps {
  /** Stop the unit's run in this process and settle once it unwound; false when none runs here. */
  stopUnit(key: string): Promise<boolean>;
  teardown(projectCwd: string, featureId: string, opts: { path: string; branch: string | null }): Promise<TeardownResult>;
  sessionName(sessionId: string): string | null;
  now(): number;
}

export const defaultCancelDeps: CancelDeps = {
  stopUnit: async (key) => (await getDispatcher()?.stopUnit(key)) ?? false,
  teardown: (projectCwd, featureId, { path, branch }) =>
    removeWorktree(projectCwd, `factory-${featureId}`, { path, deleteBranch: branch }),
  sessionName: (id) => getSession(id)?.name ?? null,
  now: () => Date.now(),
};

export interface CancelResult {
  unitId: string;
  featureIds: string[];
  /** A run was working the unit and was stopped. */
  stoppedRun: boolean;
  /** A parked merge entry was dropped. */
  mergeDropped: boolean;
  /** The loose item's worktree folder is gone (always false for a track). */
  worktreeRemoved: boolean;
  branchDeleted: boolean;
  /** Why the worktree is still on disk, when its teardown left a link behind. */
  note: string | null;
}

const MERGING = new Set(['queued', 'holding', 'running']);

/**
 * Why the unit cannot be cancelled now, as the error cancelUnit would throw, or
 * null. Delete track checks every unit with this before cancelling any.
 */
export function cancelRefusal(
  projectCwd: string,
  featureId: string,
  deps: Pick<CancelDeps, 'sessionName'> = defaultCancelDeps
): ClaimError | null {
  const unit = unitOf(projectCwd, featureId);
  if (!unit || unit.items.length === 0) return new ClaimError(404, `${featureId} is not live factory work`);
  const holder = unitSessionHolder(unit);
  if (holder) {
    const name = deps.sessionName(holder);
    return new ClaimError(
      409,
      `the terminal session ${name ? `"${name}" (${holder})` : holder} holds ${unit.isTrack ? `"${unit.lead.trackName}"` : featureId}; return it to the factory before cancelling`
    );
  }
  const merge = parkedOrMerging(projectCwd, unit.unitId);
  if (merge && MERGING.has(merge.status)) {
    return new ClaimError(409, `${unit.isTrack ? `"${unit.lead.trackName}"` : featureId} is in the merge queue (${merge.status}); it can no longer be cancelled`);
  }
  return null;
}

/** The unit's merge entry while it is handed off, or null. */
function parkedOrMerging(projectCwd: string, unitId: string) {
  const state = getRunState(projectCwd, unitId);
  return state?.handedOffAt && state.branch ? latestMergeFor(projectCwd, state.branch) : null;
}

export async function cancelUnit(projectCwd: string, featureId: string, deps: CancelDeps = defaultCancelDeps): Promise<CancelResult> {
  // 1. Refusals.
  const refused = cancelRefusal(projectCwd, featureId, deps);
  if (refused) throw refused;
  const unit = unitOf(projectCwd, featureId);
  if (!unit) throw new ClaimError(404, `${featureId} is not live factory work`);
  const state = getRunState(projectCwd, unit.unitId);
  const merge = parkedOrMerging(projectCwd, unit.unitId);

  // 2. Closed first: the run unwinds without touching the items.
  const ids = unit.items.map((i) => i.featureId);
  const now = deps.now();
  for (const id of ids) updateItem(projectCwd, id, { status: 'cancelled' }, now);

  // 3. Abort and await the run.
  const stoppedRun = await deps.stopUnit(unitKey(projectCwd, unit.unitId));

  // 4. A parked merge would otherwise sit on the board with a Retry that lands cancelled work.
  let mergeDropped = false;
  if (merge?.status === 'parked') mergeDropped = deleteParkedMerge(merge.id);

  // 5. A loose item's own worktree goes; a track's stays.
  let worktreeRemoved = false;
  let branchDeleted = false;
  let note: string | null = null;
  if (!unit.isTrack) {
    const path = state?.worktreePath ?? worktreePathFor(`factory-${featureId}`);
    const branch = state?.branch ?? null;
    if (existsSync(path) || branch) {
      const torn = await deps.teardown(projectCwd, featureId, { path, branch });
      worktreeRemoved = torn.removed;
      branchDeleted = torn.branchDeleted;
      if (torn.linksLeft.length > 0) note = describeLinksLeft(path, torn.linksLeft);
    }
    // Keep the record while the folder is still there, so it stays findable.
    if (note) saveRunState(projectCwd, unit.unitId, { parkReason: 'cancelled', handedOffAt: null }, deps.now());
    else deleteRunState(projectCwd, unit.unitId);
  } else if (state) {
    // A track sent again starts its progress over (send.ts), so only mark this one.
    saveRunState(projectCwd, unit.unitId, { parkReason: 'cancelled', handedOffAt: null }, deps.now());
  }

  logger.info(
    { cwd: projectCwd, unit: unit.unitId, items: ids, stoppedRun, mergeDropped, worktreeRemoved, branchDeleted },
    'factory: unit cancelled'
  );
  return { unitId: unit.unitId, featureIds: ids, stoppedRun, mergeDropped, worktreeRemoved, branchDeleted, note };
}
