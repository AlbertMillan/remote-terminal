import { randomUUID } from 'crypto';
import { getDatabase } from '../db/schema.js';
import { pathKey } from '../utils/paths.js';
import { factoryEvents } from './events.js';
import type { MergeSide } from '../projects/track-update.js';
import type { MergeEntry } from './merge-queue.js';

/**
 * The merge queue's rows (`factory_merges`, migration 025). The queue itself
 * runs in memory (merge-queue.ts); these record what each entry did, its
 * merge commit, and, for a parked one, both sides of what stopped it.
 */

/**
 * `queued` waits its turn; `holding` is its turn, waiting for a clean checkout
 * or a free project lock; `running` is being processed; `merged` and `parked`
 * are final (`parked` waits for the user and is never retried by itself).
 */
export type MergeStatus = 'queued' | 'holding' | 'running' | 'merged' | 'parked';

/** Both sides of the conflict a parked entry could not settle. */
export interface ParkedConflict {
  paths: string[];
  /** The branch being merged into. */
  ours: MergeSide;
  /** The branch being merged in. */
  theirs: MergeSide;
}

export interface MergeRecord extends MergeEntry {
  id: string;
  status: MergeStatus;
  detail: string | null;
  mergeSha: string | null;
  conflict: ParkedConflict | null;
  createdAt: string;
  updatedAt: string;
}

interface MergeRow {
  id: string;
  project_cwd: string;
  kind: MergeEntry['kind'];
  branch: string;
  worktree_path: string;
  base_branch: string;
  feature_ids: string;
  track_name: string | null;
  status: MergeStatus;
  detail: string | null;
  merge_sha: string | null;
  conflict_json: string | null;
  created_at: string;
  updated_at: string;
}

function parseJson<T>(text: string | null, fallback: T): T {
  if (!text) return fallback;
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
}

function toRecord(row: MergeRow): MergeRecord {
  return {
    id: row.id,
    projectCwd: row.project_cwd,
    kind: row.kind,
    branch: row.branch,
    worktreePath: row.worktree_path,
    baseBranch: row.base_branch,
    featureIds: parseJson<string[]>(row.feature_ids, []),
    ...(row.track_name !== null ? { trackName: row.track_name } : {}),
    status: row.status,
    detail: row.detail,
    mergeSha: row.merge_sha,
    conflict: parseJson<ParkedConflict | null>(row.conflict_json, null),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function insertMerge(entry: MergeEntry, now = Date.now()): MergeRecord {
  const id = `mq-${randomUUID()}`;
  const at = new Date(now).toISOString();
  getDatabase()
    .prepare(
      `INSERT INTO factory_merges (id, project_key, project_cwd, kind, branch, worktree_path, base_branch,
         feature_ids, track_name, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?)`
    )
    .run(
      id,
      pathKey(entry.projectCwd),
      entry.projectCwd,
      entry.kind,
      entry.branch,
      entry.worktreePath,
      entry.baseBranch,
      JSON.stringify(entry.featureIds),
      entry.trackName ?? null,
      at,
      at
    );
  factoryEvents.emitChange();
  return getMerge(id) as MergeRecord;
}

export function getMerge(id: string): MergeRecord | null {
  const row = getDatabase().prepare('SELECT * FROM factory_merges WHERE id = ?').get(id) as MergeRow | undefined;
  return row ? toRecord(row) : null;
}

export interface MergePatch {
  status?: MergeStatus;
  detail?: string | null;
  mergeSha?: string | null;
  conflict?: ParkedConflict | null;
}

export function updateMerge(id: string, patch: MergePatch, now = Date.now()): void {
  const sets: string[] = [];
  const values: (string | null)[] = [];
  const set = (column: string, value: string | null) => {
    sets.push(`${column} = ?`);
    values.push(value);
  };
  if (patch.status !== undefined) set('status', patch.status);
  if (patch.detail !== undefined) set('detail', patch.detail);
  if (patch.mergeSha !== undefined) set('merge_sha', patch.mergeSha);
  if (patch.conflict !== undefined) set('conflict_json', patch.conflict === null ? null : JSON.stringify(patch.conflict));
  sets.push('updated_at = ?');
  values.push(new Date(now).toISOString());
  getDatabase().prepare(`UPDATE factory_merges SET ${sets.join(', ')} WHERE id = ?`).run(...values, id);
  factoryEvents.emitChange();
}

/** Drop a parked entry (its unit was cancelled: a Retry would land cancelled work). False when it is not parked. */
export function deleteParkedMerge(id: string): boolean {
  const info = getDatabase().prepare("DELETE FROM factory_merges WHERE id = ? AND status = 'parked'").run(id);
  if (info.changes > 0) factoryEvents.emitChange();
  return info.changes > 0;
}

/** The newest factory (not Land) entry for a branch in a project, or null. */
export function latestMergeFor(projectCwd: string, branch: string): MergeRecord | null {
  const row = getDatabase()
    .prepare(
      `SELECT * FROM factory_merges WHERE project_key = ? AND branch = ? AND kind != 'session-land'
       ORDER BY created_at DESC, rowid DESC LIMIT 1`
    )
    .get(pathKey(projectCwd), branch) as MergeRow | undefined;
  return row ? toRecord(row) : null;
}

/** A project's entries, oldest first; optionally only those in `statuses`. */
export function listMerges(projectCwd: string, statuses?: MergeStatus[]): MergeRecord[] {
  const where = ['project_key = ?'];
  const values: string[] = [pathKey(projectCwd)];
  if (statuses?.length) {
    where.push(`status IN (${statuses.map(() => '?').join(', ')})`);
    values.push(...statuses);
  }
  const rows = getDatabase()
    .prepare(`SELECT * FROM factory_merges WHERE ${where.join(' AND ')} ORDER BY created_at, rowid`)
    .all(...values) as MergeRow[];
  return rows.map(toRecord);
}

/** Every project's entries a stopped server left unfinished, oldest first. */
export function listUnfinishedMerges(): MergeRecord[] {
  const rows = getDatabase()
    .prepare(`SELECT * FROM factory_merges WHERE status IN ('queued', 'holding', 'running') ORDER BY created_at, rowid`)
    .all() as MergeRow[];
  return rows.map(toRecord);
}
