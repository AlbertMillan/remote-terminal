import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { git } from '../utils/git.js';
import { pathKey } from '../utils/paths.js';
import type { RegistryProject } from '../projects/registry.js';
import { allFeatureIds, planFileFor, readProjectPlan } from '../projects/project-plan.js';
import { commitOnHead, docRelOf } from '../projects/track-plan.js';
import { withProjectLock } from '../projects/project-lock.js';
import { invalidateProjectCache } from '../projects/project-discovery.js';
import {
  addFeature,
  generateFeatureId,
  parseProjectDoc,
  removeFeature,
  renderProjectDoc,
  usedIds,
  type ProjectDoc,
} from '../projects/project-doc-format.js';

/**
 * The factory's writes to the plan (project/code-factory.md: "PROJECT.md stays
 * the source of truth for features"). Intake and discovered work become real
 * feature lines with server-generated ids, written where the track's plan
 * lives (`planFileFor`: main for a backlog track such as Inbox, the track's
 * worktree for a branched one).
 *
 * Each write is one commit through a temporary index (`commitOnHead`, never
 * `git add`, so whatever the user has staged stays staged and out of it),
 * and the working copy gets the same lines while keeping its own edits —
 * the pattern the merge queue's ticks use. Committed, because an item's
 * worktree branches from HEAD: a line only in the working copy would be
 * missing there, and the merge's tick would find nothing to tick.
 */

export const INBOX_TRACK = 'Inbox';

/**
 * The step a triage item shows besides its `triage` status: the Factory
 * overlay (a parallel track) recognises triage by `step === 'triage'`.
 */
export const TRIAGE_STEP = 'triage';

export interface NewPlanLine {
  title: string;
  priority: number | null;
}

const HEAD_RETRIES = 3;

// One write at a time per project: two intakes reading the same HEAD would
// each commit on top of it, and the second update-ref would refuse.
const chains = new Map<string, Promise<unknown>>();

function serialized<T>(cwd: string, fn: () => Promise<T>): Promise<T> {
  const key = pathKey(cwd);
  const run = (chains.get(key) ?? Promise.resolve()).then(fn, fn);
  chains.set(
    key,
    run.catch(() => undefined)
  );
  return run;
}

/** Edit the plan doc at `cwd` both in HEAD (one commit) and in the working copy. */
async function editPlanFile(
  cwd: string,
  docRel: string,
  message: string,
  edit: (doc: ProjectDoc) => boolean
): Promise<boolean> {
  const apply = (text: string): string | null => {
    const doc = parseProjectDoc(text);
    return edit(doc) ? renderProjectDoc(doc) : null;
  };
  let headText: string | null = null;
  let headNext: string | null = null;
  // The merge queue's ticks commit on the same HEAD without this module's
  // chain; commitOnHead refuses rather than drop one, so read HEAD again.
  for (let attempt = 1; ; attempt++) {
    headText = await git(cwd, ['show', `HEAD:${docRel}`]);
    headNext = headText === null ? null : apply(headText);
    if (headText === null || headNext === null) break;
    try {
      await commitOnHead(cwd, [{ path: docRel, content: headNext }], message);
      break;
    } catch (error) {
      if (attempt >= HEAD_RETRIES || !/HEAD moved/.test((error as Error).message)) throw error;
    }
  }

  const abs = join(cwd, docRel);
  const working = existsSync(abs) ? readFileSync(abs, 'utf-8') : null;
  // A working copy equal to HEAD (or missing while HEAD has the doc) takes HEAD's result.
  const next = headText !== null && (working === headText || working === null) ? headNext : apply(working ?? '');
  if (next !== null && next !== working) {
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, next, 'utf-8');
  }
  invalidateProjectCache();
  return headNext !== null || next !== null;
}

/**
 * Append feature lines to `trackName` (created at the end of the doc when it
 * has no section yet) and return their new ids, in order. Ids are generated
 * against main, HEAD and every unlanded worktree, so none collides.
 * A branched track's worktree is written under the project lock (try-only:
 * a busy project throws ProjectBusyError, a 409).
 */
export function addPlanLines(project: RegistryProject, trackName: string, lines: NewPlanLine[]): Promise<string[]> {
  return serialized(project.cwd, async () => {
    const plan = readProjectPlan(project);
    const target = planFileFor(project, plan, { track: trackName });
    const docRel = docRelOf(project);
    const write = async (): Promise<string[]> => {
      const headText = await git(target.project.cwd, ['show', `HEAD:${docRel}`]);
      const taken = new Set([...allFeatureIds(plan), ...(headText ? usedIds(parseProjectDoc(headText)) : [])]);
      const ids = lines.map(() => {
        const id = generateFeatureId(taken);
        taken.add(id);
        return id;
      });
      const what = lines.length === 1 ? `"${lines[0].title}"` : `${lines.length} features`;
      await editPlanFile(target.project.cwd, docRel, `plan: file ${what} in ${trackName}`, (doc) => {
        lines.forEach((line, i) => {
          const f = addFeature(doc, { title: line.title, priority: line.priority, track: trackName });
          f.id = ids[i];
        });
        return true;
      });
      return ids;
    };
    return target.copy ? withProjectLock(project.cwd, `filing work in "${trackName}"`, write) : write();
  });
}

/** Remove a feature's line (a dismissed triage item) wherever the plan holds it. False when no file had it. */
export function removePlanLine(project: RegistryProject, featureId: string, title: string): Promise<boolean> {
  return serialized(project.cwd, async () => {
    const plan = readProjectPlan(project);
    const target = planFileFor(project, plan, { featureId });
    const docRel = docRelOf(project);
    const write = () =>
      editPlanFile(target.project.cwd, docRel, `plan: dismiss "${title}"`, (doc) => removeFeature(doc, featureId));
    return target.copy ? withProjectLock(project.cwd, `dismissing ${featureId}`, write) : write();
  });
}
