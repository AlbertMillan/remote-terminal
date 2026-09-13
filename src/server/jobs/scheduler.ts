import { createLogger } from '../utils/logger.js';
import { pathKey } from '../sessions/project-discovery.js';
import type { Job } from './types.js';

const logger = createLogger('job-scheduler');

/**
 * Admission control for pipeline jobs.
 *
 * The policy is deliberately a swappable strategy rather than inline logic:
 * today's rule is one running job per project (issues queue behind it, projects
 * run in parallel), but that is expected to change — full parallelism within a
 * project is the obvious next step. Nothing outside this module may assume a
 * particular rule; callers ask `admit()` and get back whatever the current
 * policy allows.
 */
export interface SchedulePolicy {
  readonly name: string;
  /**
   * May `candidate` start, given the jobs already running?
   * Called in queue order; `running` includes jobs admitted earlier in the same
   * pass, so a policy sees the state its own decisions are creating.
   */
  canStart(candidate: Job, running: Job[]): boolean;
}

/**
 * One running job per project; unlimited projects in parallel.
 *
 * Two agents mutating one project's worktrees at once is the coordination
 * hazard worth avoiding: they would race on the same base branch and the same
 * PROJECT.md. Across projects there is no shared state, so there is no reason
 * to serialise.
 */
export class OneRunningJobPerProject implements SchedulePolicy {
  readonly name = 'one-per-project';

  canStart(candidate: Job, running: Job[]): boolean {
    const key = pathKey(candidate.projectCwd);
    return !running.some((job) => pathKey(job.projectCwd) === key);
  }
}

/**
 * Any number of jobs per project, bounded only by a global cap. Not wired up by
 * default; it exists so the swap is a one-line change rather than a rewrite,
 * and so the scheduler's tests can prove the seam actually works.
 */
export class FullParallel implements SchedulePolicy {
  readonly name = 'full-parallel';

  constructor(private readonly maxConcurrent = 4) {}

  canStart(_candidate: Job, running: Job[]): boolean {
    return running.length < this.maxConcurrent;
  }
}

let policy: SchedulePolicy = new OneRunningJobPerProject();

export function getPolicy(): SchedulePolicy {
  return policy;
}

export function setPolicy(next: SchedulePolicy): void {
  logger.info({ policy: next.name }, 'scheduler: policy changed');
  policy = next;
}

/**
 * Decide which queued jobs may start now.
 *
 * Pure: takes the current queue and running set, returns the jobs to admit.
 * Keeping the decision free of IO is what lets the policy be tested directly
 * and swapped without touching the runner.
 */
export function admit(queued: Job[], running: Job[]): Job[] {
  const current = [...running];
  const admitted: Job[] = [];

  // Oldest first, so a queue behind one project drains in the order it was
  // filled rather than by whichever job happens to be examined first.
  const ordered = [...queued].sort((a, b) => a.createdAt.localeCompare(b.createdAt));

  for (const candidate of ordered) {
    if (!policy.canStart(candidate, current)) continue;
    admitted.push(candidate);
    current.push(candidate);
  }
  return admitted;
}
