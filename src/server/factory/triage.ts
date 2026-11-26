import { createLogger } from '../utils/logger.js';
import type { RegistryProject } from '../projects/registry.js';
import { readProjectPlan } from '../projects/project-plan.js';
import { featuresOf } from '../projects/project-doc-format.js';
import { insertIntake } from './intake-store.js';
import { addPlanLines, INBOX_TRACK, removePlanLine, TRIAGE_STEP } from './plan-lines.js';
import { addDependency, createItem, deleteItem, getItem, updateItem } from './store.js';
import { ITEM_TEMPLATE } from './templates.js';
import type { FactoryItem } from './types.js';

const logger = createLogger('factory-triage');

/**
 * Discovered work (project/code-factory.md: agents file `discovered-from`
 * work into triage). A headless run has no session token, so it cannot use
 * the CLI: its step output carries a `discovered` list instead, which the
 * runner files here. A session files through `cr factory add --from`.
 *
 * Either way the work becomes an Inbox line and a `triage` item with a
 * `discovered-from` edge to the item it was found on. Triage items never run
 * until the user accepts them; backlog leaves the line as a plain feature,
 * dismiss removes it.
 */

export interface DiscoveredWork {
  title: string;
  detail: string | null;
}

/** At most this many discovered items are filed per step: an agent listing twenty is noise. */
export const MAX_DISCOVERED_PER_STEP = 5;
const MAX_TITLE = 200;
const MAX_DETAIL = 2000;

const oneLine = (s: string) => s.replace(/\s+/g, ' ').trim();

/** Check a `discovered` list (from a step result or an agent's reply); invalid entries are dropped. */
export function checkDiscovered(raw: unknown): DiscoveredWork[] {
  if (!Array.isArray(raw)) return [];
  const out: DiscoveredWork[] = [];
  for (const entry of raw) {
    if (entry === null || typeof entry !== 'object') continue;
    const e = entry as Record<string, unknown>;
    if (typeof e.title !== 'string') continue;
    const title = oneLine(e.title);
    if (!title || title.length > MAX_TITLE) continue;
    const detail = typeof e.detail === 'string' && e.detail.trim() ? e.detail.trim().slice(0, MAX_DETAIL) : null;
    if (!out.some((o) => o.title.toLowerCase() === title.toLowerCase())) out.push({ title, detail });
  }
  return out;
}

/**
 * The work an agent's reply lists in a fenced ```discovered block (a JSON
 * array of {title, detail}). Every such block counts; one that is not valid
 * JSON names nothing.
 */
export function parseDiscovered(text: string): DiscoveredWork[] {
  const all: unknown[] = [];
  for (const m of text.matchAll(/```discovered\s*\n([\s\S]*?)\n```/g)) {
    try {
      const parsed: unknown = JSON.parse(m[1]);
      if (Array.isArray(parsed)) all.push(...parsed);
    } catch {
      // Not JSON: nothing filed from this block.
    }
  }
  return checkDiscovered(all);
}

/** What implement and fix prompts tell the agent about work outside the item. */
export const DISCOVERED_INSTRUCTION = `If you notice work outside this item's scope that should be done (a bug, a missing
test elsewhere, a needed refactor), do NOT do it. List it at the very end of your final
message as a fenced block, which the factory files for the user to triage:
\`\`\`discovered
[{"title": "<one line>", "detail": "<what you saw and where>"}]
\`\`\``;

/**
 * File discovered work as triage items found on `fromFeature`. Titles already
 * in the Inbox are skipped, so a step that re-runs after a crash files nothing
 * twice. Returns the new feature ids. Never throws: discovered work is a side
 * channel and must not fail the step that found it.
 */
export async function fileDiscovered(
  project: RegistryProject,
  fromFeature: string,
  work: DiscoveredWork[]
): Promise<string[]> {
  try {
    const inbox = readProjectPlan(project).doc.tracks.find((t) => t.name === INBOX_TRACK);
    const known = new Set((inbox ? featuresOf(inbox) : []).map((f) => f.title.toLowerCase()));
    const fresh = work.filter((w) => !known.has(w.title.toLowerCase())).slice(0, MAX_DISCOVERED_PER_STEP);
    if (fresh.length === 0) return [];
    const ids = await addPlanLines(
      project,
      INBOX_TRACK,
      fresh.map((w) => ({ title: w.title, priority: null }))
    );
    const parent = getItem(project.cwd, fromFeature);
    fresh.forEach((w, i) => {
      createItem({
        projectCwd: project.cwd,
        featureId: ids[i],
        trackName: INBOX_TRACK,
        workflow: ITEM_TEMPLATE.name,
        status: 'triage',
        step: TRIAGE_STEP,
      });
      insertIntake({ projectCwd: project.cwd, featureId: ids[i], source: 'discovered', detail: w.detail });
      if (parent) addDependency({ projectCwd: project.cwd, fromFeature: ids[i], toFeature: fromFeature, type: 'discovered-from' });
    });
    logger.info({ cwd: project.cwd, from: fromFeature, ids }, 'factory: filed discovered work into triage');
    return ids;
  } catch (error) {
    logger.warn({ cwd: project.cwd, from: fromFeature, error: (error as Error).message }, 'factory: could not file discovered work');
    return [];
  }
}

export type TriageAction = 'accept' | 'backlog' | 'dismiss';
export const TRIAGE_ACTIONS: readonly TriageAction[] = ['accept', 'backlog', 'dismiss'];

export class TriageError extends Error {
  constructor(
    public readonly status: number,
    message: string
  ) {
    super(message);
    this.name = 'TriageError';
  }
}

export interface TriageResult {
  featureId: string;
  action: TriageAction;
  /** The item as it now is; null once it left the factory (backlog). */
  item: FactoryItem | null;
}

/**
 * Settle a triage item: `accept` queues it (shaping first, like any loose
 * work); `backlog` takes it out of the factory and leaves its line as a plain
 * pending feature; `dismiss` cancels it and removes its line.
 */
export async function triageItem(project: RegistryProject, featureId: string, action: unknown): Promise<TriageResult> {
  if (!(TRIAGE_ACTIONS as readonly unknown[]).includes(action)) {
    throw new TriageError(400, `action must be one of ${TRIAGE_ACTIONS.join(', ')}`);
  }
  const item = getItem(project.cwd, featureId);
  if (!item) throw new TriageError(404, `${featureId} is not a factory item of this project`);
  if (item.status !== 'triage') throw new TriageError(409, `${featureId} is not waiting in triage (it is ${item.status})`);
  const act = action as TriageAction;
  if (act === 'accept') {
    // Off the triage step: the runner starts it at its workflow's first step.
    return { featureId, action: act, item: updateItem(project.cwd, featureId, { status: 'open', step: null }) };
  }
  if (act === 'backlog') {
    deleteItem(project.cwd, featureId);
    return { featureId, action: act, item: null };
  }
  const title = readProjectPlan(project).doc.tracks.flatMap(featuresOf).find((f) => f.id === featureId)?.title ?? featureId;
  await removePlanLine(project, featureId, title);
  return { featureId, action: act, item: updateItem(project.cwd, featureId, { status: 'cancelled' }) };
}
