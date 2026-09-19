/**
 * A job is one feature carried through the pipeline in an isolated worktree.
 *
 * The pipeline stops at three gates for approval — after design (so the planned
 * changes are agreed before any code is written), after review (so only the
 * findings worth acting on are applied), and before merge. Between gates it
 * runs unattended; on approval at the final gate it merges, commits, pushes
 * where there is a remote, and removes its worktree.
 */

export type StageName =
  | 'design'
  | 'implement'
  | 'integrate'
  | 'review'
  | 'fix'
  | 'qa'
  | 'merge'
  | 'rebuild';

/** Stages in execution order. A job advances through exactly this sequence. */
export const STAGE_ORDER: StageName[] = [
  'design',
  'implement',
  'integrate',
  'review',
  'fix',
  'qa',
  'merge',
  'rebuild',
];

/**
 * Gates, keyed by the stage they follow. A job that completes a gated stage
 * parks instead of advancing, until the user approves.
 */
export type GateName = 'design' | 'review' | 'merge';

export const GATE_AFTER: Partial<Record<StageName, GateName>> = {
  design: 'design',
  review: 'review',
  // The merge gate precedes the merge stage rather than following it: approval
  // is what authorises the merge, so it is checked before the stage runs.
};

/** Stages that must not start without explicit approval. */
export const GATE_BEFORE: Partial<Record<StageName, GateName>> = {
  merge: 'merge',
};

export type JobStatus =
  | 'queued' // waiting for the scheduler to admit it
  | 'running' // a stage is executing
  | 'parked' // waiting at a gate, or on an open question
  | 'done' // merged (or completed without merging) and torn down
  | 'failed' // a stage failed hard; worktree retained for inspection
  | 'cancelled'; // user abandoned it

export type StageStatus =
  | 'pending'
  | 'running'
  | 'passed'
  | 'skipped'
  | 'failed'
  /**
   * The stage ran, could not settle a decision, and stopped rather than guess.
   * Distinct from 'passed' because the pipeline strip must not show a tick
   * beside a job that is waiting on the user, and distinct from 'failed'
   * because nothing went wrong.
   */
  | 'needs_decision';

/** Why a job is parked — distinguishes "waiting for you" from "needs an answer". */
export type ParkReason = 'gate' | 'question';

export interface Job {
  id: string;
  projectCwd: string;
  /** Feature id in PROJECT.md this job implements; null for ad-hoc jobs. */
  featureId: string | null;
  title: string;
  status: JobStatus;
  /** The stage currently running, or the one the job is parked before/after. */
  stage: StageName | null;
  gate: GateName | null;
  /**
   * The gate the user has already approved. Kept separate from `gate` because
   * the merge gate is checked BEFORE its stage runs: clearing `gate` on
   * approval would make the stage park again immediately.
   */
  approvedGate: GateName | null;
  parkReason: ParkReason | null;
  /** Free text shown on the board: skip reason, failure summary, open question. */
  detail: string | null;
  worktreePath: string | null;
  branch: string | null;
  /**
   * The branch this job branched from. Recorded once at worktree creation:
   * re-deriving it from the project's current branch later means a job rebases
   * and merges against whatever happens to be checked out at the time.
   */
  baseBranch: string | null;
  /**
   * An answer supplied for a parked question, consumed by the stage that asked.
   * Persisted because a job may sit parked for days across restarts.
   */
  pendingAnswer: string | null;
  /**
   * Claude session id of the most recent stage run, so the user can take over
   * that exact conversation interactively instead of restarting it.
   */
  claudeSessionId: string | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * What a stage (or a whole job) spent.
 *
 * Counts stay SPLIT, never summed: cache traffic dwarfs real input and output,
 * so "N tokens" would measure the cache rather than the work. `costUsd` is the
 * run's `total_cost_usd` — API list price, not money charged, since these bill
 * against the subscription. The UI must keep labelling it as an estimate.
 */
export interface StageUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  costUsd: number;
  /** Completed agent runs that reported usage. 0 means the stage ran none. */
  runCount: number;
}

export const ZERO_USAGE: StageUsage = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheCreationTokens: 0,
  costUsd: 0,
  runCount: 0,
};

export function addUsage(a: StageUsage, b: StageUsage): StageUsage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
    cacheCreationTokens: a.cacheCreationTokens + b.cacheCreationTokens,
    costUsd: a.costUsd + b.costUsd,
    runCount: a.runCount + b.runCount,
  };
}

export function sumUsage(items: { usage: StageUsage }[]): StageUsage {
  return items.reduce((acc, item) => addUsage(acc, item.usage), ZERO_USAGE);
}

export interface JobStage {
  id: number;
  jobId: string;
  name: StageName;
  status: StageStatus;
  detail: string | null;
  /** When the stage was admitted — it may wait in its project's run queue. */
  startedAt: string | null;
  /**
   * When this stage's agent process actually started, or null while it is
   * still queued. The gap between the two is wait, not work, and a board that
   * shows it as work is how a job behind another one looks hung.
   */
  spawnedAt: string | null;
  finishedAt: string | null;
  usage: StageUsage;
}

/** A job plus its per-stage rows, which is what the board renders. */
export interface JobWithStages extends Job {
  stages: JobStage[];
  /** Sum over this job's stages — derived, never stored. */
  usage: StageUsage;
}

/** The next stage after `stage`, or null when the pipeline is complete. */
export function nextStage(stage: StageName | null): StageName | null {
  if (stage === null) return STAGE_ORDER[0];
  const index = STAGE_ORDER.indexOf(stage);
  if (index === -1 || index === STAGE_ORDER.length - 1) return null;
  return STAGE_ORDER[index + 1];
}

/** True when a job is in a state the user can still act on. */
export function isLive(status: JobStatus): boolean {
  return status === 'queued' || status === 'running' || status === 'parked';
}
