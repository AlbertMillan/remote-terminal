import { getDatabase } from '../db/schema.js';
import { pathKey } from '../sessions/project-discovery.js';

/**
 * The `track_branches` table: a track's own branch and worktree, keyed by
 * project and track name (docs/track-branches.md, "Storage").
 *
 * Its own module, with no imports from the rest of projects/, so that the
 * plan readers (project-plan.ts) and attribution can use it without importing
 * track-branches.ts, which imports both of them.
 */

export interface TrackBranch {
  id: string;
  projectCwd: string;
  trackName: string;
  branch: string;
  worktreePath: string;
  baseBranch: string;
  createdAt: string;
  landedAt: string | null;
  mergeSha: string | null;
}

export interface TrackBranchRow {
  id: string;
  project_cwd: string;
  project_key: string;
  track_name: string;
  branch: string;
  worktree_path: string;
  base_branch: string;
  created_at: string;
  landed_at: string | null;
  merge_sha: string | null;
}

export function toTrackBranch(row: TrackBranchRow): TrackBranch {
  return {
    id: row.id,
    projectCwd: row.project_cwd,
    trackName: row.track_name,
    branch: row.branch,
    worktreePath: row.worktree_path,
    baseBranch: row.base_branch,
    createdAt: row.created_at,
    landedAt: row.landed_at,
    mergeSha: row.merge_sha,
  };
}

/** The track's branch that has not landed yet, if it has one. */
export function getActiveTrackBranch(cwd: string, trackName: string): TrackBranch | null {
  const row = getDatabase()
    .prepare(
      `SELECT * FROM track_branches
       WHERE project_key = ? AND track_name = ? AND landed_at IS NULL`
    )
    .get(pathKey(cwd), trackName) as TrackBranchRow | undefined;
  return row ? toTrackBranch(row) : null;
}

/** Every track branch of a project, landed ones included, oldest first. */
export function listTrackBranches(cwd: string): TrackBranch[] {
  const rows = getDatabase()
    .prepare('SELECT * FROM track_branches WHERE project_key = ? ORDER BY created_at')
    .all(pathKey(cwd)) as TrackBranchRow[];
  return rows.map(toTrackBranch);
}

/** The not-yet-landed track branch named `branch`, used by the merge stage. */
export function findActiveTrackBranchByName(cwd: string, branch: string): TrackBranch | null {
  const row = getDatabase()
    .prepare(
      `SELECT * FROM track_branches
       WHERE project_key = ? AND branch = ? AND landed_at IS NULL`
    )
    .get(pathKey(cwd), branch) as TrackBranchRow | undefined;
  return row ? toTrackBranch(row) : null;
}

/** True when `branch` is, or was, one of this project's track branches. */
export function isTrackBranch(cwd: string, branch: string): boolean {
  return (
    getDatabase()
      .prepare('SELECT 1 FROM track_branches WHERE project_key = ? AND branch = ?')
      .get(pathKey(cwd), branch) !== undefined
  );
}

/**
 * Forget a track's rows. Only Delete track calls this. `keepUnlanded` keeps the
 * row of a branch whose worktree could not be removed, so it stays on the
 * board and can be deleted again instead of being left on disk unrecorded.
 */
export function deleteTrackBranchRows(
  cwd: string,
  trackName: string,
  opts: { keepUnlanded?: boolean } = {}
): void {
  getDatabase()
    .prepare(
      `DELETE FROM track_branches WHERE project_key = ? AND track_name = ?${
        opts.keepUnlanded ? ' AND landed_at IS NOT NULL' : ''
      }`
    )
    .run(pathKey(cwd), trackName);
}

export function markLanded(id: string, mergeSha: string): void {
  getDatabase()
    .prepare('UPDATE track_branches SET landed_at = ?, merge_sha = ? WHERE id = ?')
    .run(new Date().toISOString(), mergeSha, id);
}
