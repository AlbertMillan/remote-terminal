import { basename } from 'path';
import { pathKey } from '../sessions/project-discovery.js';
import { loadRegistry } from '../projects/registry.js';
import { listLiveAndRecentJobs } from './store.js';
import { STAGE_ORDER, type JobStatus, type StageName, type StageStatus } from './types.js';

/**
 * The compact cross-project job feed behind the live overlay.
 *
 * Built from a filtered job query and the registry only. The roll-up endpoint resolves
 * project names through `getWorkspaceBoard()`, which parses every project's
 * PROJECT.md from disk — fine once per page view, far too heavy to run on every
 * stage transition, and this is pushed on every one of them.
 */

/** How long a finished job stays in the feed, so a client that reconnects still sees it. */
export const RECENT_TERMINAL_MS = 2 * 60 * 1000;

/** Detail is a glance on a card, not the full question; the board shows that. */
const MAX_DETAIL = 240;

export interface JobSummaryStage {
  name: StageName;
  status: StageStatus;
}

export interface JobSummary {
  id: string;
  projectCwd: string;
  /** Resolved exactly as the workspace board resolves it, so the two agree. */
  projectName: string;
  featureId: string | null;
  title: string;
  status: JobStatus;
  stage: StageName | null;
  gate: string | null;
  parkReason: string | null;
  detail: string | null;
  /** All eight stages, in STAGE_ORDER — the strip renders them positionally. */
  stages: JobSummaryStage[];
  costUsd: number;
  createdAt: string;
  updatedAt: string;
}

/**
 * No counts ride along here. The pill counts the cards it is actually showing,
 * and a finished job leaves the panel a minute before it leaves this feed — so
 * a server-side tally would be a second implementation of the same rule,
 * guaranteed to disagree with the one on screen.
 */
export interface JobsSummary {
  jobs: JobSummary[];
}

/**
 * Display names, resolved the way `workspace.ts` does: a registry override if
 * there is one, otherwise the directory basename. Built once per summary so a
 * dozen jobs do not re-read the registry a dozen times.
 */
function nameResolver(): (cwd: string) => string {
  // Built on first use, not up front: the registry is a synchronous file read,
  // and the common summary has no jobs in it at all.
  let overrides: Map<string, string> | null = null;
  return (cwd) => {
    if (!overrides) {
      try {
        overrides = new Map(
          loadRegistry()
            .projects.filter((p) => p.name)
            .map((p) => [pathKey(p.cwd), p.name as string])
        );
      } catch {
        overrides = new Map();
      }
    }
    return overrides.get(pathKey(cwd)) || basename(cwd) || cwd;
  };
}

function truncate(text: string | null): string | null {
  if (!text) return null;
  const clean = text.trim();
  if (!clean) return null;
  return clean.length > MAX_DETAIL ? `${clean.slice(0, MAX_DETAIL - 1)}…` : clean;
}

/**
 * Every live job, plus ones that reached a terminal status recently. The window
 * is applied by the query (see `LIVE_OR_RECENT` in store.ts), not here.
 *
 * This decides how long a finished job is worth SENDING; the client decides how
 * long to show one. A client reconnecting after an hour must not be handed a job
 * that finished 59 minutes ago as news.
 */
export function buildJobsSummary(now: number = Date.now()): JobsSummary {
  const nameOf = nameResolver();
  const since = new Date(now - RECENT_TERMINAL_MS).toISOString();

  const jobs: JobSummary[] = listLiveAndRecentJobs(since).map((job) => {
    // Index the rows so a stage the job has not reached yet still has a slot:
    // the strip is positional, and a missing row must read as pending, not
    // shift every later stage one place to the left.
    const byName = new Map(job.stages.map((s) => [s.name, s.status]));
    return {
      id: job.id,
      projectCwd: job.projectCwd,
      projectName: nameOf(job.projectCwd),
      featureId: job.featureId,
      title: job.title,
      status: job.status,
      stage: job.stage,
      gate: job.gate,
      parkReason: job.parkReason,
      detail: truncate(job.detail),
      stages: STAGE_ORDER.map((name) => ({ name, status: byName.get(name) ?? 'pending' })),
      costUsd: job.usage.costUsd,
      createdAt: job.createdAt,
      updatedAt: job.updatedAt,
    };
  });

  return { jobs };
}
