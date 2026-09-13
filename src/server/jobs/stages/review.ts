import { existsSync, readFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { createLogger } from '../../utils/logger.js';
import { getConfig } from '../../config.js';
import { runClaude, type UsageSink } from '../../agent/claude-run.js';
import { COMPANION_DIR, REVIEWS_DIR, ensureReviewsIgnored } from '../../projects/project-store.js';
import { findingsRelPath, readFindings, summarize, type FindingsFile } from '../findings.js';
import { diffAgainst } from '../worktree.js';

const logger = createLogger('stage-review');

/**
 * Review stage: run the user's own code-review criteria over the job's diff and
 * emit machine-readable findings for the gate.
 *
 * The criteria are deliberately NOT owned by this pipeline. They are read from
 * the user's `/code-review` command file at dispatch time, so editing that file
 * changes every future review — one source of truth, theirs. We only append the
 * structured-output requirement the UI needs to offer checkboxes.
 */

/** Where the user's own review criteria live. */
const USER_REVIEW_COMMAND = join(homedir(), '.claude', 'commands', 'code-review.md');

/** Cap the diff handed to the reviewer; past this it stops being reviewable. */
const MAX_DIFF_CHARS = 60_000;

/**
 * Fallback criteria, used only when the user has no /code-review command.
 * Deliberately terse: the real criteria are the user's file, and a long
 * built-in default would quietly compete with it.
 */
const FALLBACK_CRITERIA = `Review for correctness bugs and edge cases, security and input validation,
performance problems, and maintainability (duplication, unclear naming, missing
error handling). Prefer a few high-value findings over an exhaustive list.`;

export interface ReviewResult {
  findings: FindingsFile | null;
  summary: string;
  claudeSessionId: string | null;
}

/** Read the user's review criteria, falling back when they have none. */
export function loadReviewCriteria(path = USER_REVIEW_COMMAND): {
  criteria: string;
  source: string;
} {
  try {
    if (existsSync(path)) {
      const text = readFileSync(path, 'utf-8').trim();
      if (text) return { criteria: text, source: path };
    }
  } catch {
    // fall through to the default
  }
  return { criteria: FALLBACK_CRITERIA, source: '(built-in default)' };
}

function buildReviewPrompt(opts: {
  criteria: string;
  diff: string;
  truncated: boolean;
  findingsPath: string;
  specPath: string | null;
}): string {
  const { criteria, diff, truncated, findingsPath, specPath } = opts;

  return `Review the change below against the criteria that follow, then write your
findings as JSON.

=== REVIEW CRITERIA (the user's own standards — apply these) ===
${criteria}
=== END CRITERIA ===

${specPath ? `The change implements the approved spec at ${specPath}; read it for intent.\n` : ''}
WHAT TO REVIEW
Only the change shown in the diff below, and the code it touches. Do not review
the rest of the repository, and do not raise pre-existing issues the change did
not introduce unless the change makes them materially worse.

OUTPUT — write ${findingsPath} containing EXACTLY this JSON shape:

{
  "findings": [
    {
      "id": "r1",
      "severity": "critical",
      "file": "src/example.ts",
      "line": 42,
      "title": "<one line, under 80 chars, the defect itself>",
      "detail": "<why it is wrong and what goes wrong because of it>",
      "suggestion": "<the specific change you would make>"
    }
  ]
}

RULES
- severity is exactly one of "critical", "important", "nice".
  critical = a bug, security hole, or data-loss risk that should block the merge.
  important = real technical debt or a maintainability problem worth fixing now.
  nice = an optional improvement.
- Every finding must name a real file from the diff, and a line where you can.
- "suggestion" must be concrete enough that someone could act on it without
  asking you a follow-up question.
- Report ONLY what you would genuinely raise in a review. An empty findings
  array is a valid and useful answer; do not pad the list to look thorough.
- The JSON must be valid. Write the file even if there are no findings.
- Do NOT fix anything. This stage only reports; the user chooses what to act on.

=== DIFF ===
${diff}${truncated ? '\n\n[diff truncated]' : ''}`;
}

/**
 * Run the review pass in the job's worktree.
 *
 * Writes are scoped to the reviews folder, so the reviewer physically cannot
 * "helpfully" fix what it finds — the whole point is that the user picks.
 */
export async function runReviewStage(opts: {
  jobId: string;
  worktreePath: string;
  baseBranch: string;
  specPath: string | null;
  onUsage?: UsageSink;
}): Promise<ReviewResult> {
  const { jobId, worktreePath, baseBranch, specPath, onUsage } = opts;

  const fullDiff = await diffAgainst(worktreePath, baseBranch);
  if (!fullDiff.trim()) {
    logger.info({ jobId }, 'review: nothing to review');
    return { findings: null, summary: 'no changes to review', claudeSessionId: null };
  }

  // Keep findings out of the repo. Deliberately only in the WORKTREE: writing
  // into the real project directory would dirty the user's tree behind their
  // back, which is the exact isolation guarantee this pipeline exists to keep
  // (and it then trips the merge stage's dirty-tree guard). The rule rides in
  // on the job's own branch and lands with the merge like any other change.
  ensureReviewsIgnored({ cwd: worktreePath });

  const { criteria, source } = loadReviewCriteria();
  const truncated = fullDiff.length > MAX_DIFF_CHARS;

  const prompt = buildReviewPrompt({
    criteria,
    diff: fullDiff.slice(0, MAX_DIFF_CHARS),
    truncated,
    findingsPath: findingsRelPath(jobId),
    specPath,
  });

  logger.info({ jobId, criteriaSource: source, truncated }, 'review: running');
  const result = await runClaude(
    worktreePath,
    prompt,
    [`${COMPANION_DIR}/${REVIEWS_DIR}/**`],
    {
      allowedTools: ['Read', 'Glob', 'Grep', 'Write'],
      timeoutMs: getConfig().projectLog.timeoutMs,
      failOnDenial: false,
      onUsage,
    }
  );

  const findings = readFindings(worktreePath, jobId);
  if (!findings) {
    throw new Error('The review run finished without writing findings');
  }

  const summary = summarize(findings);
  logger.info({ jobId, summary }, 'review: finished');
  return { findings, summary, claudeSessionId: result.sessionId };
}
