import { readFileSync } from 'fs';
import { join, posix } from 'path';
import { commandsDir, projectAccount } from '../accounts.js';
import { git } from '../utils/git.js';
import { createLogger } from '../utils/logger.js';
import { loadReviewCriteria } from '../jobs/stages/review.js';
import { unitJobId, type UnitFeature } from './deps.js';
import { factoryReviewSettings, type FactoryReviewSettings } from './review-settings.js';
import { registerStepHandler, stepHandler, type StepContext, type StepResult } from './steps.js';
import { getItem } from './store.js';
import { mockupReference } from './mockup-files.js';
import { DONE, FIX_LOOP_MAX } from './templates.js';
import type { ReviewGranularity } from './types.js';

const logger = createLogger('factory-review');

/**
 * The reviewer agent (project/code-factory.md, "The review gate is an agent by
 * default, configurable"; Settings → Factory in review-settings.ts).
 *
 * A read-only Opus run reviews the unit's diff against its base: the spec, fit
 * with the codebase, the checks, and the user's own /code-review standard. It
 * answers with a JSON verdict, parsed strictly; anything else is NOT approved
 * and waits for the user. `changes` goes to `review-fix` and back through
 * verify (the template's loop, FIX_LOOP_MAX times); past that it escalates.
 * An approval moves on to merge unless the mode is `agent-escalate` and an
 * escalation rule matches, which parks the unit with the reasons and verdict.
 *
 * The rules are judged on facts read from git and the summary page, not on the
 * reviewer's say-so; the reviewer's own escalation facts only add to them.
 */

// ---------------------------------------------------------------------------
// The verdict

export interface ReviewFinding {
  file: string;
  line: number | null;
  issue: string;
}

/** What the reviewer saw that bears on escalation. */
export interface ReviewerFacts {
  sensitivePaths: boolean;
  newDependencies: string[];
  assumptions: string[];
}

export interface ReviewVerdict {
  verdict: 'approve' | 'changes';
  findings: ReviewFinding[];
  escalation: ReviewerFacts;
}

const isObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const isStrings = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === 'string');

function checkVerdict(raw: unknown): ReviewVerdict | null {
  if (!isObject(raw)) return null;
  if (raw.verdict !== 'approve' && raw.verdict !== 'changes') return null;
  if (!Array.isArray(raw.findings)) return null;
  const findings: ReviewFinding[] = [];
  for (const f of raw.findings) {
    if (!isObject(f) || typeof f.file !== 'string' || typeof f.issue !== 'string' || !f.issue.trim()) return null;
    const line = f.line ?? null;
    if (line !== null && !(typeof line === 'number' && Number.isInteger(line) && line > 0)) return null;
    findings.push({ file: f.file, line, issue: f.issue.trim() });
  }
  // Changes with nothing to change can't be fixed; an approval may still carry notes.
  if (raw.verdict === 'changes' && findings.length === 0) return null;
  const e = raw.escalation;
  if (!isObject(e) || typeof e.sensitivePaths !== 'boolean' || !isStrings(e.newDependencies) || !isStrings(e.assumptions)) {
    return null;
  }
  return {
    verdict: raw.verdict,
    findings,
    escalation: { sensitivePaths: e.sensitivePaths, newDependencies: e.newDependencies, assumptions: e.assumptions },
  };
}

/**
 * The reviewer's verdict, or null. Strict: the reply must be the JSON object
 * alone, or end with it as its last fenced ```json block. Every field must
 * have its type; a `changes` must name a finding. Never guessed from prose.
 */
export function parseReviewVerdict(text: string): ReviewVerdict | null {
  const tryParse = (s: string): ReviewVerdict | null => {
    try {
      return checkVerdict(JSON.parse(s));
    } catch {
      return null;
    }
  };
  const trimmed = text.trim();
  if (trimmed.startsWith('{')) return tryParse(trimmed);
  const fences = [...trimmed.matchAll(/```json\s*\n([\s\S]*?)\n```/g)];
  const last = fences[fences.length - 1];
  // Only a fence that closes the reply: a sample shape quoted mid-reply is not the answer.
  if (!last || last.index + last[0].length !== trimmed.length) return null;
  return tryParse(last[1]);
}

export function formatVerdict(v: ReviewVerdict): string {
  const lines = v.findings.map((f) => `- ${f.file}${f.line ? `:${f.line}` : ''}: ${f.issue}`);
  return `Reviewer: ${v.verdict}${lines.length ? `\n${lines.join('\n')}` : ''}`;
}

// ---------------------------------------------------------------------------
// Escalation facts

/** auth/, the access gate, accounts, migrations. */
const SENSITIVE = [
  /(^|\/)auth\//i,
  /access-gate/i,
  /(^|\/)accounts?(\/|[-.][^/]*$|$)/i,
  /(^|\/)src\/server\/db\/schema\.ts$/,
  /(^|\/)migrations?\//i,
];

const LOCKFILES = new Set([
  'package-lock.json',
  'npm-shrinkwrap.json',
  'yarn.lock',
  'pnpm-lock.yaml',
  'bun.lockb',
  'bun.lock',
  'cargo.lock',
  'poetry.lock',
  'pipfile.lock',
  'gemfile.lock',
  'composer.lock',
  'go.sum',
  'packages.lock.json',
]);

const TEST = [/(^|\/)(tests?|__tests__|__mocks__|spec|fixtures)\//i, /\.(test|spec)\.[^/]+$/i];
const GENERATED = [/(^|\/)(dist|build|out|coverage|node_modules|vendor|generated)\//i, /\.min\.(js|css)$/i, /\.generated\./i, /\.snap$/i];

export const isSensitivePath = (path: string) => SENSITIVE.some((r) => r.test(path));

/** Whether a changed file counts toward the diff-size rule. */
export function countsTowardDiff(path: string): boolean {
  const base = posix.basename(path).toLowerCase();
  if (LOCKFILES.has(base)) return false;
  return !TEST.some((r) => r.test(path)) && !GENERATED.some((r) => r.test(path));
}

const DEP_FIELDS = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'];

/** Package names in `after` that no dependency field of `before` names. */
export function addedDependencies(before: string | null, after: string | null): string[] {
  const names = (json: string | null): Set<string> => {
    const out = new Set<string>();
    try {
      const pkg: unknown = json ? JSON.parse(json) : {};
      if (!isObject(pkg)) return out;
      for (const field of DEP_FIELDS) {
        const deps = pkg[field];
        if (isObject(deps)) for (const name of Object.keys(deps)) out.add(name);
      }
    } catch {
      // An unreadable package.json names nothing.
    }
    return out;
  };
  const had = names(before);
  return [...names(after)].filter((n) => !had.has(n));
}

/**
 * The "## Assumptions" section of a summary page, one entry per non-empty
 * line, bullets stripped; a section saying only "none" is empty.
 */
export function summaryAssumptions(markdown: string): string[] {
  const lines = markdown.split(/\r?\n/);
  const start = lines.findIndex((l) => /^#{1,6}\s*Assumptions\b/i.test(l.trim()));
  if (start < 0) return [];
  const out: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (/^#{1,6}\s/.test(line.trim())) break;
    const text = line.trim().replace(/^([-*+]|\d+[.)])\s+/, '').trim();
    if (text) out.push(text);
  }
  if (out.length === 1 && /^\(?(none|n\/a|no assumptions?)\b/i.test(out[0])) return [];
  return out;
}

export interface ChangedFile {
  path: string;
  /** Added plus deleted lines; 0 for a binary file. */
  lines: number;
}

/** What the rules read from the worktree. Tests replace it (`setReviewProbe`). */
export interface ReviewProbe {
  /** Files changed between `from` (a branch or commit) and HEAD. */
  changedFiles(worktreePath: string, from: string): Promise<ChangedFile[]>;
  /** A file's content at the merge-base of `from` and HEAD (`side: 'base'`) or at HEAD; null when absent. */
  fileAt(worktreePath: string, from: string, side: 'base' | 'head', path: string): Promise<string | null>;
  readText(path: string): string | null;
}

async function mergeBase(worktreePath: string, from: string): Promise<string | null> {
  return (await git(worktreePath, ['merge-base', from, 'HEAD']))?.trim() || null;
}

export const gitReviewProbe: ReviewProbe = {
  async changedFiles(worktreePath, from) {
    const base = await mergeBase(worktreePath, from);
    if (!base) throw new Error(`no common history between ${from} and HEAD`);
    // -z: paths verbatim, never C-quoted (a quoted path would slip past the path rules).
    const out = await git(worktreePath, ['diff', '--numstat', '-z', '--no-renames', base, 'HEAD']);
    if (out === null) throw new Error(`git diff against ${from} failed`);
    return out
      .split('\0')
      .filter((row) => row.trim())
      .map((row) => {
        const [added, deleted, ...rest] = row.split('\t');
        const n = (s: string) => (/^\d+$/.test(s) ? Number(s) : 0);
        return { path: rest.join('\t'), lines: n(added) + n(deleted) };
      });
  },
  async fileAt(worktreePath, from, side, path) {
    const ref = side === 'head' ? 'HEAD' : await mergeBase(worktreePath, from);
    return ref ? git(worktreePath, ['show', `${ref}:${path}`]) : null;
  },
  readText(path) {
    try {
      return readFileSync(path, 'utf-8');
    } catch {
      return null;
    }
  },
};

let probe: ReviewProbe = gitReviewProbe;

/** Swap the git reads (tests). Returns the one replaced. */
export function setReviewProbe(next: ReviewProbe): ReviewProbe {
  const was = probe;
  probe = next;
  return was;
}

export interface ReviewFacts {
  sensitiveFiles: string[];
  changedLines: number;
  addedDependencies: string[];
  assumptions: string[];
  /** Fix loops the unit has run since its features were built (self-review's and the reviewer's). */
  fixLoops: number;
}

export async function gatherFacts(ctx: StepContext, from: string): Promise<ReviewFacts> {
  const files = await probe.changedFiles(ctx.worktree.path, from);
  const added: string[] = [];
  for (const f of files.filter((x) => posix.basename(x.path) === 'package.json')) {
    const before = await probe.fileAt(ctx.worktree.path, from, 'base', f.path);
    const after = await probe.fileAt(ctx.worktree.path, from, 'head', f.path);
    added.push(...addedDependencies(before, after));
  }
  const summaryPath = ctx.progress.notes.summary;
  const summary = summaryPath ? probe.readText(summaryPath) : null;
  return {
    sensitiveFiles: files.map((f) => f.path).filter(isSensitivePath),
    changedLines: files.filter((f) => countsTowardDiff(f.path)).reduce((sum, f) => sum + f.lines, 0),
    addedDependencies: [...new Set(added)],
    assumptions: summary ? summaryAssumptions(summary) : [],
    fixLoops: (ctx.progress.loops.fix ?? 0) + (ctx.progress.loops['review-fix'] ?? 0),
  };
}

/** Why an approved unit still goes to the user, one reason per enabled rule that matches. */
export function escalationReasons(settings: FactoryReviewSettings, facts: ReviewFacts, verdict: ReviewVerdict): string[] {
  const { rules } = settings;
  const reasons: string[] = [];
  const short = (xs: string[]) => xs.slice(0, 5).join(', ') + (xs.length > 5 ? `, … (${xs.length})` : '');
  if (rules.sensitivePaths && (facts.sensitiveFiles.length > 0 || verdict.escalation.sensitivePaths)) {
    reasons.push(
      facts.sensitiveFiles.length > 0
        ? `touches auth, the access gate, accounts or migrations (${short(facts.sensitiveFiles)})`
        : 'the reviewer says it touches auth, the access gate, accounts or migrations'
    );
  }
  if (rules.largeDiff && facts.changedLines > settings.largeDiffLines) {
    reasons.push(`${facts.changedLines} changed lines (over ${settings.largeDiffLines}, tests, lockfiles and generated files excluded)`);
  }
  if (rules.fixLoops && facts.fixLoops >= FIX_LOOP_MAX) {
    reasons.push(`it took ${facts.fixLoops} fix loops before the reviewer approved`);
  }
  const assumptions = facts.assumptions.length > 0 ? facts.assumptions : verdict.escalation.assumptions;
  if (rules.assumptions && assumptions.length > 0) {
    reasons.push(`it made assumptions instead of asking: ${short(assumptions)}`);
  }
  const deps = [...new Set([...facts.addedDependencies, ...verdict.escalation.newDependencies])];
  if (rules.newDependency && deps.length > 0) {
    reasons.push(`adds a dependency (${short(deps)})`);
  }
  return reasons;
}

// ---------------------------------------------------------------------------
// Granularity

/** A unit's review granularity: its items' override, else the setting. */
export function unitGranularity(ctx: StepContext, settings: FactoryReviewSettings): ReviewGranularity {
  if (!ctx.unit.isTrack) return 'track';
  for (const id of ctx.unit.featureIds) {
    const override = getItem(ctx.unit.projectCwd, id)?.reviewGranularity;
    if (override) return override;
  }
  return settings.granularity;
}

/** Where a per-feature review's diff starts: HEAD before the feature under review was built. */
const REVIEW_BASE = 'review-base';
/** The feature a per-feature round builds and reviews, until `next-feature` moves on. */
const REVIEW_FEATURE = 'review-feature';
/** The reviewer's last verdict, for `review-fix` and the user. */
const REVIEW_NOTE = 'review';

// ---------------------------------------------------------------------------
// The reviewer run

/** Read-only: it may run git and the tests, and every edit it makes is reverted. */
const REVIEWER_TOOLS = ['Read', 'Glob', 'Grep', 'Bash'];
export const REVIEWER_MODEL = 'opus';
export const REVIEWER_EFFORT = 'high';

const VERDICT_SHAPE = `{
  "verdict": "approve" | "changes",
  "findings": [{ "file": "src/x.ts", "line": 42, "issue": "<the defect and what to do about it>" }],
  "escalation": {
    "sensitivePaths": <true if it touches auth, the access gate, accounts or DB migrations>,
    "newDependencies": ["<package added to a package.json>", …],
    "assumptions": ["<a decision the unit made instead of asking>", …]
  }
}`;

function reviewerPrompt(ctx: StepContext, from: string, reviewed: UnitFeature[]): string {
  const { criteria } = loadReviewCriteria(join(commandsDir(projectAccount(ctx.unit.projectCwd)), 'code-review.md'));
  const specs = reviewed
    .map((f) => `- ${f.id} ${f.title}: ${f.spec ? `spec ${f.spec} (read it; it is approved)` : 'no spec; the title is the brief'}`)
    .join('\n');
  const verify = ctx.progress.outcomes.verify ?? (ctx.progress.skipped.includes('verify') ? 'skipped' : 'not run');
  const checks = ctx.progress.notes.verify ? `${verify}; last failing output:\n${ctx.progress.notes.verify}` : verify;
  const summary = ctx.progress.notes.summary ? `The unit's summary page is ${ctx.progress.notes.summary}; read it first.` : 'The unit wrote no summary page.';
  const self = ctx.progress.notes['self-review'] ? `\nIts self-review last raised:\n${ctx.progress.notes['self-review']}\n` : '';
  const mockup = ctx.unit.isTrack ? '' : mockupReference(ctx.progress, ctx.unit.projectCwd, ctx.features[0].id);
  return `You are the reviewer who decides whether this work merges. Review the change on this
branch: \`git diff ${from}...HEAD\` (run it; read the files it touches as needed).

Under review:
${specs}

${summary}${mockup ? `\n${mockup}\nA departure from the approved mockup that the summary page does not justify is a finding.` : ''}
The project's checks (verify): ${checks}
${self}
Judge it on:
1. The spec and its acceptance criteria: is each met, and nothing outside its scope done?
2. Fit with the codebase: reuses what exists rather than duplicating it, follows the
   surrounding conventions, adds no new dependency without need.
3. The checks above and the tests: do they cover what the spec asks? Run them if in doubt.
4. The user's own review standard, below. Take from it WHAT to look for only: ignore any
   output format, tally, grouping or delegation instructions in it. Your reply's format is
   fixed at the end of this prompt and nothing else is read.
=== REVIEW CRITERIA ===
${criteria}
=== END CRITERIA ===

Ask for changes only for real defects worth another fix pass, never style nits. Do not edit
any file: this run is read-only and every edit is reverted.

Reply with ONLY this JSON object (no prose around it):
${VERDICT_SHAPE}

"approve" may still list minor findings; "changes" must list at least one. Use null for
"line" when there is none.`;
}

async function head(ctx: StepContext): Promise<string | null> {
  return ctx.deps.headCommit(ctx.worktree.path);
}

async function review(ctx: StepContext): Promise<StepResult> {
  const settings = factoryReviewSettings();
  if (settings.mode === 'me') {
    return { park: 'review: waiting for you (Settings → Factory: review by me)' };
  }
  const perFeature = unitGranularity(ctx, settings) === 'feature';
  const from = (perFeature && ctx.progress.notes[REVIEW_BASE]) || ctx.worktree.baseBranch;
  const round = ctx.progress.notes[REVIEW_FEATURE];
  const reviewed = perFeature ? ctx.features.filter((f) => f.id === round) : ctx.features;

  const result = await ctx.deps.runClaude(ctx.worktree.path, reviewerPrompt(ctx, from, reviewed.length ? reviewed : ctx.features), [], {
    allowedTools: REVIEWER_TOOLS,
    timeoutMs: ctx.deps.stepTimeoutMs(),
    signal: ctx.signal,
    failOnDenial: false,
    laneKey: ctx.unit.projectCwd,
    tag: { projectCwd: ctx.unit.projectCwd, kind: 'factory', jobId: unitJobId(ctx.unit.projectCwd, ctx.unit.unitId), stage: ctx.step.id },
    model: REVIEWER_MODEL,
    effort: REVIEWER_EFFORT,
  });

  const verdict = parseReviewVerdict(result.result);
  if (!verdict) {
    const tail = result.result.trim().slice(-1500);
    ctx.progress.notes[REVIEW_NOTE] = `Reviewer gave no valid verdict. Its reply ended:\n${tail}`;
    logger.warn({ cwd: ctx.unit.projectCwd, unit: ctx.unit.unitId }, 'factory review: unparseable verdict');
    return { park: `review: the reviewer gave no valid verdict, so it is not approved; waiting for you\n\n${tail}` };
  }
  ctx.progress.notes[REVIEW_NOTE] = formatVerdict(verdict);

  if (verdict.verdict === 'changes') {
    const loops = ctx.progress.loops['review-fix'] ?? 0;
    if (loops >= FIX_LOOP_MAX) {
      // Given back with the park: a release without an outcome means "more fix rounds",
      // where keeping the count would re-review and re-park at once. `approved` still merges.
      ctx.progress.loops['review-fix'] = 0;
      return { park: `review: escalated: ${loops} fix loops did not satisfy the reviewer\n\n${formatVerdict(verdict)}` };
    }
    return { outcome: 'changes' };
  }

  if (settings.mode === 'agent-escalate') {
    let reasons: string[];
    try {
      reasons = escalationReasons(settings, await gatherFacts(ctx, from), verdict);
    } catch (error) {
      // Rules that cannot be checked are not passed.
      reasons = [`the escalation rules could not be checked (${(error as Error).message})`];
    }
    if (reasons.length > 0) {
      return { park: `review: escalated: ${reasons.join('; ')}\n\n${formatVerdict(verdict)}` };
    }
  }
  return { outcome: 'approved' };
}

async function reviewFix(ctx: StepContext): Promise<StepResult> {
  const findings = ctx.progress.notes[REVIEW_NOTE] ?? '(the reviewer gave no detail)';
  await ctx.agent({
    work: true,
    access: 'write',
    prompt: `The reviewer asked for changes before this can merge:
${findings}

Fix these, re-run the tests and lint, and stay inside the spec. Do not commit; the factory commits your work.`,
  });
  await ctx.commit(`fix review: ${ctx.unit.isTrack ? ctx.unit.trackName : ctx.features[0].title}`);
  return { outcome: DONE };
}

/**
 * The track's features step, by granularity: per track, every feature (the
 * plain `track-features` handler); per feature, only the next one, reporting
 * `more` while others remain so `next-feature` brings the walk back here.
 */
async function trackFeaturesReviewed(ctx: StepContext): Promise<StepResult> {
  const build = stepHandler('track-features');
  if (!build) throw new Error('no track-features handler');
  if (unitGranularity(ctx, factoryReviewSettings()) === 'track') {
    delete ctx.progress.notes[REVIEW_BASE];
    delete ctx.progress.notes[REVIEW_FEATURE];
    return build(ctx);
  }
  const notes = ctx.progress.notes;
  const left = () => ctx.features.filter((f) => !ctx.progress.featuresDone.includes(f.id));
  const outcome = (): StepResult => ({ outcome: left().length > 0 ? 'more' : DONE });
  // This round's feature, kept until `next-feature`: a run that died after committing it
  // but before this step recorded its outcome resumes the same round (and its review),
  // rather than starting the next feature past an unreviewed one.
  const pending = notes[REVIEW_FEATURE];
  if (pending && ctx.progress.featuresDone.includes(pending)) return outcome();
  const next = ctx.features.find((f) => f.id === pending) ?? left()[0];
  if (!next) return { outcome: DONE };
  if (pending !== next.id) {
    const base = await head(ctx);
    if (base) notes[REVIEW_BASE] = base;
    notes[REVIEW_FEATURE] = next.id;
    ctx.saveProgress();
  }
  // The plain handler works every feature it is given: give it those done and the next.
  await build({ ...ctx, features: ctx.features.slice(0, ctx.features.indexOf(next) + 1) });
  return outcome();
}

/** Between two features reviewed one by one: each gets its own fix loops. */
async function nextFeature(ctx: StepContext): Promise<StepResult> {
  ctx.progress.loops.fix = 0;
  ctx.progress.loops['review-fix'] = 0;
  delete ctx.progress.notes[REVIEW_FEATURE];
  return { outcome: DONE };
}

registerStepHandler('review', review);
registerStepHandler('review-fix', reviewFix);
registerStepHandler('track-features-reviewed', trackFeaturesReviewed);
registerStepHandler('next-feature', nextFeature);
