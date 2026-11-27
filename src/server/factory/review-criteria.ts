import { existsSync, readFileSync } from 'fs';

/**
 * The reviewer agent's criteria: the user's own `/code-review` command file,
 * read at review time, so editing that file changes every future review (one
 * source of truth, theirs). Only when there is none does this terse fallback
 * apply; a long built-in default would quietly compete with the user's file.
 */
const FALLBACK_CRITERIA = `Review for correctness bugs and edge cases, security and input validation,
performance problems, and maintainability (duplication, unclear naming, missing
error handling). Prefer a few high-value findings over an exhaustive list.`;

/** Read the user's review criteria, falling back when they have none. */
export function loadReviewCriteria(path: string): {
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
