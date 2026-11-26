import { mkdirSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { getConfig } from '../config.js';
import { RunAbortedError, type ClaudeRunResult } from '../agent/claude-run.js';
import { createLogger } from '../utils/logger.js';
import { projectHash, unitJobId } from './deps.js';
import { getIntake, insertIntake, shapedFiles, updateIntake, type IntakeRecord, type ShapeQuestion } from './intake-store.js';
import { isObject, jsonReply } from './json-reply.js';
import { registerStepHandler, type StepContext, type StepResult } from './steps.js';
import { addDependency, getItem, updateItem } from './store.js';
import { DONE, isTrackWorkflow, MOCKUP_OUTCOME } from './templates.js';
import { checkDiscovered, type DiscoveredWork } from './triage.js';
import { CLOSED_STATUSES } from './types.js';

const logger = createLogger('factory-shape');

/**
 * The shaping pass (project/code-factory.md: "Shaping exists only for loose
 * work and is as small as it can be"). Replaces the engine's pass-through
 * `shape` step.
 *
 * A read-only run in the item's worktree writes a short spec (goal,
 * acceptance criteria, likely files, assumptions) and picks a model tier.
 * The spec is a file the later steps read as the item's spec (deps.features).
 * It asks only when truly blocked: a structured {question, options, default}
 * parks the item, and the answer resumes the session that asked. Otherwise it
 * proceeds and records its assumptions, which the summary page lists.
 *
 * Overlap check: the files it expects to touch are compared with every other
 * open item already shaped; sharing one makes this item wait for that one (an
 * inferred `blocks` edge, dropped once the blocker merges), and the run gives
 * the item back so it is claimed again once its blocker is done.
 */

export const SHAPE_MODEL = 'sonnet';
/** progress.notes key the overlay reads a shaping question from: a JSON array of {question, options, default}. */
export const QUESTIONS_NOTE = 'questions';
export const MODEL_TIERS = ['haiku', 'sonnet', 'opus'] as const;
export type ModelTier = (typeof MODEL_TIERS)[number];
const SHAPE_TOOLS = ['Read', 'Glob', 'Grep'];
const MAX_FILES = 50;

export interface ShapedSpec {
  goal: string;
  acceptance: string[];
  files: string[];
  assumptions: string[];
}

export type ShapeReply =
  | { kind: 'question'; question: ShapeQuestion }
  | { kind: 'spec'; spec: ShapedSpec; tier: ModelTier | null; discovered: DiscoveredWork[] };

const strings = (v: unknown, max: number): string[] | null => {
  if (!Array.isArray(v) || v.length > max || !v.every((x) => typeof x === 'string')) return null;
  return (v as string[]).map((s) => s.trim()).filter(Boolean);
};

/** Shaping's answer, or null for anything that is not exactly one of its two shapes. */
export function parseShapeReply(text: string): ShapeReply | null {
  const raw = jsonReply(text);
  if (!isObject(raw)) return null;
  if ('question' in raw) {
    const q = raw.question;
    const options = strings(raw.options, 6);
    if (typeof q !== 'string' || !q.trim() || q.length > 2000 || !options || options.length < 2) return null;
    if (typeof raw.default !== 'string' || !options.includes(raw.default.trim())) return null;
    return { kind: 'question', question: { question: q.trim(), options, default: raw.default.trim() } };
  }
  const s = raw.spec;
  if (!isObject(s) || typeof s.goal !== 'string' || !s.goal.trim()) return null;
  const acceptance = strings(s.acceptance, 30);
  const files = strings(s.files ?? [], MAX_FILES);
  const assumptions = strings(s.assumptions ?? [], 30);
  if (!acceptance || acceptance.length === 0 || !files || !assumptions) return null;
  const tier = (MODEL_TIERS as readonly unknown[]).includes(raw.tier) ? (raw.tier as ModelTier) : null;
  return {
    kind: 'spec',
    spec: { goal: s.goal.trim(), acceptance, files, assumptions },
    tier,
    discovered: checkDiscovered(raw.discovered ?? []),
  };
}

const SHAPE_REPLY = `Reply with ONLY one JSON object, no prose around it. Normally:
{
  "spec": {
    "goal": "<what the change achieves, one or two sentences>",
    "acceptance": ["<a checkable criterion>", ...],
    "files": ["<repo-relative path you expect to change or add>", ...],
    "assumptions": ["<a decision you made that the request left open>", ...]
  },
  "tier": "haiku" | "sonnet" | "opus",
  "discovered": [{"title": "<work outside this item worth doing>", "detail": "<where/why>"}]
}
"tier" is the model the work needs: "haiku" for a trivial edit, "sonnet" for most work,
"opus" for subtle or cross-cutting changes. "discovered" may be empty.

ONLY if you are truly blocked, instead:
{"question": "<one question>", "options": ["<choice>", "<choice>", ...], "default": "<the option you would pick>"}`;

function shapePrompt(ctx: StepContext, intake: IntakeRecord | null): string {
  const f = ctx.features[0];
  const reqs = intake?.requirements.length ? `\nRequirements from the request:\n${intake.requirements.map((r) => `- ${r}`).join('\n')}\n` : '';
  const detail = intake?.detail ? `\nWhat was seen when it was filed:\n${intake.detail}\n` : '';
  // The mockup step builds and shows it (mockup-step.ts); a spec that plans one would put it in the repo.
  const mockup = intake?.mockupFirst
    ? '\nThe user will approve a clickable mockup before this is built; the factory makes it in a step of\nits own. Do not plan a mockup file or page in the spec: specify the real change.\n'
    : '';
  const answered =
    intake?.question && intake.answer
      ? `\nYou asked earlier: ${intake.question.question}\nThe user answered: ${intake.answer}\n`
      : '';
  return `You are shaping one item of loose work before another agent implements it in this
repository (the current folder). Read whatever code you need; do not edit anything.

Item ${f.id}: ${f.title}
${reqs}${detail}${mockup}${answered}
Write a short spec for it. Ask a question ONLY when you are truly blocked: two reasonable
readings lead to different work and neither the request nor the code settles it. Otherwise
choose, and record the choice as an assumption.

${SHAPE_REPLY}`;
}

function answerPrompt(intake: IntakeRecord): string {
  return `The user answered your question.
Question: ${intake.question?.question ?? ''}
Answer: ${intake.answer ?? ''}

Now write the spec. ${SHAPE_REPLY}`;
}

export function specMarkdown(id: string, title: string, intake: IntakeRecord | null, spec: ShapedSpec, tier: string | null): string {
  const list = (xs: string[]) => (xs.length ? xs.map((x) => `- ${x}`).join('\n') : '- (none)');
  const parts = [
    `# ${title} (${id})`,
    '',
    '## Goal',
    '',
    spec.goal,
    '',
    '## Acceptance criteria',
    '',
    list(spec.acceptance),
  ];
  if (intake?.requirements.length) parts.push('', '## Requirements (from the request)', '', list(intake.requirements));
  parts.push('', '## Likely files', '', list(spec.files), '', '## Assumptions (made while shaping)', '', list(spec.assumptions));
  if (intake?.question && intake.answer) {
    parts.push('', '## Decided', '', `- ${intake.question.question} → ${intake.answer}`);
  }
  if (intake?.mockupFirst) {
    parts.push('', '## Mockup first', '', 'The user approves a clickable mockup (the factory\'s mockup step) before this is built.');
  }
  if (tier) parts.push('', `Model tier: ${tier}`);
  return `${parts.join('\n')}\n`;
}

/** Where an item's shaped spec lives: beside its summary page, outside every worktree. */
export function specPathFor(projectCwd: string, featureId: string): string {
  return join(getConfig().persistence.dataDir, 'factory', projectHash(projectCwd), featureId, 'spec.md');
}

const normPath = (p: string) => p.trim().replace(/\\/g, '/').replace(/^\.\//, '').toLowerCase();

export interface OverlapEdge {
  waits: string;
  for: string;
  shared: string[];
}

/**
 * Make `featureId` wait (inferred `blocks`) for every other open loose item
 * already shaped that expects to touch one of the same files. The item shaped
 * first goes first; an edge that would close a cycle is skipped.
 */
export function inferOverlap(projectCwd: string, featureId: string, files: string[]): OverlapEdge[] {
  const mine = new Set(files.map(normPath));
  const edges: OverlapEdge[] = [];
  if (mine.size === 0) return edges;
  for (const other of shapedFiles(projectCwd)) {
    if (other.featureId === featureId) continue;
    const item = getItem(projectCwd, other.featureId);
    if (!item || CLOSED_STATUSES.includes(item.status) || item.status === 'triage' || isTrackWorkflow(item.workflow)) continue;
    const shared = other.files.filter((f) => mine.has(normPath(f)));
    if (shared.length === 0) continue;
    try {
      addDependency({ projectCwd, fromFeature: featureId, toFeature: other.featureId, type: 'blocks', inferred: true });
      edges.push({ waits: featureId, for: other.featureId, shared });
    } catch (error) {
      logger.info({ featureId, other: other.featureId, error: (error as Error).message }, 'factory shape: overlap edge skipped');
    }
  }
  return edges;
}

function proceed(ctx: StepContext, featureId: string, files: string[], discovered: DiscoveredWork[] = []): StepResult {
  const edges = inferOverlap(ctx.unit.projectCwd, featureId, files);
  if (edges.length === 0) return { outcome: DONE, discovered };
  const why = edges.map((e) => `${e.for} (${e.shared.slice(0, 3).join(', ')})`).join('; ');
  logger.info({ cwd: ctx.unit.projectCwd, featureId, waitsFor: edges.map((e) => e.for) }, 'factory shape: waits for overlapping work');
  return { outcome: DONE, discovered, requeue: `waits for ${why}: they touch the same files` };
}

async function run(ctx: StepContext, prompt: string, resume: string | null): Promise<ClaudeRunResult> {
  const cwd = ctx.unit.projectCwd;
  const opts = {
    allowedTools: SHAPE_TOOLS,
    timeoutMs: ctx.deps.stepTimeoutMs(),
    signal: ctx.signal,
    failOnDenial: false,
    laneKey: cwd,
    tag: { projectCwd: cwd, kind: 'factory' as const, jobId: unitJobId(cwd, ctx.unit.unitId), stage: ctx.step.id },
    model: SHAPE_MODEL,
  };
  if (resume) {
    try {
      return await ctx.deps.runClaude(ctx.worktree.path, prompt, [], { ...opts, resumeSessionId: resume });
    } catch (error) {
      if (error instanceof RunAbortedError || ctx.signal.aborted) throw error;
      logger.warn({ cwd, error: (error as Error).message }, 'factory shape: resume failed, asking afresh');
      // The answer is in the fresh prompt too, so nothing the user said is lost.
      return ctx.deps.runClaude(ctx.worktree.path, shapePrompt(ctx, getIntake(cwd, ctx.features[0].id)), [], opts);
    }
  }
  return ctx.deps.runClaude(ctx.worktree.path, prompt, [], opts);
}

export async function shapeStep(ctx: StepContext): Promise<StepResult> {
  const cwd = ctx.unit.projectCwd;
  const f = ctx.features[0];
  // An item filed some other way gets its row now: the question, the answer and
  // the spec path all live there.
  const intake = getIntake(cwd, f.id) ?? insertIntake({ projectCwd: cwd, featureId: f.id, source: 'intake' });

  // Shaped already (a run cut short after writing its spec): don't pay for it twice.
  if (intake.specPath && intake.files) return proceed(ctx, f.id, intake.files);
  // A line that links a spec was planned: the spec is the input.
  if (f.spec) return { outcome: DONE };

  const answering = Boolean(intake.question && intake.answer && intake.shapeSessionId);
  const result = answering
    ? await run(ctx, answerPrompt(intake), intake.shapeSessionId)
    : await run(ctx, shapePrompt(ctx, intake), null);

  const reply = parseShapeReply(result.result);
  if (!reply) {
    const tail = result.result.trim().slice(-1000);
    return { park: `shape: the shaping run gave no valid spec or question; waiting for you\n\n${tail}` };
  }
  if (reply.kind === 'question') {
    updateIntake(cwd, f.id, { question: reply.question, answer: null, shapeSessionId: result.sessionId });
    // Where the Factory overlay reads it: the unit's progress, saved by the park.
    ctx.progress.notes[QUESTIONS_NOTE] = JSON.stringify([reply.question]);
    const q = reply.question;
    return { park: `shape: question: ${q.question}\nOptions: ${q.options.join(' | ')}\nDefault: ${q.default}` };
  }

  const { spec, tier } = reply;
  const path = specPathFor(cwd, f.id);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, specMarkdown(f.id, f.title, intake, spec, tier), 'utf-8');
  updateIntake(cwd, f.id, { specPath: path, files: spec.files, assumptions: spec.assumptions, question: null });
  delete ctx.progress.notes[QUESTIONS_NOTE];
  // A tier the sender chose wins over shaping's.
  if (tier && !getItem(cwd, f.id)?.modelTier) updateItem(cwd, f.id, { modelTier: tier });
  if (spec.assumptions.length > 0) {
    ctx.progress.notes.shape = spec.assumptions.map((a) => `- ${a}`).join('\n');
  }
  return proceed(ctx, f.id, spec.files, reply.discovered);
}

/**
 * The `shape` step as the template runs it: an item flagged "mockup first"
 * (intake's flag, or Add work's option) reports MOCKUP_OUTCOME instead of
 * done, which is what the template's `mockup` step waits on (mockup-step.ts).
 * Every way shaping finishes counts: a planned spec, a resumed run, and a
 * requeue behind overlapping work (its mockup runs once it is claimed again).
 * A park is left as it is.
 */
export async function shapeWithMockupFlag(ctx: StepContext): Promise<StepResult> {
  const result = await shapeStep(ctx);
  if (!('outcome' in result) || result.outcome !== DONE) return result;
  if (!getIntake(ctx.unit.projectCwd, ctx.features[0].id)?.mockupFirst) return result;
  return { ...result, outcome: MOCKUP_OUTCOME };
}

registerStepHandler('shape', shapeWithMockupFlag);
