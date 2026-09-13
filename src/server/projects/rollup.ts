import { pathKey } from '../sessions/project-discovery.js';
import { getWorkspaceBoard, type WorkspaceProject } from './workspace.js';
import { listJobs } from '../jobs/store.js';
import type { JobWithStages } from '../jobs/types.js';

/**
 * The cross-project roll-up: one answer to "what is in flight, and what needs
 * me?" across every project at once.
 *
 * Ordered by what it costs you to miss it. A job parked on a question is
 * blocking work right now; a blocked feature is blocking work you have not
 * started; a stale project is merely information. Sorting by anything else —
 * recency, name — would bury the first behind the third.
 */

export type AttentionKind =
  | 'question' // a run stopped and is waiting on a decision
  | 'failed' // a stage failed and the job is stuck
  | 'gate' // work is done and waiting for approval
  | 'blocked'; // a feature marked blocked in PROJECT.md

export interface AttentionItem {
  kind: AttentionKind;
  projectCwd: string;
  projectName: string;
  title: string;
  /** The question, failure reason, or gate name. */
  detail: string | null;
  jobId: string | null;
  featureId: string | null;
  /** When this became someone's problem, for age display. */
  since: string;
}

export interface ProjectSummary {
  cwd: string;
  name: string;
  status: string | null;
  hasDoc: boolean;
  counts: WorkspaceProject['counts'];
  runningJobs: number;
  waitingJobs: number;
  lastActivity: string | null;
  lastModified: string | null;
  vcsKind: string;
  canDispatch: boolean;
}

export interface Rollup {
  /** Everything waiting on you, most urgent first. */
  attention: AttentionItem[];
  /** Jobs executing a stage right now. */
  inFlight: { jobId: string; projectName: string; title: string; stage: string | null }[];
  projects: ProjectSummary[];
  totals: {
    projects: number;
    withDoc: number;
    features: number;
    done: number;
    inProgress: number;
    blocked: number;
    attention: number;
    running: number;
  };
}

/** Urgency order. Lower sorts first. */
const KIND_RANK: Record<AttentionKind, number> = {
  question: 0,
  failed: 1,
  gate: 2,
  blocked: 3,
};

function attentionFromJob(job: JobWithStages, projectName: string): AttentionItem | null {
  const base = {
    projectCwd: job.projectCwd,
    projectName,
    title: job.title,
    jobId: job.id,
    featureId: job.featureId,
    since: job.updatedAt,
  };

  if (job.status === 'parked' && job.parkReason === 'question') {
    return { ...base, kind: 'question', detail: job.detail };
  }
  if (job.status === 'failed') {
    return { ...base, kind: 'failed', detail: job.detail };
  }
  if (job.status === 'parked') {
    return {
      ...base,
      kind: 'gate',
      // Carry any warning the last stage left (an incomplete QA, say) rather
      // than just naming the gate — that warning is why the gate matters.
      detail: job.detail || (job.gate ? `waiting at the ${job.gate} gate` : 'waiting for approval'),
    };
  }
  return null;
}

export function getRollup(): Rollup {
  const board = getWorkspaceBoard();
  const jobs = listJobs();

  const nameByKey = new Map(board.map((p) => [pathKey(p.cwd), p.name]));
  const jobsByProject = new Map<string, JobWithStages[]>();
  for (const job of jobs) {
    const key = pathKey(job.projectCwd);
    const list = jobsByProject.get(key);
    if (list) list.push(job);
    else jobsByProject.set(key, [job]);
  }

  const attention: AttentionItem[] = [];
  const inFlight: Rollup['inFlight'] = [];

  for (const job of jobs) {
    const projectName = nameByKey.get(pathKey(job.projectCwd)) || job.projectCwd;
    const item = attentionFromJob(job, projectName);
    if (item) attention.push(item);
    if (job.status === 'running') {
      inFlight.push({ jobId: job.id, projectName, title: job.title, stage: job.stage });
    }
  }

  // Blocked features are work you have already decided matters and cannot
  // currently proceed with, so they belong on the same list as stuck jobs.
  for (const project of board) {
    for (const track of project.tracks) {
      for (const feature of track.features) {
        if (feature.status !== 'blocked') continue;
        attention.push({
          kind: 'blocked',
          projectCwd: project.cwd,
          projectName: project.name,
          title: feature.title,
          detail: `blocked in ${track.name}`,
          jobId: null,
          featureId: feature.id,
          since: project.lastActivity || project.lastModified || '',
        });
      }
    }
  }

  attention.sort((a, b) => {
    const byKind = KIND_RANK[a.kind] - KIND_RANK[b.kind];
    // Within a kind, oldest first: something waiting three days is worse than
    // the same thing waiting three minutes.
    return byKind !== 0 ? byKind : (a.since || '').localeCompare(b.since || '');
  });

  const projects: ProjectSummary[] = board.map((p) => {
    const projectJobs = jobsByProject.get(pathKey(p.cwd)) ?? [];
    return {
      cwd: p.cwd,
      name: p.name,
      status: p.status,
      hasDoc: p.hasDoc,
      counts: p.counts,
      runningJobs: projectJobs.filter((j) => j.status === 'running').length,
      waitingJobs: projectJobs.filter((j) => j.status === 'parked' || j.status === 'failed').length,
      lastActivity: p.lastActivity,
      lastModified: p.lastModified,
      vcsKind: p.vcs.kind,
      canDispatch: p.vcs.canDispatch,
    };
  });

  const totals = {
    projects: board.length,
    withDoc: board.filter((p) => p.hasDoc).length,
    features: board.reduce((n, p) => n + p.counts.total, 0),
    done: board.reduce((n, p) => n + p.counts.done, 0),
    inProgress: board.reduce((n, p) => n + p.counts.in_progress, 0),
    blocked: board.reduce((n, p) => n + p.counts.blocked, 0),
    attention: attention.length,
    running: inFlight.length,
  };

  return { attention, inFlight, projects, totals };
}
