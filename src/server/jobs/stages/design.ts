import { existsSync, mkdirSync, readFileSync } from 'fs';
import { dirname, join } from 'path';
import { createLogger } from '../../utils/logger.js';
import { getConfig } from '../../config.js';
import { runClaude } from '../../agent/claude-run.js';
import { COMPANION_DIR } from '../../projects/project-store.js';
import type { Job } from '../types.js';

const logger = createLogger('stage-design');

/**
 * Design stage: turn a feature into an agreed spec before any code is written.
 *
 * This is the first gate for a reason — the expensive failure mode is building
 * the wrong thing correctly. The stage must therefore surface its *decisions*,
 * not just its conclusions, and it must stop rather than guess when something
 * is genuinely ambiguous.
 */

/** Marker the stage writes when it needs a human decision before continuing. */
export const OPEN_QUESTION_MARKER = '## Open questions';

export interface DesignResult {
  specPath: string; // path relative to the project root
  /** Question the run parked on, or null when the spec is complete. */
  openQuestion: string | null;
  claudeSessionId: string | null;
}

/** Slug for a feature's spec file, stable enough to find again. */
export function specSlugFor(title: string, featureId: string | null): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  return slug || (featureId ?? 'feature');
}

function buildDesignPrompt(opts: {
  job: Job;
  specPath: string;
  existingSpec: string | null;
  answer: string | null;
}): string {
  const { job, specPath, existingSpec, answer } = opts;

  const resuming = existingSpec
    ? `\nA previous design pass already wrote this spec:\n\n---\n${existingSpec.slice(0, 8000)}\n---\n`
    : '';

  const answered = answer
    ? `\nThe user has answered the open question from the previous pass:\n\n"${answer}"\n\nIncorporate that answer, REMOVE the "${OPEN_QUESTION_MARKER}" section, and complete the spec.\n`
    : '';

  return `You are designing one feature before any code is written. Write a spec, not code.

Feature: ${job.title}
Project: ${job.projectCwd}
Spec file to write: ${specPath}
${resuming}${answered}
WHAT TO DO
1. Read CLAUDE.md and README for project conventions, and PROJECT.md for how this
   feature relates to the rest of the work.
2. Read the code this feature would touch. Ground the design in what is actually
   there — existing helpers, patterns and naming — rather than inventing a new
   shape alongside them.
3. Write ${specPath} with EXACTLY these sections:

## Goal
One paragraph: what this feature does and why, in terms of observable behaviour.

## Design decisions
The choices you made and WHY, including the alternatives you rejected. Each
decision as a "- **<decision>** — <rationale>" bullet. This is the section the
user reviews before approving, so a decision they would disagree with must be
visible here, not buried in the plan.

## Planned changes
The concrete edits, as a list of "- \`path/to/file.ts\` — <what changes>".
Name files that already exist wherever possible. Anything you intend to create
should say "(new)".

## Verification
How to prove it works: the tests to add or run, and what to check by hand.

## Out of scope
What this feature deliberately does NOT do, so the implement stage stays bounded.

IF SOMETHING IS GENUINELY AMBIGUOUS
Do NOT guess, and do not pick an option just to finish. Add a final section:

${OPEN_QUESTION_MARKER}
- <the question, with the options you see and what you would recommend>

Ask only about decisions that would change what gets built and that the code
cannot settle. A question you can answer by reading the repo is not an open
question. If there is nothing genuinely ambiguous, omit this section entirely.

STRICT CONSTRAINTS
- Write ONLY ${specPath}. Do not modify any source file, and do not write code.
- Be concrete and short. Every line should tell the implementer something they
  could not infer from the feature title.`;
}

/**
 * Run the design pass inside the job's worktree.
 *
 * Writes are scoped to the companion folder, and runClaude reverts anything
 * outside it — so a design pass physically cannot start implementing.
 */
export async function runDesignStage(opts: {
  job: Job;
  worktreePath: string;
  /** Answer to the previous pass's open question, when re-running after one. */
  answer?: string | null;
}): Promise<DesignResult> {
  const { job, worktreePath, answer = null } = opts;

  const slug = specSlugFor(job.title, job.featureId);
  const specRel = `${COMPANION_DIR}/${slug}.md`;
  const specAbs = join(worktreePath, specRel);

  const existingSpec = existsSync(specAbs) ? readFileSync(specAbs, 'utf-8') : null;

  mkdirSync(dirname(specAbs), { recursive: true });

  const prompt = buildDesignPrompt({ job, specPath: specRel, existingSpec, answer });

  logger.info({ jobId: job.id, specRel }, 'design: running');
  // Deliberately no Bash: a design pass reads code, it does not execute it. The
  // model will reach for a shell anyway and be refused, which is fine — the
  // stage's contract is "a spec exists", verified below, so denials are not
  // treated as failure.
  const result = await runClaude(worktreePath, prompt, [`${COMPANION_DIR}/**`], {
    allowedTools: ['Read', 'Glob', 'Grep', 'Write', 'Edit'],
    timeoutMs: getConfig().projectLog.timeoutMs,
    failOnDenial: false,
  });

  if (!existsSync(specAbs)) {
    throw new Error('The design run finished without writing a spec');
  }

  const spec = readFileSync(specAbs, 'utf-8');
  return {
    specPath: specRel,
    openQuestion: extractOpenQuestion(spec),
    claudeSessionId: result.sessionId,
  };
}

/**
 * Pull the open question out of a spec, or null when the design is settled.
 * Exported for testing: whether a job parks or proceeds hinges entirely on this.
 */
export function extractOpenQuestion(spec: string): string | null {
  const index = spec.indexOf(OPEN_QUESTION_MARKER);
  if (index === -1) return null;

  const after = spec.slice(index + OPEN_QUESTION_MARKER.length);
  // The section runs to the next heading of the same or higher level.
  const end = after.search(/\n#{1,2}\s/);
  const body = (end === -1 ? after : after.slice(0, end)).trim();
  return body || null;
}
