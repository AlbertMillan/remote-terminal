import { createLogger } from '../utils/logger.js';
import { findWorkspaceProject } from '../projects/workspace.js';
import { capabilitiesFor, detectVcs } from '../projects/vcs.js';
import { admit } from './scheduler.js';
import {
  createJob,
  finishStage,
  getJob,
  getJobWithStages,
  listJobsByStatus,
  startStage,
  updateJob,
} from './store.js';
import { commitAll, createWorktree, removeWorktree, WorktreeError } from './worktree.js';
import { runDesignStage } from './stages/design.js';
import { GATE_AFTER, isLive, nextStage, type Job, type JobWithStages } from './types.js';

const logger = createLogger('job-runner');

export class JobError extends Error {
  constructor(
    message: string,
    readonly status = 400
  ) {
    super(message);
    this.name = 'JobError';
  }
}

/**
 * Drives jobs through the pipeline.
 *
 * The runner is a pump rather than a loop: every event that could unblock
 * something (a job created, a stage finished, a gate approved) calls `pump()`,
 * which asks the scheduler what may start and kicks those off. Jobs parked at a
 * gate simply aren't candidates, so a job can sit for days without occupying
 * anything.
 */

/** Jobs currently executing a stage in this process. */
const inFlight = new Set<string>();

export interface CreateJobOptions {
  cwd: string;
  featureId: string | null;
  title: string;
}

/**
 * Queue a job for a feature. Rejects up front on projects that cannot support
 * isolation, so the failure is a clear message rather than a broken job.
 */
export function queueJob(options: CreateJobOptions): Job {
  const project = findWorkspaceProject(options.cwd);
  if (!project) throw new JobError('Unknown project', 404);

  const caps = capabilitiesFor(detectVcs(project.cwd));
  if (!caps.canDispatch) {
    throw new JobError(caps.note || 'This project does not support dispatch', 409);
  }
  if (!options.title.trim()) throw new JobError('A job title is required');

  const job = createJob({
    projectCwd: project.cwd,
    featureId: options.featureId,
    title: options.title.trim(),
  });
  logger.info({ jobId: job.id, cwd: project.cwd, title: job.title }, 'job: queued');

  void pump();
  return job;
}

/**
 * Admit and start whatever the scheduler allows. Safe to call from anywhere,
 * any number of times; jobs already in flight are never started twice.
 */
export async function pump(): Promise<void> {
  const queued = listJobsByStatus('queued').filter((j) => !inFlight.has(j.id));
  if (queued.length === 0) return;

  const running = listJobsByStatus('running');
  for (const job of admit(queued, running)) {
    if (inFlight.has(job.id)) continue;
    inFlight.add(job.id);
    // Detached: a stage can take minutes, and the caller (an HTTP request) must
    // not wait for it.
    void runNextStage(job.id).finally(() => {
      inFlight.delete(job.id);
      // A finished stage may have freed this project's slot.
      void pump();
    });
  }
}

/**
 * Execute the job's next stage, then either park at a gate or leave it queued
 * for the following stage.
 */
async function runNextStage(jobId: string): Promise<void> {
  const job = getJob(jobId);
  if (!job || !isLive(job.status)) return;

  const stage = nextStage(job.stage);
  if (!stage) {
    updateJob(jobId, { status: 'done', stage: null, gate: null, parkReason: null });
    return;
  }

  updateJob(jobId, { status: 'running', stage, detail: null });
  startStage(jobId, stage);
  logger.info({ jobId, stage }, 'job: stage starting');

  try {
    switch (stage) {
      case 'design':
        await executeDesign(job);
        break;
      default:
        // Later stages land in subsequent commits. Rather than silently
        // skipping them, park so the state is honest about where the pipeline
        // actually stops today.
        finishStage(jobId, stage, 'skipped', 'Stage not implemented yet');
        updateJob(jobId, {
          status: 'parked',
          stage,
          gate: null,
          parkReason: 'gate',
          detail: `Pipeline stops at "${stage}" — that stage is not implemented yet.`,
        });
        return;
    }
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    logger.warn({ jobId, stage, err: detail }, 'job: stage failed');
    finishStage(jobId, stage, 'failed', detail);
    // Worktree is deliberately retained on failure so the run can be inspected
    // and taken over rather than vanishing with the evidence.
    updateJob(jobId, { status: 'failed', stage, detail });
    return;
  }
}

/** Design stage: create the worktree if needed, write the spec, park at gate 1. */
async function executeDesign(job: Job): Promise<void> {
  let worktreePath = job.worktreePath;
  let branch = job.branch;

  if (!worktreePath) {
    try {
      const created = await createWorktree(job.projectCwd, job.id, job.title);
      worktreePath = created.path;
      branch = created.branch;
      updateJob(job.id, {
        worktreePath: created.path,
        branch: created.branch,
        detail: created.initialisedRepo
          ? 'Initialised a git repo for this project — work is committed locally and never pushed.'
          : null,
      });
    } catch (error) {
      if (error instanceof WorktreeError) throw new JobError(error.message, error.status);
      throw error;
    }
  }

  const answer = pendingAnswers.get(job.id) ?? null;
  pendingAnswers.delete(job.id);

  const result = await runDesignStage({ job, worktreePath, answer });

  if (result.claudeSessionId) {
    updateJob(job.id, { claudeSessionId: result.claudeSessionId });
  }

  // Keep the spec out of the working tree's uncommitted noise.
  await commitAll(worktreePath, `design: spec for ${job.title}`);

  if (result.openQuestion) {
    // A question the design pass could not settle. Park on it rather than let
    // it guess — this is the whole point of the gate.
    finishStage(job.id, 'design', 'passed', 'Needs a decision');
    updateJob(job.id, {
      status: 'parked',
      stage: 'design',
      gate: null,
      parkReason: 'question',
      detail: result.openQuestion,
    });
    logger.info({ jobId: job.id }, 'job: parked on an open question');
    return;
  }

  finishStage(job.id, 'design', 'passed', result.specPath);
  const gate = GATE_AFTER.design;
  updateJob(job.id, {
    status: 'parked',
    stage: 'design',
    gate: gate ?? null,
    parkReason: 'gate',
    detail: null,
  });
  logger.info({ jobId: job.id, branch }, 'job: parked at the design gate');
}

/** Answers supplied for a parked question, consumed by the next design pass. */
const pendingAnswers = new Map<string, string>();

/**
 * Approve a gate, letting the job continue to the next stage.
 */
export function approveGate(jobId: string): JobWithStages {
  const job = getJob(jobId);
  if (!job) throw new JobError('Unknown job', 404);
  if (job.status !== 'parked') throw new JobError('This job is not waiting for approval', 409);
  if (job.parkReason === 'question') {
    throw new JobError('This job is waiting for an answer, not approval', 409);
  }

  updateJob(jobId, { status: 'queued', gate: null, parkReason: null, detail: null });
  logger.info({ jobId, gate: job.gate }, 'job: gate approved');
  void pump();
  return getJobWithStages(jobId) as JobWithStages;
}

/**
 * Answer a parked question. The design stage re-runs with the answer, so the
 * spec ends up reflecting the decision rather than the answer living only in a
 * chat message.
 */
export function answerQuestion(jobId: string, answer: string): JobWithStages {
  const job = getJob(jobId);
  if (!job) throw new JobError('Unknown job', 404);
  if (job.parkReason !== 'question') throw new JobError('This job has no open question', 409);
  if (!answer.trim()) throw new JobError('An answer is required');

  pendingAnswers.set(jobId, answer.trim());
  // Re-run the same stage rather than advancing past it.
  updateJob(jobId, {
    status: 'queued',
    stage: null,
    gate: null,
    parkReason: null,
    detail: null,
  });
  logger.info({ jobId }, 'job: question answered, re-running design');
  void pump();
  return getJobWithStages(jobId) as JobWithStages;
}

/** Cancel a job and tear down its worktree. */
export async function cancelJob(jobId: string): Promise<JobWithStages> {
  const job = getJob(jobId);
  if (!job) throw new JobError('Unknown job', 404);
  if (!isLive(job.status)) throw new JobError('This job has already finished', 409);

  updateJob(jobId, { status: 'cancelled', gate: null, parkReason: null });
  if (job.worktreePath) {
    await removeWorktree(job.projectCwd, jobId, { deleteBranch: job.branch });
    updateJob(jobId, { worktreePath: null });
  }
  logger.info({ jobId }, 'job: cancelled');
  void pump();
  return getJobWithStages(jobId) as JobWithStages;
}

/**
 * Reconcile on boot: a job marked `running` cannot still be running, because
 * nothing survived the restart. Re-queue it so the scheduler picks it up, and
 * roll its in-flight stage back to pending so it re-runs cleanly.
 */
export function reconcileJobsOnStartup(): void {
  const stranded = listJobsByStatus('running');
  if (stranded.length === 0) return;

  for (const job of stranded) {
    if (job.stage) {
      finishStage(job.id, job.stage, 'pending', 'Interrupted by a server restart');
    }
    // Step back so the interrupted stage runs again rather than being skipped.
    const previous = previousStageOf(job);
    updateJob(job.id, { status: 'queued', stage: previous, detail: null });
  }
  logger.info({ count: stranded.length }, 'job: re-queued jobs stranded by a restart');
  void pump();
}

/** The stage before the job's current one, so re-running repeats rather than skips. */
function previousStageOf(job: Job): Job['stage'] {
  const stages = getJobWithStages(job.id)?.stages ?? [];
  const index = stages.findIndex((s) => s.name === job.stage);
  return index > 0 ? stages[index - 1].name : null;
}
