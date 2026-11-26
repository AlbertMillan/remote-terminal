import { getDatabase } from '../db/schema.js';
import { pathKey } from '../utils/paths.js';
import { emptyProgress, parseProgress, type Progress } from './templates.js';

/**
 * The engine's progress per unit of work (`factory_runs`, migration 024).
 *
 * A unit is what one agent run carries: a loose item, keyed by its feature id,
 * or a whole track, keyed `track:<name>`, whose items are all claimed together.
 * The item store holds claims and the current step; this holds what a run
 * needs to RESUME — the worktree, the Claude session to `--resume`, every
 * step's outcome and loop count, the last commit — so a reclaimed or restarted
 * unit continues from its last commit and conversation rather than from scratch.
 */

export interface RunState {
  projectCwd: string;
  unitId: string;
  worktreePath: string | null;
  branch: string | null;
  baseBranch: string | null;
  /** The working conversation (implement, features, fix, summary), resumed across steps. */
  sessionId: string | null;
  lastCommit: string | null;
  progress: Progress;
  parkReason: string | null;
  handedOffAt: string | null;
  createdAt: string;
  updatedAt: string;
}

interface Row {
  project_key: string;
  project_cwd: string;
  unit_id: string;
  worktree_path: string | null;
  branch: string | null;
  base_branch: string | null;
  session_id: string | null;
  last_commit: string | null;
  progress: string;
  park_reason: string | null;
  handed_off_at: string | null;
  created_at: string;
  updated_at: string;
}

function toState(row: Row): RunState {
  return {
    projectCwd: row.project_cwd,
    unitId: row.unit_id,
    worktreePath: row.worktree_path,
    branch: row.branch,
    baseBranch: row.base_branch,
    sessionId: row.session_id,
    lastCommit: row.last_commit,
    progress: parseProgress(row.progress),
    parkReason: row.park_reason,
    handedOffAt: row.handed_off_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

const TRACK_PREFIX = 'track:';

/** The unit an item belongs to: its own feature id, or its track for a track workflow. */
export function unitIdFor(item: { featureId: string; trackName: string }, isTrack: boolean): string {
  return isTrack ? `${TRACK_PREFIX}${item.trackName}` : item.featureId;
}

export function getRunState(projectCwd: string, unitId: string): RunState | null {
  const row = getDatabase()
    .prepare('SELECT * FROM factory_runs WHERE project_key = ? AND unit_id = ?')
    .get(pathKey(projectCwd), unitId) as Row | undefined;
  return row ? toState(row) : null;
}

/** The unit's state, created empty (with the steps it skips) the first time it is run. */
export function ensureRunState(projectCwd: string, unitId: string, skip: string[] = [], now = Date.now()): RunState {
  const at = new Date(now).toISOString();
  getDatabase()
    .prepare(
      `INSERT INTO factory_runs (project_key, project_cwd, unit_id, progress, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (project_key, unit_id) DO NOTHING`
    )
    .run(pathKey(projectCwd), projectCwd, unitId, JSON.stringify(emptyProgress(skip)), at, at);
  return getRunState(projectCwd, unitId) as RunState;
}

export type RunStatePatch = Partial<
  Pick<RunState, 'worktreePath' | 'branch' | 'baseBranch' | 'sessionId' | 'lastCommit' | 'progress' | 'parkReason' | 'handedOffAt'>
>;

const COLUMN: Record<keyof RunStatePatch, string> = {
  worktreePath: 'worktree_path',
  branch: 'branch',
  baseBranch: 'base_branch',
  sessionId: 'session_id',
  lastCommit: 'last_commit',
  progress: 'progress',
  parkReason: 'park_reason',
  handedOffAt: 'handed_off_at',
};

export function saveRunState(projectCwd: string, unitId: string, patch: RunStatePatch, now = Date.now()): void {
  const keys = (Object.keys(patch) as (keyof RunStatePatch)[]).filter(
    (k) => Object.prototype.hasOwnProperty.call(COLUMN, k) && patch[k] !== undefined
  );
  const sets = keys.map((k) => `${COLUMN[k]} = ?`);
  const values = keys.map((k) => (k === 'progress' ? JSON.stringify(patch.progress) : (patch[k] as string | null)));
  sets.push('updated_at = ?');
  values.push(new Date(now).toISOString());
  getDatabase()
    .prepare(`UPDATE factory_runs SET ${sets.join(', ')} WHERE project_key = ? AND unit_id = ?`)
    .run(...values, pathKey(projectCwd), unitId);
}

/** Forget a unit's progress (a track sent again after its earlier unit closed). */
export function deleteRunState(projectCwd: string, unitId: string): void {
  getDatabase().prepare('DELETE FROM factory_runs WHERE project_key = ? AND unit_id = ?').run(pathKey(projectCwd), unitId);
}

/** Units sitting in the merge sink: dispatch must not claim them again. */
export function handedOffUnits(): Set<string> {
  const rows = getDatabase()
    .prepare('SELECT project_key, unit_id FROM factory_runs WHERE handed_off_at IS NOT NULL')
    .all() as { project_key: string; unit_id: string }[];
  return new Set(rows.map((r) => `${r.project_key}\n${r.unit_id}`));
}

/**
 * Take a unit back from the merge sink (a failed merge the queue returns to
 * the factory): dispatch may claim it again, resuming at its current step.
 */
export function clearHandoff(projectCwd: string, unitId: string, now = Date.now()): void {
  saveRunState(projectCwd, unitId, { handedOffAt: null }, now);
}

export function unitKey(projectCwd: string, unitId: string): string {
  return `${pathKey(projectCwd)}\n${unitId}`;
}
