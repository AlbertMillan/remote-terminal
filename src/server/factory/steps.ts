import type { ClaudeRunResult } from '../agent/claude-run.js';
import type { EngineDeps, UnitFeature, UnitRef, UnitWorktree } from './deps.js';
import type { MergeEntry } from './merge-sink.js';
import { DONE, type Progress, type WorkflowStep } from './templates.js';

/**
 * Step handlers: what each template step does. Templates name a handler, so a
 * later feature replaces one without touching the walk — the shaping pass
 * (f-wlr5dc) and the reviewer agent (f-o5veqv) are stubs here for that reason.
 */

export interface AgentRequest {
  prompt: string;
  /**
   * Continue the unit's working conversation (implement, features, fix,
   * summary) when it has one, sending `resumePrompt` (else `prompt`) into it.
   * A failed resume falls back to a fresh run of `prompt`. False starts a
   * fresh conversation every time (self-review: independent eyes).
   */
  work: boolean;
  resumePrompt?: string;
  /** `read` can run commands but every edit it makes is reverted. */
  access: 'write' | 'read';
}

export interface StepContext {
  unit: UnitRef;
  features: UnitFeature[];
  worktree: UnitWorktree;
  progress: Progress;
  step: WorkflowStep;
  signal: AbortSignal;
  deps: EngineDeps;
  agent(request: AgentRequest): Promise<ClaudeRunResult>;
  /** Commit everything in the worktree (with a `Feature:` trailer when given) and record the new HEAD. */
  commit(message: string, featureId?: string): Promise<void>;
  /** Persist `progress` now, mid-step (a track records each feature as it lands). */
  saveProgress(): void;
}

export type StepResult =
  | { outcome: string }
  /** Stop for the user; the step is taken again once they release the unit. */
  | { park: string }
  /** Hand the unit to the merge sink and let go of it. */
  | { handoff: MergeEntry };

export type StepHandler = (ctx: StepContext) => Promise<StepResult>;

const handlers = new Map<string, StepHandler>();

export function registerStepHandler(name: string, handler: StepHandler): void {
  handlers.set(name, handler);
}

export function stepHandler(name: string): StepHandler | null {
  return handlers.get(name) ?? null;
}

// ---------------------------------------------------------------------------

const specLine = (f: UnitFeature) => (f.spec ? `Spec: ${f.spec} (read it first; it is approved)` : 'Spec: none; the title is the brief');

const ASSUMPTIONS = `Where the spec leaves a decision open, make the sensible choice and note it in
your final message under "## Assumptions" instead of stopping to ask.`;

const NO_COMMIT = 'Do not commit; the factory commits your work.';

function implementPrompt(f: UnitFeature): string {
  return `Implement feature ${f.id}: ${f.title}
${specLine(f)}

1. Make the changes the spec plans, matching the surrounding code's conventions.
2. Write the tests it calls for and RUN them with the project's own test command.
3. Run the project's lint or typecheck if it has one and fix what you broke.
4. Stay inside its "Out of scope"; no unrelated refactors, no new dependencies.
${ASSUMPTIONS}
${NO_COMMIT}`;
}

registerStepHandler('shape', async () => {
  // Stub until the shaping pass (f-wlr5dc): a loose item runs on its title and
  // whatever spec its line already links.
  return { outcome: DONE };
});

registerStepHandler('implement', async (ctx) => {
  const f = ctx.features[0];
  await ctx.agent({ prompt: implementPrompt(f), work: true, access: 'write' });
  await ctx.commit(f.title, f.id);
  return { outcome: DONE };
});

/**
 * A track run as one agent: its features in plan order, in one conversation,
 * each committed on its own with its tick in the worktree's PROJECT.md. A
 * resumed run skips the features already committed, and for one already built
 * (agent finished, commit not made) only ticks and commits. The tick and the
 * commit are idempotent, so a run that died between them redoes them safely.
 */
registerStepHandler('track-features', async (ctx) => {
  const all = ctx.features;
  for (const f of all) {
    if (ctx.progress.featuresDone.includes(f.id)) continue;
    if (!ctx.progress.featuresBuilt.includes(f.id)) {
      await buildFeature(ctx, f);
      ctx.progress.featuresBuilt.push(f.id);
      ctx.saveProgress();
    }
    // May throw ProjectBusyError (the lock is never waited on): the runner steps
    // the unit aside, and the retry lands here again without re-running the agent.
    await ctx.deps.tickFeature(ctx.unit.projectCwd, ctx.worktree.path, f.id);
    await ctx.commit(f.title, f.id);
    ctx.progress.featuresBuilt = ctx.progress.featuresBuilt.filter((id) => id !== f.id);
    ctx.progress.featuresDone.push(f.id);
    ctx.saveProgress();
  }
  return { outcome: DONE };
});

async function buildFeature(ctx: StepContext, f: UnitFeature): Promise<void> {
  const all = ctx.features;
  const first = ctx.progress.featuresDone.length === 0;
  const plan = all.map((x) => `- ${x.id} ${x.title}${ctx.progress.featuresDone.includes(x.id) ? ' (done)' : ''}`).join('\n');
  const intro = `You are working the track "${ctx.unit.trackName}" in this worktree, one feature at a time,
in this order:
${plan}

Do only the feature named below now; the next ones come after it is committed.

`;
  await ctx.agent({
    prompt: `${intro}${implementPrompt(f)}`,
    // The conversation already holds the track; it needs only the next feature.
    resumePrompt: first ? undefined : `${f.id} is next.\n\n${implementPrompt(f)}`,
    work: true,
    access: 'write',
  });
}

registerStepHandler('verify', async (ctx) => {
  const commands = ctx.deps.verifyCommands(ctx.worktree.path);
  delete ctx.progress.notes.verify;
  for (const command of commands) {
    const result = await ctx.deps.runCommand(ctx.worktree.path, command, {
      timeoutMs: ctx.deps.stepTimeoutMs(),
      signal: ctx.signal,
    });
    if (!result.ok) {
      ctx.progress.notes.verify = `$ ${command}\n${result.output}`;
      return { outcome: 'fail' };
    }
  }
  return { outcome: 'pass' };
});

/** The verdict a self-review ends with: the last `{"verdict": …}` object in its reply. */
export function parseVerdict(text: string): { verdict: 'pass' | 'changes'; findings: string[] } | null {
  const candidates = [...text.matchAll(/\{[^{}]*"verdict"[^{}]*\}/g)];
  for (const match of candidates.reverse()) {
    try {
      const j = JSON.parse(match[0]) as { verdict?: unknown; findings?: unknown };
      if (j.verdict !== 'pass' && j.verdict !== 'changes') continue;
      const findings = Array.isArray(j.findings) ? j.findings.filter((x): x is string => typeof x === 'string') : [];
      return { verdict: j.verdict, findings };
    } catch {
      // Not JSON after all; try an earlier one.
    }
  }
  return null;
}

registerStepHandler('self-review', async (ctx) => {
  const specs = ctx.features.map((f) => `- ${f.id} ${f.title}: ${f.spec ?? 'no spec'}`).join('\n');
  const failed = ctx.progress.notes.verify ? `\nThe project's checks failed:\n${ctx.progress.notes.verify}\n` : '';
  const result = await ctx.agent({
    work: false,
    access: 'read',
    prompt: `Review the work on this branch against its spec before anyone else sees it.
Read the diff with \`git diff ${ctx.worktree.baseBranch}...HEAD\`.
Features:
${specs}
${failed}
Check that each spec is met, that the code fits the codebase (reuses what exists, adds no
dependency) and that tests cover it. Only real problems; no style nits. Do not edit files.

End with one line of JSON: {"verdict": "pass" | "changes", "findings": ["…", …]}`,
  });
  const verdict = parseVerdict(result.result);
  if (!verdict) {
    // A review that gave no verdict found nothing it would stand behind; the
    // summary and the reviewer still see the diff.
    ctx.progress.notes['self-review'] = 'self-review gave no verdict';
    return { outcome: 'pass' };
  }
  if (verdict.verdict === 'changes') {
    ctx.progress.notes['self-review'] = verdict.findings.map((x) => `- ${x}`).join('\n') || '- (no detail given)';
    return { outcome: 'changes' };
  }
  delete ctx.progress.notes['self-review'];
  return { outcome: 'pass' };
});

registerStepHandler('fix', async (ctx) => {
  const parts: string[] = [];
  if (ctx.progress.outcomes.verify === 'fail' && ctx.progress.notes.verify) {
    parts.push(`The project's checks fail:\n${ctx.progress.notes.verify}`);
  }
  if (ctx.progress.outcomes['self-review'] === 'changes' && ctx.progress.notes['self-review']) {
    parts.push(`A review of your branch found:\n${ctx.progress.notes['self-review']}`);
  }
  const prompt = `${parts.join('\n\n')}

Fix these, re-run the tests and lint, and stay inside the spec. ${NO_COMMIT}`;
  await ctx.agent({ prompt, work: true, access: 'write' });
  await ctx.commit(`fix: ${ctx.unit.isTrack ? ctx.unit.trackName : ctx.features[0].title}`);
  return { outcome: DONE };
});

registerStepHandler('summary', async (ctx) => {
  const sections = ctx.features.map((f) => `### ${f.id} ${f.title}`).join('\n');
  const result = await ctx.agent({
    work: true,
    access: 'read',
    prompt: `Write the summary page a reviewer reads instead of the whole diff. Reply with ONLY
its markdown:

## What changed
## Checks run (commands and results)
${sections}
## Assumptions (decisions you made instead of asking)

Base it on \`git diff ${ctx.worktree.baseBranch}...HEAD\` and what you did. Do not edit files.`,
  });
  ctx.progress.notes.summary = ctx.deps.writeSummary(ctx.unit.projectCwd, ctx.unit.unitId, result.result);
  return { outcome: DONE };
});

registerStepHandler('review', async () => {
  // Stub until the reviewer agent (f-o5veqv): every unit waits for the user,
  // the "me" setting, rather than merging unreviewed. Releasing it with the
  // outcome `approved` (engine.releaseParked) moves it on to merge.
  return { park: 'review: waiting for you (no reviewer agent yet)' };
});

registerStepHandler('merge', async (ctx) => ({
  handoff: {
    projectCwd: ctx.unit.projectCwd,
    kind: ctx.unit.isTrack ? 'track' : 'item',
    branch: ctx.worktree.branch,
    worktreePath: ctx.worktree.path,
    baseBranch: ctx.worktree.baseBranch,
    featureIds: [...ctx.unit.featureIds],
    ...(ctx.unit.isTrack ? { trackName: ctx.unit.trackName } : {}),
  },
}));
