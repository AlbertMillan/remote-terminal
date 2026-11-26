import { getDatabase } from '../db/schema.js';
import { pathKey } from '../utils/paths.js';

/**
 * The retired job pipeline's rows, read-only (docs/track-branches.md, Delete).
 *
 * Nothing writes `jobs` or `job_stages` any more, and they are never dropped:
 * Delete track still recognises a merge an old job made, by the `merge_sha`
 * the job recorded or, for a job discarded since, by the `Job-Id` / `Feature`
 * trailers and `Merge job: <title>` subject it left (merge-trailers.ts).
 */

export interface JobHistoryRow {
  id: string;
  title: string;
  featureId: string | null;
  baseBranch: string | null;
  mergeSha: string | null;
  /** Its merge stage passed: its commit is on `baseBranch`. */
  merged: boolean;
}

interface Row {
  id: string;
  project_cwd: string;
  title: string;
  feature_id: string | null;
  base_branch: string | null;
  merge_sha: string | null;
  merged: number;
}

/** A project's old jobs, newest first. Empty when the tables are empty. */
export function listJobHistory(cwd: string): JobHistoryRow[] {
  const key = pathKey(cwd);
  const rows = getDatabase()
    .prepare(
      `SELECT j.id, j.project_cwd, j.title, j.feature_id, j.base_branch, j.merge_sha,
              EXISTS (SELECT 1 FROM job_stages s WHERE s.job_id = j.id AND s.name = 'merge' AND s.status = 'passed') AS merged
         FROM jobs j ORDER BY j.created_at DESC`
    )
    .all() as Row[];
  return rows
    .filter((r) => pathKey(r.project_cwd) === key)
    .map((r) => ({
      id: r.id,
      title: r.title,
      featureId: r.feature_id,
      baseBranch: r.base_branch,
      mergeSha: r.merge_sha,
      merged: r.merged === 1,
    }));
}
