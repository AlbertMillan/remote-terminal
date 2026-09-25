import { createLogger } from '../utils/logger.js';
import {
  deleteJob,
  getJob,
  getJobWithStages,
  listJobsByStatus,
  updateJob,
  updateStage,
} from './store.js';
import { removeWorktree } from './worktree.js';
import { JobError } from './errors.js';
import { inFlight } from './in-flight.js';
import { pump } from './pipeline.js';
import { isLive, nextStage, type Job, type JobWithStages } from './types.js';

const logger = createLogger('job-runner');

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

  updateJob(jobId, {
    status: 'queued',
    approvedGate: job.gate,
    gate: null,
    parkReason: null,
    detail: null,
  });
  logger.info({ jobId, gate: job.gate }, 'job: gate approved');
  void pump();
  return getJobWithStages(jobId) as JobWithStages;
}

/**
 * Answer a parked question, re-running the stage that asked it.
 *
 * The answer is stored on the job so it survives a restart and reaches a stage
 * that may not run for minutes. Design and implement fold it into their runs;
 * integrate has nothing to fold it into, so answering there just re-attempts
 * the rebase — which is what you want once Take over has resolved the conflict.
 */
export function answerQuestion(jobId: string, answer: string): JobWithStages {
  const job = getJob(jobId);
  if (!job) throw new JobError('Unknown job', 404);
  if (job.parkReason !== 'question') throw new JobError('This job has no open question', 409);
  if (!answer.trim()) throw new JobError('An answer is required');

  updateJob(jobId, {
    status: 'queued',
    pendingAnswer: answer.trim(),
    gate: null,
    parkReason: null,
    detail: null,
  });
  logger.info({ jobId, stage: nextStage(job.stage) }, 'job: question answered, re-running stage');
  void pump();
  return getJobWithStages(jobId) as JobWithStages;
}

/**
 * Re-run the stage a failed job died on.
 *
 * Stage failures are often transient and fixable from outside — the merge stage
 * refusing a dirty project tree is the obvious case. Without this the only way
 * forward is to cancel and re-dispatch, throwing away a design, an
 * implementation and a review to get past a one-line problem.
 *
 * The failed stage is reset to pending and `stage` steps back to its
 * predecessor, so the pipeline repeats that stage rather than skipping it.
 */
export function retryJob(jobId: string): JobWithStages {
  const job = getJob(jobId);
  if (!job) throw new JobError('Unknown job', 404);
  if (job.status !== 'failed') throw new JobError('Only a failed job can be retried', 409);
  if (!job.stage) throw new JobError('This job has no stage to retry', 409);

  updateStage(jobId, job.stage, {
    status: 'pending',
    detail: null,
    startedAt: null,
    finishedAt: null,
  });
  updateJob(jobId, {
    status: 'queued',
    stage: previousStageOf(job),
    parkReason: null,
    detail: null,
  });
  logger.info({ jobId, stage: job.stage }, 'job: retrying failed stage');
  void pump();
  return getJobWithStages(jobId) as JobWithStages;
}

/**
 * Cancel a live job: stop whatever it is doing and tear down its worktree.
 *
 * The step order below is load-bearing — see `docs/job-pipeline.md`:
 *  1. mark `cancelled` FIRST, or the aborted run's rejection rewrites it as `failed`;
 *  2. abort the run;
 *  3. await the stage unwinding — on Windows `git worktree remove` fails against
 *     files a dying process still holds open;
 *  4. tear down worktree and branch.
 */
export async function cancelJob(jobId: string): Promise<JobWithStages> {
  const job = getJob(jobId);
  if (!job) throw new JobError('Unknown job', 404);
  if (!isLive(job.status)) {
    throw new JobError('This job has already finished — discard it instead', 409);
  }

  updateJob(jobId, { status: 'cancelled', gate: null, parkReason: null });

  const running = inFlight.get(jobId);
  if (running) {
    logger.info({ jobId, stage: job.stage }, 'job: aborting in-flight stage');
    running.aborter.abort();
    // The stage's own error handling never rejects this promise, but a bug there
    // must not strand the cancel with a worktree still on disk.
    await running.run.catch(() => {});
  }

  if (job.worktreePath) {
    await removeWorktree(job.projectCwd, jobId, { deleteBranch: job.branch });
    updateJob(jobId, { worktreePath: null });
  }
  logger.info({ jobId, aborted: Boolean(running) }, 'job: cancelled');
  void pump();
  return getJobWithStages(jobId) as JobWithStages;
}

export interface DiscardResult {
  /** True when the merge stage passed, so its commit is in the base branch to stay. */
  mergeLanded: boolean;
  /** The branch the merge landed on, for the message the UI shows. */
  baseBranch: string | null;
  worktreeRemoved: boolean;
  branchDeleted: boolean;
}

/**
 * Discard a finished job: remove what it left behind and drop it off the board.
 *
 * The counterpart to cancelJob, split by status — see `docs/job-pipeline.md`.
 * Restores the project exactly only for a job that never merged: the merge stage
 * is the one thing a job does outside its worktree. A landed merge is reported,
 * never undone — it may already have been pushed, so `git revert -m 1 <merge>`
 * is the user's call.
 */
export async function discardJob(jobId: string): Promise<DiscardResult> {
  const job = getJobWithStages(jobId);
  if (!job) throw new JobError('Unknown job', 404);
  if (isLive(job.status)) {
    throw new JobError('This job is still active — cancel it before discarding it', 409);
  }

  const mergeLanded = job.stages.some((s) => s.name === 'merge' && s.status === 'passed');

  let worktreeRemoved = false;
  let branchDeleted = false;
  if (job.worktreePath || job.branch) {
    // Deleting the branch is safe either way: if the merge landed, its commits
    // already live in the base branch and only the label goes.
    const torn = await removeWorktree(job.projectCwd, jobId, { deleteBranch: job.branch });
    worktreeRemoved = torn.removed;
    branchDeleted = torn.branchDeleted;
  }

  deleteJob(jobId);
  logger.info(
    { jobId, mergeLanded, worktreeRemoved, branchDeleted },
    'job: discarded'
  );

  return {
    mergeLanded,
    baseBranch: mergeLanded ? job.baseBranch : null,
    worktreeRemoved,
    branchDeleted,
  };
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
      // Not finishStage(): that stamps finishedAt, leaving a stage both pending
      // and finished.
      updateStage(job.id, job.stage, {
        status: 'pending',
        detail: 'Interrupted by a server restart',
        startedAt: null,
        finishedAt: null,
      });
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
