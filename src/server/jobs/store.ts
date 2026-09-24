import { randomUUID } from 'crypto';
import { getDatabase } from '../db/schema.js';
import { pathKey } from '../sessions/project-discovery.js';
import { jobEvents } from './events.js';
import type {
  GateName,
  Job,
  JobStage,
  JobStatus,
  JobWithStages,
  ParkReason,
  StageName,
  StageStatus,
  StageUsage,
} from './types.js';
import { STAGE_ORDER, sumUsage } from './types.js';

/**
 * Persistence for pipeline jobs.
 *
 * Jobs outlive the process: a job parked at a gate may sit for days waiting for
 * approval, and its worktree and Claude session must still be there when the
 * user comes back. So state lives in SQLite rather than memory, and the runner
 * reconciles against it on boot.
 */

interface JobRow {
  id: string;
  project_cwd: string;
  feature_id: string | null;
  title: string;
  status: string;
  stage: string | null;
  gate: string | null;
  approved_gate: string | null;
  park_reason: string | null;
  detail: string | null;
  worktree_path: string | null;
  branch: string | null;
  base_branch: string | null;
  merge_sha: string | null;
  pending_answer: string | null;
  claude_session_id: string | null;
  created_at: string;
  updated_at: string;
}

interface StageRow {
  id: number;
  job_id: string;
  name: string;
  status: string;
  detail: string | null;
  started_at: string | null;
  spawned_at: string | null;
  finished_at: string | null;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_creation_tokens: number;
  cost_usd: number;
  run_count: number;
}

function toJob(row: JobRow): Job {
  return {
    id: row.id,
    projectCwd: row.project_cwd,
    featureId: row.feature_id,
    title: row.title,
    status: row.status as JobStatus,
    stage: (row.stage as StageName | null) ?? null,
    gate: (row.gate as GateName | null) ?? null,
    approvedGate: (row.approved_gate as GateName | null) ?? null,
    parkReason: (row.park_reason as ParkReason | null) ?? null,
    detail: row.detail,
    worktreePath: row.worktree_path,
    branch: row.branch,
    baseBranch: row.base_branch,
    mergeSha: row.merge_sha ?? null,
    pendingAnswer: row.pending_answer,
    claudeSessionId: row.claude_session_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toStage(row: StageRow): JobStage {
  return {
    id: row.id,
    jobId: row.job_id,
    name: row.name as StageName,
    status: row.status as StageStatus,
    detail: row.detail,
    startedAt: row.started_at,
    spawnedAt: row.spawned_at,
    finishedAt: row.finished_at,
    usage: {
      inputTokens: row.input_tokens ?? 0,
      outputTokens: row.output_tokens ?? 0,
      cacheReadTokens: row.cache_read_tokens ?? 0,
      cacheCreationTokens: row.cache_creation_tokens ?? 0,
      costUsd: row.cost_usd ?? 0,
      runCount: row.run_count ?? 0,
    },
  };
}

export interface CreateJobInput {
  projectCwd: string;
  featureId: string | null;
  title: string;
}

/**
 * Create a queued job with its full stage list pre-seeded as pending, so the
 * board can show the whole pipeline from the moment it is created rather than
 * revealing stages one at a time.
 */
export function createJob(input: CreateJobInput): Job {
  const db = getDatabase();
  const now = new Date().toISOString();
  const id = randomUUID();

  const insert = db.transaction(() => {
    db.prepare(
      `INSERT INTO jobs (id, project_cwd, feature_id, title, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'queued', ?, ?)`
    ).run(id, input.projectCwd, input.featureId, input.title, now, now);

    const stageStmt = db.prepare(
      `INSERT INTO job_stages (job_id, name, status) VALUES (?, ?, 'pending')`
    );
    for (const name of STAGE_ORDER) stageStmt.run(id, name);
  });
  insert();

  jobEvents.emitChange();
  return getJob(id) as Job;
}

export function getJob(id: string): Job | null {
  const row = getDatabase().prepare('SELECT * FROM jobs WHERE id = ?').get(id) as
    | JobRow
    | undefined;
  return row ? toJob(row) : null;
}

export function getJobStages(jobId: string): JobStage[] {
  const rows = getDatabase()
    .prepare('SELECT * FROM job_stages WHERE job_id = ? ORDER BY id')
    .all(jobId) as StageRow[];
  return rows.map(toStage);
}

export function getJobWithStages(id: string): JobWithStages | null {
  const job = getJob(id);
  if (!job) return null;
  const stages = getJobStages(id);
  return { ...job, stages, usage: sumUsage(stages) };
}

/**
 * All jobs, newest first, with their stages.
 *
 * Stages are fetched in ONE query and grouped in memory rather than one query
 * per job: this is on the job board's poll path, and every job carries eight
 * stage rows.
 */
export function listJobs(): JobWithStages[] {
  const db = getDatabase();
  const rows = db.prepare('SELECT * FROM jobs ORDER BY created_at DESC').all() as JobRow[];
  if (rows.length === 0) return [];

  const stageRows = db
    .prepare('SELECT * FROM job_stages ORDER BY id')
    .all() as StageRow[];

  return attachStages(rows, stageRows);
}

/**
 * Jobs the live overlay feed cares about: everything in flight, plus anything
 * that reached a terminal status since `since` (an ISO timestamp).
 *
 * Filtered in SQL, not after `listJobs()`: this runs on every job write, and
 * reading every job and all eight of its stage rows to discard most of them is
 * work that grows with the table. `updated_at` compares as text because the
 * ISO-8601 UTC strings the store writes sort lexicographically.
 */
const LIVE_OR_RECENT = `status IN ('queued', 'running', 'parked') OR updated_at > ?`;

export function listLiveAndRecentJobs(since: string): JobWithStages[] {
  const db = getDatabase();
  const rows = db
    .prepare(`SELECT * FROM jobs WHERE ${LIVE_OR_RECENT} ORDER BY created_at DESC`)
    .all(since) as JobRow[];
  if (rows.length === 0) return [];

  // Stages are selected by repeating the predicate as a subquery rather than
  // binding one parameter per job id: an IN-list has a bound on how many
  // parameters SQLite accepts, and this has none.
  const stageRows = db
    .prepare(
      `SELECT * FROM job_stages
        WHERE job_id IN (SELECT id FROM jobs WHERE ${LIVE_OR_RECENT})
        ORDER BY id`
    )
    .all(since) as StageRow[];

  return attachStages(rows, stageRows);
}

/** Group stage rows onto their jobs in one pass, rather than a query per job. */
function attachStages(rows: JobRow[], stageRows: StageRow[]): JobWithStages[] {
  const byJob = new Map<string, JobStage[]>();
  for (const row of stageRows) {
    const stage = toStage(row);
    const list = byJob.get(row.job_id);
    if (list) list.push(stage);
    else byJob.set(row.job_id, [stage]);
  }

  return rows.map((row) => {
    const stages = byJob.get(row.id) ?? [];
    return { ...toJob(row), stages, usage: sumUsage(stages) };
  });
}

/**
 * Jobs for one project, newest first.
 *
 * Filtered in memory rather than SQL because matching is path-normalized
 * (case and separator insensitive), which SQLite cannot express. listJobs()
 * is a single pair of queries, so this stays cheap.
 */
export function listJobsForProject(cwd: string): JobWithStages[] {
  const key = pathKey(cwd);
  return listJobs().filter((j) => pathKey(j.projectCwd) === key);
}

export function listJobsByStatus(...statuses: JobStatus[]): Job[] {
  if (statuses.length === 0) return [];
  const placeholders = statuses.map(() => '?').join(',');
  const rows = getDatabase()
    .prepare(`SELECT * FROM jobs WHERE status IN (${placeholders}) ORDER BY created_at`)
    .all(...statuses) as JobRow[];
  return rows.map(toJob);
}

export interface JobPatch {
  status?: JobStatus;
  stage?: StageName | null;
  gate?: GateName | null;
  approvedGate?: GateName | null;
  parkReason?: ParkReason | null;
  detail?: string | null;
  worktreePath?: string | null;
  branch?: string | null;
  baseBranch?: string | null;
  mergeSha?: string | null;
  pendingAnswer?: string | null;
  claudeSessionId?: string | null;
}

const COLUMN_OF: Record<keyof JobPatch, string> = {
  status: 'status',
  stage: 'stage',
  gate: 'gate',
  approvedGate: 'approved_gate',
  parkReason: 'park_reason',
  detail: 'detail',
  worktreePath: 'worktree_path',
  branch: 'branch',
  baseBranch: 'base_branch',
  mergeSha: 'merge_sha',
  pendingAnswer: 'pending_answer',
  claudeSessionId: 'claude_session_id',
};

/** Patch a job. Only the provided fields change; updated_at always does. */
export function updateJob(id: string, patch: JobPatch): Job | null {
  const entries = (Object.keys(patch) as (keyof JobPatch)[]).filter(
    (k) => patch[k] !== undefined
  );
  const sets = entries.map((k) => `${COLUMN_OF[k]} = ?`);
  const values = entries.map((k) => patch[k] as string | null);

  sets.push('updated_at = ?');
  values.push(new Date().toISOString());

  getDatabase()
    .prepare(`UPDATE jobs SET ${sets.join(', ')} WHERE id = ?`)
    .run(...values, id);
  jobEvents.emitChange();
  return getJob(id);
}

export interface StagePatch {
  status?: StageStatus;
  detail?: string | null;
  startedAt?: string | null;
  spawnedAt?: string | null;
  finishedAt?: string | null;
}

export function updateStage(jobId: string, name: StageName, patch: StagePatch): void {
  const sets: string[] = [];
  const values: (string | null)[] = [];
  if (patch.status !== undefined) {
    sets.push('status = ?');
    values.push(patch.status);
  }
  if (patch.detail !== undefined) {
    sets.push('detail = ?');
    values.push(patch.detail);
  }
  if (patch.startedAt !== undefined) {
    sets.push('started_at = ?');
    values.push(patch.startedAt);
  }
  if (patch.spawnedAt !== undefined) {
    sets.push('spawned_at = ?');
    values.push(patch.spawnedAt);
  }
  if (patch.finishedAt !== undefined) {
    sets.push('finished_at = ?');
    values.push(patch.finishedAt);
  }
  if (sets.length === 0) return;

  getDatabase()
    .prepare(`UPDATE job_stages SET ${sets.join(', ')} WHERE job_id = ? AND name = ?`)
    .run(...values, jobId, name);
  // Covers startStage and finishStage too — both route through here.
  jobEvents.emitChange();
}

/**
 * Add one completed run's usage to a stage.
 *
 * Adds rather than replaces: `qa` runs a pass per flow, `fix` can run more than
 * once, and retrying a stage genuinely costs again — so every run that reported
 * an envelope belongs in the total. `run_count` increments with it, which is
 * what tells "no run" apart from "a run that cost nothing".
 *
 * Never throws: accounting must not be able to break a pipeline stage.
 */
export function addStageUsage(
  jobId: string,
  name: StageName,
  usage: Omit<StageUsage, 'runCount'>
): void {
  try {
    getDatabase()
      .prepare(
        `UPDATE job_stages
            SET input_tokens = input_tokens + ?,
                output_tokens = output_tokens + ?,
                cache_read_tokens = cache_read_tokens + ?,
                cache_creation_tokens = cache_creation_tokens + ?,
                cost_usd = cost_usd + ?,
                run_count = run_count + 1
          WHERE job_id = ? AND name = ?`
      )
      .run(
        Math.round(usage.inputTokens),
        Math.round(usage.outputTokens),
        Math.round(usage.cacheReadTokens),
        Math.round(usage.cacheCreationTokens),
        usage.costUsd,
        jobId,
        name
      );
    jobEvents.emitChange();
  } catch {
    // A job whose row has gone (cancelled and deleted mid-run) is the expected
    // case here, and it is not worth failing the stage over.
  }
}

/**
 * Mark a stage running and stamp its start.
 *
 * `spawnedAt` is deliberately cleared: a stage that is re-run (an answered
 * question, a retry) would otherwise inherit the previous run's spawn time and
 * report itself as executing before its process exists.
 */
export function startStage(jobId: string, name: StageName): void {
  updateStage(jobId, name, {
    status: 'running',
    detail: null,
    startedAt: new Date().toISOString(),
    spawnedAt: null,
    finishedAt: null,
  });
}

/** Stamp the moment this stage's agent process actually started. */
export function markStageSpawned(jobId: string, name: StageName): void {
  updateStage(jobId, name, { spawnedAt: new Date().toISOString() });
}

/** Mark a stage finished with an outcome and optional explanation. */
export function finishStage(
  jobId: string,
  name: StageName,
  status: StageStatus,
  detail?: string | null
): void {
  updateStage(jobId, name, {
    status,
    ...(detail !== undefined ? { detail } : {}),
    finishedAt: new Date().toISOString(),
  });
}

/** Remove a job and (via cascade) its stages. */
export function deleteJob(id: string): boolean {
  const info = getDatabase().prepare('DELETE FROM jobs WHERE id = ?').run(id);
  if (info.changes > 0) jobEvents.emitChange();
  return info.changes > 0;
}
