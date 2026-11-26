import { getWorkspaceBoard, type WorkspaceProject } from './workspace.js';

/**
 * The cross-project roll-up: every project at once, and the features marked
 * blocked in a PROJECT.md (work you decided matters and cannot proceed with).
 * What the factory is running or waits on is its own feed (`factory.summary`).
 */

export type AttentionKind = 'blocked'; // a feature marked blocked in PROJECT.md

export interface AttentionItem {
  kind: AttentionKind;
  projectCwd: string;
  projectName: string;
  title: string;
  detail: string | null;
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
  lastActivity: string | null;
  lastModified: string | null;
  vcsKind: string;
  canDispatch: boolean;
}

export interface Rollup {
  /** Blocked features, oldest first. */
  attention: AttentionItem[];
  projects: ProjectSummary[];
  totals: {
    projects: number;
    withDoc: number;
    features: number;
    done: number;
    inProgress: number;
    blocked: number;
    attention: number;
  };
}

export function getRollup(): Rollup {
  const board = getWorkspaceBoard();

  const attention: AttentionItem[] = [];
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
          featureId: feature.id,
          since: project.lastActivity || project.lastModified || '',
        });
      }
    }
  }
  // Oldest first: something waiting three days is worse than the same thing waiting three minutes.
  attention.sort((a, b) => (a.since || '').localeCompare(b.since || ''));

  const projects: ProjectSummary[] = board.map((p) => ({
    cwd: p.cwd,
    name: p.name,
    status: p.status,
    hasDoc: p.hasDoc,
    counts: p.counts,
    lastActivity: p.lastActivity,
    lastModified: p.lastModified,
    vcsKind: p.vcs.kind,
    canDispatch: p.vcs.canDispatch,
  }));

  const totals = {
    projects: board.length,
    withDoc: board.filter((p) => p.hasDoc).length,
    features: board.reduce((n, p) => n + p.counts.total, 0),
    done: board.reduce((n, p) => n + p.counts.done, 0),
    inProgress: board.reduce((n, p) => n + p.counts.in_progress, 0),
    blocked: board.reduce((n, p) => n + p.counts.blocked, 0),
    attention: attention.length,
  };

  return { attention, projects, totals };
}
