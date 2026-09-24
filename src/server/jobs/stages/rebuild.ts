import { existsSync } from 'fs';
import { join } from 'path';
import { createLogger } from '../../utils/logger.js';
import { COMMIT_IDENTITY, git } from '../../agent/claude-run.js';
import { hasRemote } from '../worktree.js';
import { mutateProjectDoc, readProjectDoc } from '../../projects/project-store.js';
import { docPathFor, type RegistryProject } from '../../projects/registry.js';
import { findFeature, updateFeature } from '../../projects/project-doc-format.js';
import { invalidateProjectCache } from '../../sessions/project-discovery.js';

const logger = createLogger('stage-rebuild');

/**
 * Rebuild stage: reconcile PROJECT.md with what just landed.
 *
 * Deliberately has no agent in it. The board's whole premise is that PROJECT.md
 * is authoritative and the server writes it directly — running a model to tick
 * a checkbox would reintroduce exactly the drift the canonical format exists to
 * remove.
 */

export interface RebuildResult {
  /** Whether the feature's status was changed. */
  updated: boolean;
  committed: boolean;
  pushed: boolean;
  detail: string;
}

/**
 * Is PROJECT.md already modified in the working tree?
 *
 * If the user has half-edited it we must not sweep their change into our
 * commit, so we make the status change and leave it for them.
 */
async function projectDocIsDirty(cwd: string, docRel: string): Promise<boolean> {
  const out = await git(cwd, ['status', '--porcelain', '--', docRel]);
  return !!out?.trim();
}

export async function runRebuildStage(opts: {
  project: RegistryProject;
  featureId: string | null;
  /** Spec path the design stage produced, to link from the feature. */
  specPath: string | null;
  title: string;
}): Promise<RebuildResult> {
  const { project, featureId, specPath, title } = opts;
  const docRel = project.doc || 'PROJECT.md';

  if (!featureId) {
    // An ad-hoc job was never tied to a feature, so there is nothing to tick.
    return { updated: false, committed: false, pushed: false, detail: 'no linked feature' };
  }

  const state = readProjectDoc(project);
  if (!state.exists || !findFeature(state.doc, featureId)) {
    return {
      updated: false,
      committed: false,
      pushed: false,
      detail: `feature ${featureId} is no longer in ${docRel}`,
    };
  }

  const wasDirty = await projectDocIsDirty(project.cwd, docRel);

  // Link the spec only if it actually survived the merge — a dangling link is
  // worse than none.
  const specLanded = specPath && existsSync(join(project.cwd, specPath)) ? specPath : undefined;

  mutateProjectDoc(project, null, (doc) =>
    updateFeature(doc, featureId, {
      status: 'done',
      ...(specLanded ? { spec: specLanded } : {}),
    })
  );

  // The board reads discovery through a short cache; drop it so the change
  // shows on the very next poll rather than up to the TTL later.
  invalidateProjectCache();

  if (wasDirty) {
    logger.info({ cwd: project.cwd, featureId }, 'rebuild: marked done, left uncommitted');
    return {
      updated: true,
      committed: false,
      pushed: false,
      detail: `marked done — ${docRel} had your own uncommitted edits, so the change was left for you to commit`,
    };
  }

  // Stage only the index: the user may have other work in progress that is
  // none of this job's business.
  await git(project.cwd, ['add', '--', docRel]);
  const committed =
    (await git(project.cwd, [
      ...COMMIT_IDENTITY,
      'commit',
      '-m',
      `chore: mark "${title}" done`,
      '--no-verify',
      '--',
      docRel,
    ])) !== null;

  let pushed = false;
  if (committed && (await hasRemote(project.cwd))) {
    pushed = (await git(project.cwd, ['push'])) !== null;
  }

  logger.info({ cwd: project.cwd, featureId, committed, pushed }, 'rebuild: feature marked done');
  return {
    updated: true,
    committed,
    pushed,
    detail: committed ? (pushed ? 'marked done, committed and pushed' : 'marked done and committed') : 'marked done',
  };
}

/** Absolute path of a project's index, for callers that need to report it. */
export function projectDocPath(project: RegistryProject): string {
  return docPathFor(project);
}
