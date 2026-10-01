import { createLogger } from '../utils/logger.js';
import type { RegistryProject } from './registry.js';
import { readProjectDoc, type ProjectDocState } from './project-store.js';
import {
  cloneTrack,
  featuresOf,
  removeTrack,
  replaceTrack,
  usedIds,
  type ProjectDoc,
  type Track,
} from './project-doc-format.js';
import { listTrackBranches, type TrackBranch } from './track-store.js';

const logger = createLogger('project-plan');

/**
 * Reading a project's plan across its copies.
 *
 * While a track has an unlanded branch, its section lives in that branch's
 * worktree, not main's PROJECT.md (docs/track-branches.md). Everything that
 * reads plans — the board, dispatch, rebuild, attribution, Delete — goes
 * through readProjectPlan, and every board write through planFileFor, or it
 * misses every branched track.
 */

/** The same project, addressed at a track's worktree: reads and writes its copy of the doc. */
export function worktreeProject(project: RegistryProject, worktreePath: string): RegistryProject {
  return { ...project, cwd: worktreePath };
}

/** One in-progress track's copy of the plan. */
export interface PlanCopy {
  branch: TrackBranch;
  /** The project addressed at the worktree, for readProjectDoc / mutateProjectDoc. */
  project: RegistryProject;
  /** The worktree's PROJECT.md; `exists` is false when the folder or the file is missing. */
  state: ProjectDocState;
  /** The track's section in the worktree's PROJECT.md; null when it has none. */
  track: Track | null;
}

export interface ProjectPlan {
  main: ProjectDocState;
  copies: PlanCopy[];
  /**
   * Main's doc with each in-progress track's section taken from its worktree
   * instead, appended when main has none. A branched track whose worktree has
   * no section is left out, never shown from main's stale copy.
   */
  doc: ProjectDoc;
}

/** Every unlanded track branch's copy of the plan. Never throws. */
export function planCopies(project: RegistryProject): PlanCopy[] {
  let branches: TrackBranch[];
  try {
    branches = listTrackBranches(project.cwd).filter((b) => b.landedAt === null);
  } catch (error) {
    logger.warn({ error, cwd: project.cwd }, 'project-plan: could not list track branches');
    return [];
  }
  return branches.map((branch) => {
    const wt = worktreeProject(project, branch.worktreePath);
    const state = readProjectDoc(wt);
    return {
      branch,
      project: wt,
      state,
      track: state.exists ? (state.doc.tracks.find((t) => t.name === branch.trackName) ?? null) : null,
    };
  });
}

/** Main's plan plus every in-progress track's section from its worktree. */
export function readProjectPlan(project: RegistryProject): ProjectPlan {
  const main = readProjectDoc(project);
  const copies = planCopies(project);
  const doc: ProjectDoc = {
    frontmatter: main.doc.frontmatter,
    preamble: [...main.doc.preamble],
    tracks: main.doc.tracks.map(cloneTrack),
  };
  for (const c of copies) {
    if (c.track) replaceTrack(doc, c.track);
    else removeTrack(doc, c.branch.trackName);
  }
  return { main, copies, doc };
}

/** Feature ids used in main or any in-progress worktree, for a new id that collides with none. */
export function allFeatureIds(plan: ProjectPlan): Set<string> {
  return usedIds([plan.main.doc, ...plan.copies.map((c) => c.state.doc)]);
}

/**
 * The file a board write goes to: the worktree's copy for a feature or track
 * that is in progress, main's otherwise. `copy` is null for main.
 */
export function planFileFor(
  project: RegistryProject,
  plan: ProjectPlan,
  target: { featureId?: string; track?: string }
): { project: RegistryProject; copy: PlanCopy | null } {
  const copy = target.featureId
    ? plan.copies.find((c) => c.track && featuresOf(c.track).some((f) => f.id === target.featureId))
    : target.track
      ? plan.copies.find((c) => c.branch.trackName === target.track)
      : undefined;
  return copy ? { project: copy.project, copy } : { project, copy: null };
}
