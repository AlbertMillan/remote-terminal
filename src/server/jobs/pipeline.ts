import { createLogger } from '../utils/logger.js';
import { findWorkspaceProject } from '../projects/workspace.js';
import { capabilitiesFor, detectVcs } from '../projects/vcs.js';
import { admit } from './scheduler.js';
import {
  createJob,
  finishStage,
  getJob,
  markStageSpawned,
  getJobWithStages,
  listJobsByStatus,
  startStage,
  updateJob,
} from './store.js';
import {
  commitAll,
  createWorktree,
  currentBranch,
  removeWorktree,
  WorktreeError,
} from './worktree.js';
import { runDesignStage } from './stages/design.js';
import { runImplementStage } from './stages/implement.js';
import { runIntegrateStage } from './stages/integrate.js';
import { runMergeStage } from './stages/merge.js';
import { runReviewStage } from './stages/review.js';
import { runFixStage } from './stages/fix.js';
import { runQaStage } from './stages/qa.js';
import { runRebuildStage } from './stages/rebuild.js';
import {
  ensureTrackBranch,
  findActiveTrackBranchByName,
  isTrackBranch,
  trackOfFeature,
  TrackBranchError,
} from '../projects/track-branches.js';
import { withProjectLock } from '../projects/project-lock.js';
import { isProcessRunning } from '../utils/platform.js';
import type { RunTag } from '../agent/claude-run.js';
import { readFindings, selectedFindings } from './findings.js';
import {
  GATE_AFTER,
  GATE_BEFORE,
  isLive,
  nextStage,
  STAGE_ORDER,
  type Job,
  type StageName,
} from './types.js';
import { JobError } from './errors.js';
import { inFlight } from './in-flight.js';

const logger = createLogger('job-runner');

/**
 * What a stage needs to take its turn in the queue, report when it gets one,
 * and have its spend attributed.
 *
 * The lane is the PROJECT, which is what makes the scheduler's promise true all
 * the way down: it admits one job per project, and now their agent runs no
 * longer serialise behind one another across projects. A stage of project A
 * waiting on project B's run was invisible — the stage is marked running when
 * it is admitted, minutes before its process exists — so the spawn is stamped
 * as well, and the board reads the two apart.
 *
 * The tag records each run under this job and stage before it spawns, so the
 * usage ledger attributes its transcript even if the stage parks, fails or is
 * killed — cases where a return value never arrives.
 */
function runLane(job: Job, stage: StageName): { laneKey: string; onSpawn: () => void; tag: RunTag } {
  return {
    laneKey: job.projectCwd,
    onSpawn: () => markStageSpawned(job.id, stage),
    tag: { projectCwd: job.projectCwd, kind: 'stage', jobId: job.id, stage },
  };
}

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
 * Drives jobs through the pipeline.
 *
 * The runner is a pump rather than a loop: every event that could unblock
 * something (a job created, a stage finished, a gate approved) calls `pump()`,
 * which asks the scheduler what may start and kicks those off. Jobs parked at a
 * gate simply aren't candidates, so a job can sit for days without occupying
 * anything.
 */

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
    const aborter = new AbortController();
    // Detached: a stage can take minutes, and the caller (an HTTP request) must
    // not wait for it. The promise is retained so cancelJob can await the stage
    // actually unwinding before it touches the worktree.
    const run = runNextStage(job.id, aborter.signal).finally(() => {
      inFlight.delete(job.id);
      // A finished stage may have freed this project's slot.
      void pump();
    });
    inFlight.set(job.id, { aborter, run });
  }
}

/**
 * Execute the job's next stage, then either park at a gate or leave it queued
 * for the following stage.
 */
async function runNextStage(jobId: string, signal?: AbortSignal): Promise<void> {
  const job = getJob(jobId);
  if (!job || !isLive(job.status)) return;

  const stage = nextStage(job.stage);
  if (!stage) {
    updateJob(jobId, { status: 'done', stage: null, gate: null, parkReason: null });
    return;
  }

  // Some gates precede their stage rather than follow it: approval is what
  // authorises the merge, so it must be checked before anything is merged.
  // `stage` is deliberately left pointing at the last COMPLETED stage while
  // parked, so nextStage() still resolves to the gated stage on approval.
  const gateBefore = GATE_BEFORE[stage];
  if (gateBefore && job.approvedGate !== gateBefore) {
    // `detail` is deliberately NOT cleared: the previous stage may have left a
    // warning here ("QA incomplete: the Unity Editor was not running"), and the
    // merge gate is precisely where that needs to be read.
    updateJob(jobId, {
      status: 'parked',
      gate: gateBefore,
      parkReason: 'gate',
    });
    logger.info({ jobId, gate: gateBefore }, 'job: parked before a gated stage');
    return;
  }

  updateJob(jobId, { status: 'running', stage, detail: null });
  startStage(jobId, stage);
  logger.info({ jobId, stage }, 'job: stage starting');

  try {
    switch (stage) {
      case 'design':
        await executeDesign(job, signal);
        break;
      case 'implement':
        await executeImplement(job, signal);
        break;
      case 'integrate':
        await executeIntegrate(job);
        break;
      case 'review':
        await executeReview(job, signal);
        break;
      case 'fix':
        await executeFix(job, signal);
        break;
      case 'qa':
        await executeQa(job, signal);
        break;
      case 'merge':
        await executeMerge(job);
        break;
      case 'rebuild':
        await executeRebuild(job);
        break;
      default:
        // Stages that land in later commits are skipped rather than parked on,
        // so the merge gate stays reachable. This is NOT silent: the stage row
        // reads "skipped — not implemented yet" in the pipeline strip, so the
        // user can see exactly which checks did not run before they approve a
        // merge. Skipping is deliberately never used for a stage that exists
        // and failed.
        finishStage(jobId, stage, 'skipped', 'Not implemented yet');
        updateJob(jobId, { status: 'queued', stage, detail: null });
        void pump();
        return;
    }
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    // This is the one terminal write that used to run unguarded, and it is what
    // made mid-stage cancellation unsafe: cancelJob marks the job `cancelled` and
    // aborts the run, the abort surfaces here as a rejection, and without this
    // check the job the user just cancelled would be rewritten as `failed`.
    // Every other terminal write in this file is already guarded the same way.
    if (!stillLive(jobId)) {
      logger.info({ jobId, stage }, 'job: stage unwound after cancellation');
      return;
    }
    logger.warn({ jobId, stage, err: detail }, 'job: stage failed');
    finishStage(jobId, stage, 'failed', detail);
    // Worktree is deliberately retained on failure so the run can be inspected
    // and taken over rather than vanishing with the evidence.
    updateJob(jobId, { status: 'failed', stage, detail });
    return;
  }
}

/** Design stage: create the worktree if needed, write the spec, park at gate 1. */
async function executeDesign(job: Job, signal?: AbortSignal): Promise<void> {
  let worktreePath = job.worktreePath;
  let branch = job.branch;

  if (!worktreePath) {
    try {
      const created = await createWorktree(job.projectCwd, job.id, job.title, {
        base: (await trackBaseFor(job)) ?? undefined,
      });
      worktreePath = created.path;
      branch = created.branch;
      updateJob(job.id, {
        worktreePath: created.path,
        branch: created.branch,
        baseBranch: created.baseBranch,
        detail: created.initialisedRepo
          ? 'Initialised a git repo for this project — work is committed locally and never pushed.'
          : null,
      });
    } catch (error) {
      if (error instanceof WorktreeError || error instanceof TrackBranchError) {
        throw new JobError(error.message, error.status);
      }
      throw error;
    }
  }

  // Consume any answer the user gave to a previous pass's question.
  const answer = job.pendingAnswer;
  if (answer) updateJob(job.id, { pendingAnswer: null });

  const result = await runDesignStage({
    job,
    worktreePath,
    answer,
    // Continue the conversation that asked, rather than starting one that has
    // to rediscover the repository to apply a one-line answer.
    resumeSessionId: job.claudeSessionId,
    signal,
    ...runLane(job, 'design'),
  });

  if (result.claudeSessionId) {
    updateJob(job.id, { claudeSessionId: result.claudeSessionId });
  }

  // Keep the spec out of the working tree's uncommitted noise.
  await commitAll(worktreePath, `design: spec for ${job.title}`);

  if (result.openQuestion) {
    // A question the design pass could not settle. Park on it rather than let
    // it guess — this is the whole point of the gate.
    //
    // The spec path is recorded even here, so the board can show the document
    // the question is about. It is safe to do so because what gates implement
    // is the stage's STATUS, not whether this field looks like a path.
    parkOnQuestion(job, 'design', result.openQuestion, result.specPath);
    return;
  }

  if (!stillLive(job.id)) return;
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

/**
 * The spec path recorded by the design stage, needed by implement.
 *
 * The `passed` check is the guard that stops implement building off a spec the
 * user never approved, and it is the ONLY thing standing there: a design that
 * parked on a question records its spec path too (so the board can show the
 * document being asked about), so the two states are no longer told apart by
 * what this field happens to contain.
 */
function specPathOf(jobId: string): string | null {
  const stages = getJobWithStages(jobId)?.stages ?? [];
  const design = stages.find((s) => s.name === 'design');
  return design?.status === 'passed' ? design.detail : null;
}

/** Guard the stages that cannot run without a worktree. */
function requireWorktree(job: Job): string {
  if (!job.worktreePath) {
    throw new Error('This job has no worktree — re-run it from the design stage.');
  }
  return job.worktreePath;
}

/**
 * The branch this job's work is measured and merged against.
 *
 * Recorded on the job when its worktree was created. Falling back to the
 * project's CURRENT branch would mean a job that sat parked while you switched
 * branches silently rebases and diffs against the wrong base — so the fallback
 * only applies to jobs created before the column existed.
 */
async function baseBranchOf(job: Job): Promise<string> {
  if (job.baseBranch) return job.baseBranch;
  const fallback = (await currentBranch(job.projectCwd)) || 'main';
  logger.warn(
    { jobId: job.id, fallback },
    'job: no recorded base branch, falling back to the current branch'
  );
  return fallback;
}

/** Implement stage: build the approved spec, then continue to integrate. */
async function executeImplement(job: Job, signal?: AbortSignal): Promise<void> {
  const worktreePath = requireWorktree(job);
  const specPath = specPathOf(job.id);
  if (!specPath) throw new Error('No approved spec found for this job');

  // Consume the answer to a question THIS stage parked on. It used to be
  // recorded on the job and read by nobody, so answering an implement question
  // re-ran the identical prompt into the same wall.
  const answer = job.pendingAnswer;
  if (answer) updateJob(job.id, { pendingAnswer: null });

  const result = await runImplementStage({
    job,
    worktreePath,
    specPath,
    baseBranch: await baseBranchOf(job),
    answer,
    resumeSessionId: job.claudeSessionId,
    signal,
    ...runLane(job, 'implement'),
  });

  if (result.claudeSessionId) updateJob(job.id, { claudeSessionId: result.claudeSessionId });

  if (result.openQuestion) {
    // The spec turned out to be unworkable. Park rather than let the run
    // improvise a design the user never approved.
    parkOnQuestion(job, 'implement', result.openQuestion, 'the approved spec does not hold');
    return;
  }

  const { files, insertions, deletions } = result.stat;
  if (!stillLive(job.id)) return;
  finishStage(job.id, 'implement', 'passed', `${files} files +${insertions}/-${deletions}`);
  // No gate here: implement flows straight into integrate so the diff the user
  // eventually reviews is already rebased onto current base.
  updateJob(job.id, { status: 'queued', stage: 'implement', detail: null });
  void pump();
}

/** Integrate stage: rebase onto the base branch so the diff reflects reality. */
async function executeIntegrate(job: Job): Promise<void> {
  const worktreePath = requireWorktree(job);
  const baseBranch = await baseBranchOf(job);
  const result = await runIntegrateStage({ worktreePath, baseBranch });

  if (result.outcome === 'conflict') {
    // Two changes disagree about the same lines. Deciding which wins is exactly
    // the kind of call that should reach a person. Answering re-attempts the
    // rebase — which is what you want once you have resolved it via Take over.
    parkOnQuestion(
      job,
      'integrate',
      `${result.detail}. Take over to resolve it in the worktree and then continue, ` +
        `or cancel this job and re-dispatch it against the current base.`,
      result.detail ?? undefined
    );
    return;
  }

  finishStage(
    job.id,
    'integrate',
    'passed',
    result.outcome === 'already-current' ? `already current with ${baseBranch}` : `rebased onto ${baseBranch}`
  );
  if (!stillLive(job.id)) return;
  updateJob(job.id, { status: 'queued', stage: 'integrate', detail: null });
  void pump();
}

/** Review stage: run the user's criteria over the diff, then park at gate 2. */
async function executeReview(job: Job, signal?: AbortSignal): Promise<void> {
  const worktreePath = requireWorktree(job);
  const result = await runReviewStage({
    jobId: job.id,
    worktreePath,
    baseBranch: await baseBranchOf(job),
    specPath: specPathOf(job.id),
    signal,
    ...runLane(job, 'review'),
  });

  if (result.claudeSessionId) updateJob(job.id, { claudeSessionId: result.claudeSessionId });

  // Findings are scratch, but committing them would dirty the worktree and
  // confuse the merge diff, so the gitignore rule added by the stage handles it.
  // Commit the gitignore rule the stage may have added, so the worktree stays
  // clean and the rule lands with the merge.
  await commitAll(worktreePath, 'chore: ignore job review findings');

  if (!stillLive(job.id)) return;
  const count = result.findings?.findings.length ?? 0;
  finishStage(job.id, 'review', 'passed', result.summary);

  if (count === 0) {
    // Nothing to choose between. Parking here would ask the user to approve an
    // empty list, so flow straight on — the stage row still says "no findings".
    updateJob(job.id, { status: 'queued', stage: 'review', detail: null });
    void pump();
    return;
  }

  updateJob(job.id, {
    status: 'parked',
    stage: 'review',
    gate: 'review',
    parkReason: 'gate',
    detail: `${count} finding${count === 1 ? '' : 's'} — choose which to act on.`,
  });
  logger.info({ jobId: job.id, count }, 'job: parked at the review gate');
}

/** Fix stage: apply exactly the findings the user ticked. */
async function executeFix(job: Job, signal?: AbortSignal): Promise<void> {
  const worktreePath = requireWorktree(job);
  const findings = readFindings(worktreePath, job.id);
  const selected = selectedFindings(findings);

  if (selected.length === 0) {
    // The user reviewed the findings and chose none. That is a decision, not an
    // omission, so record it rather than treating the stage as unfinished.
    finishStage(job.id, 'fix', 'skipped', 'no findings selected');
    updateJob(job.id, { status: 'queued', stage: 'fix', detail: null });
    void pump();
    return;
  }

  const skipped = (findings?.findings ?? []).filter((f) => !f.selected);
  const result = await runFixStage({
    jobId: job.id,
    worktreePath,
    baseBranch: await baseBranchOf(job),
    selected,
    skipped,
    title: job.title,
    signal,
    ...runLane(job, 'fix'),
  });

  if (result.claudeSessionId) updateJob(job.id, { claudeSessionId: result.claudeSessionId });

  const applied = selected.length - result.unresolved.length;
  const detail =
    result.unresolved.length > 0
      ? `${applied}/${selected.length} applied — unresolved: ${result.unresolved.join('; ')}`
      : `${selected.length} applied (${result.stat.files} files +${result.stat.insertions}/-${result.stat.deletions})`;

  // An unresolved finding is not a stage failure — the run said so honestly and
  // the user sees it before the merge gate. Mark it skipped so it reads as
  // "something did not happen" rather than "everything was fine".
  if (!stillLive(job.id)) return;
  finishStage(job.id, 'fix', result.unresolved.length > 0 ? 'skipped' : 'passed', detail);
  updateJob(job.id, { status: 'queued', stage: 'fix', detail: null });
  void pump();
}

/**
 * QA stage: run the project's declared checks.
 *
 * A QA failure does not fail the JOB. The merge gate is the next stop and the
 * user decides there — so the right behaviour is to carry the red result
 * forward where they will see it, not to bury the work in a failed job. What
 * must never happen is the opposite: an unrun check reported as a pass.
 */
async function executeQa(job: Job, signal?: AbortSignal): Promise<void> {
  const worktreePath = requireWorktree(job);
  const result = await runQaStage({
    jobId: job.id,
    worktreePath,
    isProcessRunning,
    signal,
    ...runLane(job, 'qa'),
  });

  if (result.claudeSessionId) updateJob(job.id, { claudeSessionId: result.claudeSessionId });

  const skipped = result.checks.filter((c) => c.status === 'skipped');
  const failed = result.checks.filter((c) => c.status === 'failed');

  // Put the reason on the stage row itself, so the board can explain a skip
  // rather than just showing a dash.
  const detailParts = [result.summary];
  for (const check of [...failed, ...skipped]) {
    if (check.detail) detailParts.push(`${check.name}: ${check.detail.split('\n')[0]}`);
  }

  if (!stillLive(job.id)) return;
  finishStage(job.id, 'qa', result.outcome, detailParts.join(' | ').slice(0, 500));
  updateJob(job.id, {
    status: 'queued',
    stage: 'qa',
    // Surfaced at the merge gate, which is where it matters.
    detail:
      failed.length > 0
        ? `QA failed: ${result.summary}`
        : skipped.length > 0
          ? `QA incomplete: ${skipped.map((c) => c.detail).filter(Boolean).join(' ')}`
          : null,
  });
  void pump();
}

/**
 * The branch a feature's job starts from: its track's branch, created now if
 * the track has none yet. Dispatch is one of the points where a track's
 * implementation begins, and work that lands in the track branch is what
 * Delete track can later remove as a unit. Ad-hoc jobs (no feature) and
 * features no longer in PROJECT.md keep branching from the current branch.
 */
async function trackBaseFor(job: Job): Promise<string | null> {
  if (!job.featureId) return null;
  const project = findWorkspaceProject(job.projectCwd);
  if (!project) return null;
  const track = trackOfFeature(project, job.featureId);
  if (!track) return null;
  return (await ensureTrackBranch(project, track)).branch;
}

/** Merge stage: runs only after the merge gate; lands and pushes the work. */
async function executeMerge(job: Job): Promise<void> {
  if (!job.branch) throw new Error('This job has no branch to merge');
  const baseBranch = await baseBranchOf(job);
  const merge = (mergeCwd?: string) =>
    runMergeStage({
      projectCwd: job.projectCwd,
      branch: job.branch as string,
      baseBranch,
      title: job.title,
      jobId: job.id,
      featureId: job.featureId,
      mergeCwd,
    });

  // Into a track branch: that branch is checked out in the track's worktree,
  // not the project, and the merge must not interleave with a Land or Delete
  // of the same track. The lock is try-only (project-lock.ts): if it is taken
  // this stage fails with the reason and can be retried.
  const result = isTrackBranch(job.projectCwd, baseBranch)
    ? await withProjectLock(job.projectCwd, `merging "${job.title}"`, async () => {
        const track = findActiveTrackBranchByName(job.projectCwd, baseBranch);
        if (!track) {
          throw new Error(
            `This job's track branch ${baseBranch} is gone — its track was landed or deleted while the job waited.`
          );
        }
        return merge(track.worktreePath);
      })
    : await merge();

  // No stillLive() guard here: the merge has already landed in the repo, so
  // recording it is mandatory even if the job was cancelled mid-merge.
  finishStage(
    job.id,
    'merge',
    'passed',
    result.pushed ? `merged into ${baseBranch} and pushed` : `merged into ${baseBranch}`
  );

  // The work has landed, so the worktree and branch have served their purpose.
  await removeWorktree(job.projectCwd, job.id, { deleteBranch: job.branch });
  updateJob(job.id, {
    status: 'queued',
    stage: 'merge',
    worktreePath: null,
    gate: null,
    detail: result.detail,
    mergeSha: result.mergeSha,
  });
  void pump();
}

/**
 * Rebuild stage: tick the feature off in PROJECT.md now the work has landed.
 *
 * Runs after the merge, so it writes to the project directory rather than the
 * worktree — which no longer exists by this point.
 */
async function executeRebuild(job: Job): Promise<void> {
  const project = findWorkspaceProject(job.projectCwd);
  if (!project) {
    finishStage(job.id, 'rebuild', 'skipped', 'project is no longer on the board');
    updateJob(job.id, { status: 'queued', stage: 'rebuild' });
    void pump();
    return;
  }

  const result = await runRebuildStage({
    project,
    featureId: job.featureId,
    specPath: specPathOf(job.id),
    title: job.title,
  });

  finishStage(job.id, 'rebuild', result.updated ? 'passed' : 'skipped', result.detail);
  updateJob(job.id, { status: 'queued', stage: 'rebuild' });
  void pump();
}

/**
 * Park a job on a question the stage could not settle.
 *
 * `stage` steps back to the asking stage's PREDECESSOR so that answering
 * re-runs the stage that asked; without it the job restarted from design,
 * discarding an implementation to answer an integrate question. The row is
 * marked `needs_decision`: `passed` would put a tick beside a job waiting on
 * the user, and `failed` would claim something went wrong.
 */
function parkOnQuestion(job: Job, stage: StageName, question: string, stageDetail?: string): void {
  if (!stillLive(job.id)) return;
  finishStage(job.id, stage, 'needs_decision', stageDetail ?? 'Needs a decision');
  updateJob(job.id, {
    status: 'parked',
    stage: stageBefore(stage),
    gate: null,
    parkReason: 'question',
    detail: question,
  });
  logger.info({ jobId: job.id, stage }, 'job: parked on an open question');
}

/** The stage preceding `stage` in pipeline order, or null for the first. */
function stageBefore(stage: StageName): StageName | null {
  const index = STAGE_ORDER.indexOf(stage);
  return index > 0 ? STAGE_ORDER[index - 1] : null;
}

/**
 * True when the job is still the one we started working on.
 *
 * A stage runs for minutes; the user may cancel in the middle of it. Every
 * terminal write checks this first, so a cancellation cannot be overwritten by
 * the stage that was already in flight when it arrived.
 */
function stillLive(jobId: string): boolean {
  const current = getJob(jobId);
  if (current && isLive(current.status)) return true;
  logger.info({ jobId, status: current?.status }, 'job: no longer live, discarding stage result');
  return false;
}
