/**
 * Types and pure formatting helpers shared by the job board.
 *
 * Mirrors src/server/jobs/types.ts. Jobs are polled rather than pushed while a
 * job is live; a parked job changes only when the user acts on it, so polling
 * stops as soon as nothing is running.
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

export type JobStatus = 'queued' | 'running' | 'parked' | 'done' | 'failed' | 'cancelled';
export type StageStatus =
  | 'pending'
  | 'running'
  | 'passed'
  | 'skipped'
  | 'failed'
  | 'needs_decision';
export type ParkReason = 'gate' | 'question';

/** Mirrors StageUsage in src/server/jobs/types.ts. */
export interface StageUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  costUsd: number;
  runCount: number;
  /** Some tokens came from a model the server's price table does not know. */
  unpriced?: boolean;
}

/** Mirrors ProjectUsage in src/server/usage/store.ts. */
export interface ProjectUsage {
  total: StageUsage;
  pipeline: StageUsage;
  background: StageUsage;
  sessions: StageUsage;
}

const ZERO_USAGE: StageUsage = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheCreationTokens: 0,
  costUsd: 0,
  runCount: 0,
};

/**
 * Anything to show. A job can have tokens and no run: a Take over spends in a
 * terminal, outside any pipeline run, and still belongs to the job.
 */
export function hasSpend(usage: StageUsage): boolean {
  return (
    usage.runCount > 0 ||
    usage.inputTokens + usage.outputTokens + usage.cacheReadTokens + usage.cacheCreationTokens > 0
  );
}

export function formatTokens(n: number): string {
  if (n < 1000) return String(Math.round(n));
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

/**
 * Cost is the headline because a token total is not a meaningful one: cache
 * reads dwarf real input and output, so "31k tokens" reads as effort when it
 * is mostly the cache doing its job.
 */
export function formatCost(usd: number): string {
  if (usd <= 0) return '$0.00';
  if (usd < 0.01) return '<$0.01';
  return `$${usd.toFixed(2)}`;
}

/**
 * The headline figure for something that spent: its cost, or "—" when every
 * token came from a model the server cannot price. `formatCost(0)` would read
 * "$0.00" there, claiming free what is merely unknown; the tooltip says why.
 */
export function formatUsageCost(usage: StageUsage): string {
  return usage.unpriced && usage.costUsd === 0 ? '—' : formatCost(usage.costUsd);
}

/**
 * The breakdown behind the headline. Says "est." and names list price on
 * purpose: these runs bill against the Pro/Max subscription, so the figure is
 * what the tokens would cost at API rates, not a charge anyone made.
 */
export function usageTooltip(usage: StageUsage): string {
  if (!hasSpend(usage)) return 'no agent runs';
  const runs =
    usage.runCount > 0 ? `${usage.runCount} run${usage.runCount === 1 ? '' : 's'}` : 'outside any agent run';
  return `${spendSummary(usage)} · ${runs}`;
}

function spendSummary(usage: StageUsage): string {
  const cached = usage.cacheReadTokens + usage.cacheCreationTokens;
  return (
    `est. ${formatCost(usage.costUsd)} at API list price · ` +
    `in ${formatTokens(usage.inputTokens)} · out ${formatTokens(usage.outputTokens)} · ` +
    `cached ${formatTokens(cached)}` +
    (usage.unpriced ? ' · some tokens are from a model with no known price' : '')
  );
}

/**
 * The project total's breakdown: who spent it. Sessions and background runs
 * are counted too, which is why the figure sits in the project header and not
 * beside the Jobs list.
 */
export function projectUsageTooltip(usage: ProjectUsage): string {
  const part = (label: string, u: StageUsage) => `${label} ${formatCost(u.costUsd)}`;
  return (
    `${spendSummary(usage.total)}
` +
    [
      part('pipeline', usage.pipeline),
      part('sessions', usage.sessions),
      part('background (session log, migration, QA drafts)', usage.background),
    ].join(' · ')
  );
}

/** Tolerates jobs and stages that predate usage accounting. */
export function usageOf(item: { usage?: StageUsage | null }): StageUsage {
  return item.usage ?? ZERO_USAGE;
}

export interface JobStage {
  name: StageName;
  status: StageStatus;
  detail: string | null;
  startedAt: string | null;
  /** When the agent process started; null while the stage is still queued. */
  spawnedAt?: string | null;
  finishedAt: string | null;
  usage?: StageUsage;
}

/**
 * A running stage whose process has not started yet is WAITING, not working.
 *
 * Runs queue per project, so a stage can be admitted and then sit behind
 * another run in the same project. Reporting that as execution is what makes a
 * job look hung: the elapsed time climbs, the stage says "running", and
 * nothing is happening. Stages recorded before this existed have no
 * `spawnedAt` at all and are shown as running, which is what they were.
 */
export function isQueued(stage: JobStage): boolean {
  return stage.status === 'running' && stage.spawnedAt === null;
}

/** How long a stage has been doing what it is currently doing. */
export function elapsedSince(iso: string | null, now = Date.now()): string {
  if (!iso) return '';
  const ms = now - new Date(iso).getTime();
  if (!Number.isFinite(ms) || ms < 0) return '';
  const mins = Math.floor(ms / 60000);
  if (mins < 1) return `${Math.floor(ms / 1000)}s`;
  if (mins < 60) return `${mins}m`;
  return `${Math.floor(mins / 60)}h${mins % 60}m`;
}

export interface Job {
  id: string;
  projectCwd: string;
  featureId: string | null;
  title: string;
  status: JobStatus;
  stage: StageName | null;
  gate: string | null;
  approvedGate: string | null;
  parkReason: ParkReason | null;
  detail: string | null;
  worktreePath: string | null;
  branch: string | null;
  /** The branch this job forked from, and the one its merge lands on. */
  baseBranch: string | null;
  claudeSessionId: string | null;
  createdAt: string;
  updatedAt: string;
  stages: JobStage[];
  /** Sum over this job's stages; absent on jobs served by an older server. */
  usage?: StageUsage;
}

export const STAGE_ICON: Record<StageStatus, string> = {
  pending: '·',
  running: '◐',
  passed: '✓',
  skipped: '−',
  failed: '✕',
  // Deliberately not a tick: the stage ran but is waiting on the user.
  needs_decision: '?',
};

export type Severity = 'critical' | 'important' | 'nice';

export interface Finding {
  id: string;
  severity: Severity;
  file: string;
  line: number | null;
  title: string;
  detail: string;
  suggestion: string;
  selected: boolean;
}

export interface DiffStat {
  files: number;
  insertions: number;
  deletions: number;
}

/**
 * A POST that carries no body.
 *
 * Deliberately sends no Content-Type: Fastify rejects an `application/json`
 * request with an empty body as 400 before the route is ever reached, so
 * declaring a body the request does not have turned every bodyless action
 * (retry, approve, cancel, discard) into "Bad Request".
 */
export const BODYLESS_POST = { method: 'POST' as const };

export function jsonPost(body: Record<string, unknown>) {
  return {
    method: 'POST' as const,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  };
}
