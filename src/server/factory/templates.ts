/**
 * Workflow templates (project/code-factory.md, "Workflows are templates, not
 * `STAGE_ORDER`").
 *
 * A template lists steps with `needs`; loops and skips are data, and the order
 * an item walks them is computed here, never hard-coded in the runner:
 *
 * - `needs`: a step runs once every step it needs has completed or been skipped.
 * - `when`: a step that only applies after some outcome (any of them) is skipped
 *   when none of them happened — `fix` runs only after a failed verify or a
 *   self-review that asked for changes.
 * - `loop`: once the step completes, the steps from `back` through it run again,
 *   at most `max` times in all; a step that would run past its cap parks the
 *   item for the user instead (the escalation "two failed fix loops").
 * - `Progress.skip`: steps a particular item leaves out (a small item, a track
 *   whose spec is the input), satisfying the `needs` of the steps after them.
 *
 * Everything here is pure: the runner persists `Progress` after each step, so a
 * reclaimed run resumes exactly where the last one stopped.
 */

export interface StepCondition {
  step: string;
  outcome: string;
}

export interface WorkflowStep {
  id: string;
  /** The step handler that runs it (steps.ts), so templates can share or swap them. */
  handler: string;
  needs: string[];
  /** Run only if any of these outcomes happened; skipped otherwise. */
  when?: StepCondition[];
  loop?: { back: string; max: number };
}

export interface WorkflowTemplate {
  name: string;
  steps: WorkflowStep[];
}

/** Outcomes every handler may report; handlers add their own (`pass`, `fail`, `changes`). */
export const DONE = 'done';

/** How far a unit of work has come. Persisted as JSON in `factory_runs.progress`. */
export interface Progress {
  /** Completed steps and the outcome each reported. */
  outcomes: Record<string, string>;
  /** Steps skipped by `when` or by `skip`. */
  skipped: string[];
  /** How many times each looping step has completed. */
  loops: Record<string, number>;
  /** Steps this unit leaves out entirely. */
  skip: string[];
  /** A track run's features already implemented and committed, in order. */
  featuresDone: string[];
  /**
   * Features whose agent run finished but which are not committed yet. A resume
   * (or a unit stepped aside on a busy project lock) only ticks and commits
   * these: the work is in the tree, and re-running the agent would pay for it twice.
   */
  featuresBuilt: string[];
  /** What a step leaves for a later one (verify's failing output, self-review's findings). */
  notes: Record<string, string>;
  /** The step started and not yet recorded: set means the last run died inside it. */
  current: string | null;
  /** The step the unit is parked at, while it waits for the user. */
  parked: string | null;
  /** Ledger tokens already accounted for: the runaway guard measures from here. */
  tokenBase: number;
}

export function emptyProgress(skip: string[] = []): Progress {
  return {
    outcomes: {},
    skipped: [],
    loops: {},
    skip: [...skip],
    featuresDone: [],
    featuresBuilt: [],
    notes: {},
    current: null,
    parked: null,
    tokenBase: 0,
  };
}

/** A stored progress blob, tolerant of missing fields (or garbage) from an older shape. */
export function parseProgress(json: string | null | undefined): Progress {
  let raw: Partial<Progress> = {};
  try {
    const parsed = json ? JSON.parse(json) : {};
    if (parsed && typeof parsed === 'object') raw = parsed as Partial<Progress>;
  } catch {
    // An unreadable blob starts the unit over rather than wedging it.
  }
  return {
    outcomes: raw.outcomes && typeof raw.outcomes === 'object' ? { ...raw.outcomes } : {},
    skipped: Array.isArray(raw.skipped) ? [...raw.skipped] : [],
    loops: raw.loops && typeof raw.loops === 'object' ? { ...raw.loops } : {},
    skip: Array.isArray(raw.skip) ? [...raw.skip] : [],
    featuresDone: Array.isArray(raw.featuresDone) ? [...raw.featuresDone] : [],
    featuresBuilt: Array.isArray(raw.featuresBuilt) ? [...raw.featuresBuilt] : [],
    notes: raw.notes && typeof raw.notes === 'object' ? { ...raw.notes } : {},
    current: typeof raw.current === 'string' ? raw.current : null,
    parked: typeof raw.parked === 'string' ? raw.parked : null,
    tokenBase: typeof raw.tokenBase === 'number' && Number.isFinite(raw.tokenBase) ? raw.tokenBase : 0,
  };
}

export class TemplateError extends Error {}

/**
 * Refuse a template the walk below could not finish: duplicate ids, a `needs`,
 * `when` or loop target naming a step that is not EARLIER in the list (which is
 * what makes the walk acyclic), or a loop with no runs.
 */
export function validateTemplate(t: WorkflowTemplate): void {
  const seen = new Set<string>();
  for (const step of t.steps) {
    if (seen.has(step.id)) throw new TemplateError(`${t.name}: duplicate step ${step.id}`);
    for (const need of step.needs) {
      if (!seen.has(need)) throw new TemplateError(`${t.name}: ${step.id} needs ${need}, which is not an earlier step`);
    }
    for (const cond of step.when ?? []) {
      if (!seen.has(cond.step)) throw new TemplateError(`${t.name}: ${step.id} waits on ${cond.step}, not an earlier step`);
    }
    if (step.loop) {
      if (step.loop.back !== step.id && !seen.has(step.loop.back)) {
        throw new TemplateError(`${t.name}: ${step.id} loops back to ${step.loop.back}, not an earlier step`);
      }
      if (!Number.isInteger(step.loop.max) || step.loop.max < 1) {
        throw new TemplateError(`${t.name}: ${step.id} loop max must be a positive integer`);
      }
    }
    seen.add(step.id);
  }
}

/** The fix-loop cap (Settings default "Fix loops before escalating"). */
export const FIX_LOOP_MAX = 2;

const FIX_STEP: WorkflowStep = {
  id: 'fix',
  handler: 'fix',
  needs: ['self-review'],
  when: [
    { step: 'verify', outcome: 'fail' },
    { step: 'self-review', outcome: 'changes' },
  ],
  loop: { back: 'verify', max: FIX_LOOP_MAX },
};

/** Loose work: shaped, implemented and checked as one item. */
export const ITEM_TEMPLATE: WorkflowTemplate = {
  name: 'item',
  steps: [
    { id: 'shape', handler: 'shape', needs: [] },
    { id: 'implement', handler: 'implement', needs: ['shape'] },
    { id: 'verify', handler: 'verify', needs: ['implement'] },
    { id: 'self-review', handler: 'self-review', needs: ['verify'] },
    FIX_STEP,
    { id: 'summary', handler: 'summary', needs: ['fix'] },
    { id: 'review', handler: 'review', needs: ['summary'] },
    { id: 'merge', handler: 'merge', needs: ['review'] },
  ],
};

/**
 * A planned track: one agent works its features in order in the track's
 * worktree, one commit per feature, then the whole track is checked, reviewed
 * and merged as one. No shaping: the session that planned it wrote the spec.
 */
export const TRACK_TEMPLATE: WorkflowTemplate = {
  name: 'track',
  steps: [
    { id: 'features', handler: 'track-features', needs: [] },
    { id: 'verify', handler: 'verify', needs: ['features'] },
    { id: 'self-review', handler: 'self-review', needs: ['verify'] },
    FIX_STEP,
    { id: 'summary', handler: 'summary', needs: ['fix'] },
    { id: 'review', handler: 'review', needs: ['summary'] },
    { id: 'merge', handler: 'merge', needs: ['review'] },
  ],
};

const TEMPLATES = new Map<string, WorkflowTemplate>();

export function registerTemplate(t: WorkflowTemplate): void {
  validateTemplate(t);
  TEMPLATES.set(t.name, t);
}

registerTemplate(ITEM_TEMPLATE);
registerTemplate(TRACK_TEMPLATE);

/** The template an item's `workflow` names, or null for one this server does not know. */
export function templateFor(workflow: string): WorkflowTemplate | null {
  return TEMPLATES.get(workflow) ?? null;
}

/** Whether a workflow runs a whole track as one unit rather than one item. */
export function isTrackWorkflow(workflow: string): boolean {
  return workflow === TRACK_TEMPLATE.name;
}

export type NextStep =
  | { kind: 'run'; step: WorkflowStep }
  | { kind: 'park'; step: WorkflowStep; reason: string }
  | { kind: 'finished' };

const settled = (p: Progress, id: string) => id in p.outcomes || p.skipped.includes(id);

/**
 * The next step to run, skipping (and recording in `progress`) every step that
 * does not apply. Steps are taken in template order, so the first unsettled
 * step whose needs are met is the one; `validateTemplate` guarantees its needs
 * are all earlier, so there is always one until the template is finished.
 */
export function nextStep(t: WorkflowTemplate, progress: Progress): NextStep {
  for (const step of t.steps) {
    if (settled(progress, step.id)) continue;
    if (!step.needs.every((n) => settled(progress, n))) continue;
    const excluded = progress.skip.includes(step.id);
    const applies = !step.when || step.when.some((c) => progress.outcomes[c.step] === c.outcome);
    if (excluded || !applies) {
      progress.skipped.push(step.id);
      // Restart the walk: a step later in the list may have been waiting on this one.
      return nextStep(t, progress);
    }
    if (step.loop && (progress.loops[step.id] ?? 0) >= step.loop.max) {
      return { kind: 'park', step, reason: `${step.id} ran ${step.loop.max} times without settling it` };
    }
    return { kind: 'run', step };
  }
  return { kind: 'finished' };
}

/**
 * Record a step's outcome. A looping step that completes sends the walk back:
 * every step from its `back` target through itself is cleared (outcomes and
 * skips), so they are taken again on the next `nextStep`. A cleared step's note
 * is kept until it runs again, which is how `fix` still reads why it ran.
 */
export function recordOutcome(t: WorkflowTemplate, progress: Progress, stepId: string, outcome: string): void {
  const index = t.steps.findIndex((s) => s.id === stepId);
  if (index < 0) throw new TemplateError(`${t.name} has no step ${stepId}`);
  const step = t.steps[index];
  progress.outcomes[stepId] = outcome;
  progress.skipped = progress.skipped.filter((s) => s !== stepId);
  if (!step.loop) return;
  progress.loops[stepId] = (progress.loops[stepId] ?? 0) + 1;
  const from = t.steps.findIndex((s) => s.id === step.loop?.back);
  for (const again of t.steps.slice(from, index + 1)) {
    delete progress.outcomes[again.id];
    progress.skipped = progress.skipped.filter((s) => s !== again.id);
  }
}
