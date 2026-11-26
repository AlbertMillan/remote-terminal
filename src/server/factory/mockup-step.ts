import { existsSync, mkdirSync, unlinkSync, writeFileSync } from 'fs';
import { join } from 'path';
import { RunAbortedError, type ClaudeRunResult } from '../agent/claude-run.js';
import { createLogger } from '../utils/logger.js';
import { unitJobId } from './deps.js';
import { getIntake } from './intake-store.js';
import {
  MOCKUP_PAGE,
  MOCKUP_REVISIONS_MAX,
  MOCKUP_WALKTHROUGH,
  mockupDirFor,
  readMockupState,
  writeMockupState,
  type MockupState,
} from './mockup-files.js';
import { registerStepHandler, type StepContext, type StepResult } from './steps.js';
import { getItem } from './store.js';

const logger = createLogger('factory-mockup');

/**
 * The mockup step (project/code-factory.md: "mockup first inserts a mockup
 * step that parks for approval"). Runs only for an item flagged mockup-first
 * (the template's `when` on shaping's MOCKUP_OUTCOME), after shape and before
 * implement.
 *
 * A run in the item's worktree, with the worktree read-only (`allowedGlobs`
 * empty: runClaude reverts every edit there) and the item's mockup folder
 * added (`--add-dir`), builds one self-contained clickable HTML page and
 * replies with a short "what you'd do" walkthrough, which this step writes
 * beside it. Nothing goes into the worktree: `commitAll` would sweep it in.
 * Then the unit parks at `mockup`:
 *
 * - Approve (the release route's `approved`) settles the step; implement,
 *   the summary page and the reviewer get the page as their reference
 *   (mockup-files.ts `mockupReference`).
 * - Comment (mockup-routes.ts) stores your text and releases the unit; this
 *   step runs again, resumes the SAME mockup session with it, and parks again.
 *   After MOCKUP_REVISIONS_MAX comments it escalates: the route takes no more
 *   and the park says so.
 */

/** Read the project, write only in the added mockup folder (no Bash: nothing to run). */
const MOCKUP_TOOLS = ['Read', 'Glob', 'Grep', 'Edit', 'Write'];

export const MOCKUP_READY = 'mockup: ready for your approval';
export const MOCKUP_ESCALATED = 'mockup: escalated';

function mockupPrompt(ctx: StepContext, dir: string, comment: string | null): string {
  const f = ctx.features[0];
  const intake = getIntake(ctx.unit.projectCwd, f.id);
  const reqs = intake?.requirements.length ? `\nRequirements from the request:\n${intake.requirements.map((r) => `- ${r}`).join('\n')}\n` : '';
  const spec = f.spec ? `Spec: ${f.spec} (read it first)` : 'Spec: none; the title and requirements are the brief';
  const asked = comment ? `\nThe user already looked at an earlier mockup and said:\n${comment}\n` : '';
  return `The user asked to see a mockup before item ${f.id} is built: "${f.title}".
${spec}
${reqs}${asked}
Build a clickable HTML mockup of the change so the user can approve it before any code is
written. This repository (the current folder) is READ-ONLY for you: every edit here is reverted.

Write exactly one file: ${join(dir, MOCKUP_PAGE)}
- Self-contained: inline every style, script and image (data: URIs). It is served with a
  policy that blocks every network request, so nothing external or fetched will load.
- When the change is to UI in this app, build it as a REPLICA OF THE REAL PAGE: copy the
  page's own markup and styles from this repository (read them) so it looks like the app,
  with the new or changed parts working as clickable stand-ins (buttons, menus, dialogs,
  states toggled by inline script). Not a standalone walkthrough page or a wireframe.
- For something without a UI (an API, a CLI), mock what the user would see or type.
- Mark what is new or changed so it stands out from what already exists.

Then reply with ONLY a short markdown walkthrough (under 25 lines): "## What you'd do",
the steps to click through, then "## Open questions" for anything the mockup decides that
the user should confirm. The factory saves your reply beside the mockup.`;
}

function revisePrompt(dir: string, comment: string): string {
  return `The user looked at your mockup and commented:
${comment}

Revise ${join(dir, MOCKUP_PAGE)} accordingly (same rules: one self-contained file, a replica of
the real page, the repository stays untouched). Then reply with ONLY the updated walkthrough.`;
}

/**
 * One mockup run. With `resume`, the comment goes into the mockup's own
 * session; a resume that fails (the session is gone) builds afresh from
 * `resume.fallback`, the full prompt, which carries the comment too.
 */
async function run(
  ctx: StepContext,
  dir: string,
  prompt: string,
  resume: { session: string; fallback: string } | null
): Promise<ClaudeRunResult> {
  const cwd = ctx.unit.projectCwd;
  const tier = getItem(cwd, ctx.features[0].id)?.modelTier;
  const opts = {
    allowedTools: MOCKUP_TOOLS,
    addDirs: [dir],
    timeoutMs: ctx.deps.stepTimeoutMs(),
    signal: ctx.signal,
    failOnDenial: false,
    laneKey: cwd,
    tag: { projectCwd: cwd, kind: 'factory' as const, jobId: unitJobId(cwd, ctx.unit.unitId), stage: ctx.step.id },
    ...(tier ? { model: tier } : {}),
  };
  // No allowed globs: the worktree is read-only, and the post-run revert enforces it.
  if (resume) {
    try {
      return await ctx.deps.runClaude(ctx.worktree.path, prompt, [], { ...opts, resumeSessionId: resume.session });
    } catch (error) {
      if (error instanceof RunAbortedError || ctx.signal.aborted) throw error;
      logger.warn({ cwd, error: (error as Error).message }, 'factory mockup: resume failed, building afresh');
      return ctx.deps.runClaude(ctx.worktree.path, resume.fallback, [], opts);
    }
  }
  return ctx.deps.runClaude(ctx.worktree.path, prompt, [], opts);
}

function parkReason(state: MockupState): string {
  if (state.revisions >= MOCKUP_REVISIONS_MAX) {
    return `${MOCKUP_ESCALATED}: revised ${state.revisions} times without an approval; approve it as it stands, or cancel the item and file it again`;
  }
  return state.revisions > 0 ? `${MOCKUP_READY} (revision ${state.revisions})` : MOCKUP_READY;
}

export async function mockupStep(ctx: StepContext): Promise<StepResult> {
  const f = ctx.features[0];
  const dir = mockupDirFor(ctx.unit.projectCwd, f.id);
  const page = join(dir, MOCKUP_PAGE);
  const state = readMockupState(ctx.progress);
  const comment = state.comment;

  // Built and waiting (a release without a comment, a restart): park again, don't pay twice.
  if (!comment && state.ready && existsSync(page)) return { park: parkReason(state) };
  if (comment && state.revisions >= MOCKUP_REVISIONS_MAX) {
    writeMockupState(ctx.progress, { ...state, comment: null });
    return { park: parkReason(state) };
  }

  mkdirSync(dir, { recursive: true });
  const revising = Boolean(comment && state.session && state.ready && existsSync(page));
  if (!revising) {
    // A fresh build: a page left from a failed attempt must not pass for this one's.
    for (const file of [MOCKUP_PAGE, MOCKUP_WALKTHROUGH]) {
      try {
        unlinkSync(join(dir, file));
      } catch {
        // Not there.
      }
    }
  }
  const fresh = mockupPrompt(ctx, dir, comment);
  const result = revising
    ? await run(ctx, dir, revisePrompt(dir, comment as string), { session: state.session as string, fallback: fresh })
    : await run(ctx, dir, fresh, null);

  const ready = existsSync(page);
  const next: MockupState = {
    session: result.sessionId ?? state.session,
    // Only a page you can look at counts against the cap: a run that wrote none spent no revision.
    revisions: state.revisions + (comment && ready ? 1 : 0),
    // Kept until a page exists, so "Build it again" still carries what you asked for.
    comment: ready ? null : comment,
    ready,
  };
  writeMockupState(ctx.progress, next);
  if (!next.ready) {
    const tail = result.result.trim().slice(-1000);
    return { park: `mockup: the run wrote no ${MOCKUP_PAGE}; release it to try again\n\n${tail}` };
  }
  writeFileSync(join(dir, MOCKUP_WALKTHROUGH), `${result.result.trim()}\n`, 'utf-8');
  return { park: parkReason(next) };
}

registerStepHandler('mockup', mockupStep);
