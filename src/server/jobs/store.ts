import { randomUUID } from 'crypto';
import { getDatabase } from '../db/schema.js';
import { pathKey } from '../sessions/project-discovery.js';
import type {
  GateName,
  Job,
  JobStage,
  JobStatus,
  JobWithStages,
  ParkReason,
  StageName,
  StageStatus,
} from './types.js';
import { STAGE_ORDER } from './types.js';

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
  finished_at: string | null;
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
    finishedAt: row.finished_at,
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
  return job ? { ...job, stages: getJobStages(id) } : null;
}

/** All jobs, newest first, with their stages. */
export function listJobs(): JobWithStages[] {
  const rows = getDatabase()
    .prepare('SELECT * FROM jobs ORDER BY created_at DESC')
    .all() as JobRow[];
  return rows.map((row) => ({ ...toJob(row), stages: getJobStages(row.id) }));
}

/** Jobs for one project, newest first. Matching is path-normalized. */
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
  return getJob(id);
}

export interface StagePatch {
  status?: StageStatus;
  detail?: string | null;
  startedAt?: string | null;
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
  if (patch.finishedAt !== undefined) {
    sets.push('finished_at = ?');
    values.push(patch.finishedAt);
  }
  if (sets.length === 0) return;

  getDatabase()
    .prepare(`UPDATE job_stages SET ${sets.join(', ')} WHERE job_id = ? AND name = ?`)
    .run(...values, jobId, name);
}

/** Mark a stage running and stamp its start. */
export function startStage(jobId: string, name: StageName): void {
  updateStage(jobId, name, {
    status: 'running',
    detail: null,
    startedAt: new Date().toISOString(),
    finishedAt: null,
  });
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
  return info.changes > 0;
}
