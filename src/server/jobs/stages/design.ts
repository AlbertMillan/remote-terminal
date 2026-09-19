import { existsSync, mkdirSync, readFileSync } from 'fs';
import { dirname, join } from 'path';
import { createLogger } from '../../utils/logger.js';
import { getConfig } from '../../config.js';
import { RunAbortedError, runClaude, type UsageSink } from '../../agent/claude-run.js';
import { COMPANION_DIR } from '../../projects/project-store.js';
import type { Job } from '../types.js';

const logger = createLogger('stage-design');

/**
 * Design stage: turn a feature into an agreed spec before any code is written.
 *
 * The expensive failure is building the wrong thing correctly, so the stage
 * surfaces its DECISIONS rather than just its conclusions, and stops rather than
 * guess. A question it parks on must be answerable with nothing but itself in
 * front of you — hence the quoting rule in the prompt below.
 * See `docs/job-decisions.md`.
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
At most five bullets, one or two sentences each, as "- **<decision>** — <why>".
This is the section the user reviews before approving, so a decision they would
disagree with must be visible here — but a decision nobody would argue with
needs no defence. Name a rejected alternative only where you nearly chose it.

## Planned changes
One line per file: "- \`path/to/file.ts\` — <what changes>". Name files that
already exist wherever possible; anything you intend to create says "(new)".
No prose between the lines.

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

Write every question so it can be answered WITHOUT opening anything. The person
answering sees your question and nothing else — not this spec, not the files you
read — so a bare reference carries none of its meaning across:

- Citing a section, a numbered item or another document? QUOTE the line it says,
  in the question itself. "§3.2", "Question 2" and "the spec" are unanswerable
  on their own.
- Refer to files by their path, and say what you changed in each one you edited.
- Spell out any term, code or constant the answer turns on, rather than assuming
  the reader has it in front of them.

LENGTH
Match the spec to the size of the change, and err short. A change to one or two
files should be done in about 40 lines; 120 lines is a hard ceiling whatever the
feature. Cut every sentence that justifies a decision nobody would question,
restates the code, or explains the same point a second way — a reviewer reads
this to approve it, not to be convinced of it.

STRICT CONSTRAINTS
- Write ONLY ${specPath}. Do not modify any source file, and do not write code.
- A visual mockup is allowed when a screen's layout is the thing in question:
  write it as an HTML file NEXT TO the spec, under ${COMPANION_DIR}/, and link it
  from the spec. Anything written outside ${COMPANION_DIR}/ is reverted after the
  run, so a mockup put anywhere else is silently lost.
- Be concrete. Every line should tell the implementer something they could not
  infer from the feature title.`;
}

/**
 * The follow-up sent to a RESUMED design session.
 *
 * The session already read the repository and wrote the spec, so this says only
 * what changed: the answer. Re-running design instead means a fresh session
 * that rediscovers everything — measured at 23 turns and 1.45M cache-read
 * tokens on a one-file feature, to re-learn what the first pass already knew.
 */
function buildAnswerPrompt(specPath: string, answer: string): string {
  return `The user has answered your open question:

"${answer}"

Fold that answer into ${specPath}: update the sections it affects and REMOVE the
"${OPEN_QUESTION_MARKER}" section entirely. You already have what you need from
the repository — re-read a file only if the answer genuinely turns on something
you have not seen. Change nothing else, and keep the spec within its length
budget.`;
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
  /**
   * The session that asked the question, continued rather than replaced when
   * an answer arrives.
   */
  resumeSessionId?: string | null;
  /** Records what the run consumed; see runner.ts. */
  onUsage?: UsageSink;
  /** Aborts the underlying claude run when the job is cancelled. */
  signal?: AbortSignal;
  /** Queue lane and spawn notification; see runner.ts. */
  laneKey?: string;
  onSpawn?: () => void;
}): Promise<DesignResult> {
  const {
    job,
    worktreePath,
    answer = null,
    resumeSessionId = null,
    onUsage,
    signal,
    laneKey,
    onSpawn,
  } = opts;

  const slug = specSlugFor(job.title, job.featureId);
  const specRel = `${COMPANION_DIR}/${slug}.md`;
  const specAbs = join(worktreePath, specRel);

  const existingSpec = existsSync(specAbs) ? readFileSync(specAbs, 'utf-8') : null;

  mkdirSync(dirname(specAbs), { recursive: true });

  // Deliberately no Bash: a design pass reads code, it does not execute it. The
  // model will reach for a shell anyway and be refused, which is fine — the
  // stage's contract is "a spec exists", verified below, so denials are not
  // treated as failure.
  const runOptions = {
    allowedTools: ['Read', 'Glob', 'Grep', 'Write', 'Edit'],
    timeoutMs: getConfig().jobs.stageTimeoutMs,
    signal,
    failOnDenial: false,
    onUsage,
    laneKey,
    onSpawn,
  };

  const fullPrompt = () => buildDesignPrompt({ job, specPath: specRel, existingSpec, answer });
  const canResume = Boolean(answer && resumeSessionId);

  logger.info({ jobId: job.id, specRel, resumed: canResume }, 'design: running');

  let result;
  if (canResume) {
    try {
      result = await runClaude(worktreePath, buildAnswerPrompt(specRel, answer as string), [
        `${COMPANION_DIR}/**`,
      ], { ...runOptions, resumeSessionId: resumeSessionId as string });
    } catch (error) {
      // A cancelled run is the user's decision, not a broken resume.
      if (error instanceof RunAbortedError) throw error;
      // The transcript can be gone, or the session unusable. Falling back to a
      // fresh pass costs what the old behaviour always cost, so the worst case
      // of resuming is the previous status quo.
      logger.warn(
        { jobId: job.id, error: (error as Error).message },
        'design: resume failed, re-running the pass from scratch'
      );
      result = await runClaude(worktreePath, fullPrompt(), [`${COMPANION_DIR}/**`], runOptions);
    }
  } else {
    result = await runClaude(worktreePath, fullPrompt(), [`${COMPANION_DIR}/**`], runOptions);
  }

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
