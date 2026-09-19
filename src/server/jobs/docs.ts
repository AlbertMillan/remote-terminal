import { existsSync, readFileSync, realpathSync, statSync } from 'fs';
import { isAbsolute, relative, resolve, sep } from 'path';
import { createLogger } from '../utils/logger.js';
import { diffNumstat, listMarkdown, type ChangedFile } from './worktree.js';

const logger = createLogger('job-docs');

/**
 * The documents behind a job's question.
 *
 * A stage writes its spec — and may edit other docs — inside the job's
 * worktree, commits them to the job branch, and then parks asking about what it
 * wrote. None of that is in the user's checkout, so without this the question
 * cites sections of a file that exists only on a branch they have never seen.
 *
 * Two kinds of document are listed, and the difference is the point:
 *  - what this branch CHANGED, from the diff — exact, and the part the user had
 *    no way of knowing about;
 *  - the markdown that was already there — the context a question cites when it
 *    only READ a file.
 */

/** Don't ship a whole book to the browser; the viewer is for documents. */
const MAX_FILE_CHARS = 400_000;
/** A repo can hold hundreds of markdown files; the tail is never opened. */
const MAX_DOCS = 300;

export interface JobDoc {
  path: string;
  status: ChangedFile['status'] | 'unchanged';
  insertions: number;
  deletions: number;
  /** The spec this job's design stage wrote — the document a question is about. */
  isSpec: boolean;
  /**
   * Section numbers of the headings in this document ("3.2", "6.9"), used to
   * resolve the references a question makes. Empty for non-markdown.
   */
  headings: string[];
}

/**
 * Resolve a browser-supplied path inside the worktree, or null.
 *
 * The path round-trips through the client, so it is untrusted input — the same
 * stance history-delete.ts takes towards marker text. Symlinks are resolved
 * before the containment check, so a link inside the worktree cannot be used to
 * read the rest of the disk.
 */
export function resolveInWorktree(worktreePath: string, rel: string): string | null {
  if (!rel || isAbsolute(rel) || rel.includes('\0')) return null;
  const abs = resolve(worktreePath, rel);
  if (!contains(worktreePath, abs)) return null;
  try {
    // realpath throws for a path that does not exist yet, which is not a
    // containment failure — the caller reports it as "missing" instead.
    if (!existsSync(abs)) return abs;
    const real = realpathSync(abs);
    const realRoot = realpathSync(worktreePath);
    if (!contains(realRoot, real)) return null;
    return real;
  } catch {
    return null;
  }
}

function contains(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel) && !rel.startsWith(`..${sep}`);
}

/** Read one document, capped. Null when it is missing or unreadable. */
export function readDoc(
  worktreePath: string,
  rel: string
): { text: string; truncated: boolean } | null {
  const abs = resolveInWorktree(worktreePath, rel);
  if (!abs) {
    logger.warn({ worktreePath, rel }, 'job-docs: refusing a path outside the worktree');
    return null;
  }
  try {
    if (!statSync(abs).isFile()) return null;
    const text = readFileSync(abs, 'utf-8');
    return { text: text.slice(0, MAX_FILE_CHARS), truncated: text.length > MAX_FILE_CHARS };
  } catch {
    return null;
  }
}

/**
 * Every document this job can show, changed ones first.
 *
 * Changed files are listed whatever their type — what a run edited is what the
 * user most needs to see — while the unchanged tail is markdown only, since
 * that half exists to supply the prose a question quotes.
 */
export async function listJobDocs(
  worktreePath: string,
  baseBranch: string,
  specPath: string | null = null
): Promise<JobDoc[]> {
  if (!existsSync(worktreePath)) return [];

  let changed: ChangedFile[] = [];
  let markdown: string[] = [];
  try {
    [changed, markdown] = await Promise.all([
      diffNumstat(worktreePath, baseBranch),
      listMarkdown(worktreePath),
    ]);
  } catch (error) {
    logger.warn({ worktreePath, error }, 'job-docs: could not list documents');
    return [];
  }

  const docs: JobDoc[] = changed.map((file) => ({
    path: file.path,
    status: file.status,
    insertions: file.insertions,
    deletions: file.deletions,
    isSpec: normalise(file.path) === normalise(specPath),
    headings: [],
  }));

  const seen = new Set(docs.map((d) => d.path));
  for (const path of markdown) {
    if (seen.has(path)) continue;
    seen.add(path);
    docs.push({
      path,
      status: 'unchanged',
      insertions: 0,
      deletions: 0,
      isSpec: normalise(path) === normalise(specPath),
      headings: [],
    });
  }

  // Deleted files have nothing to read; they still belong in the list, since
  // "this run deleted your spec" is exactly the kind of thing to surface.
  for (const doc of docs) {
    if (doc.status === 'deleted' || !isMarkdown(doc.path)) continue;
    const read = readDoc(worktreePath, doc.path);
    if (read) doc.headings = headingNumbers(read.text);
  }

  // The spec leads: it is the document the question was written against.
  docs.sort((a, b) => Number(b.isSpec) - Number(a.isSpec));
  return docs.slice(0, MAX_DOCS);
}

/** git reports forward slashes; a spec path recorded on Windows may not. */
function normalise(path: string | null): string | null {
  return path ? path.replace(/\\/g, '/') : null;
}

function isMarkdown(path: string): boolean {
  return /\.(md|markdown)$/i.test(path);
}

/**
 * The numbered headings in a document, for resolving a `§3.2` in a question.
 *
 * Matches a markdown heading that opens with a number ("### 3.2 Ingestion") and
 * a bare numbered line used as one ("3.2 Ingestion"), with or without a leading
 * `§`. A number with no title after it is not a heading — that is a list item,
 * a version or a measurement.
 *
 * A single-level number counts only under a `#`, where the file has already
 * said the line is a heading. A bare "3 Retries" is far more often prose.
 */
export function headingNumbers(text: string): string[] {
  const found = new Set<string>();
  for (const line of text.split('\n')) {
    const heading = /^\s{0,3}#{1,6}\s*§?\s*(\d+(?:\.\d+)*)[.)]?\s+\S/.exec(line);
    if (heading) {
      found.add(heading[1]);
      continue;
    }
    const numbered = /^\s{0,3}§?\s*(\d+(?:\.\d+)+)[.)]?\s+\S/.exec(line);
    if (numbered) found.add(numbered[1]);
  }
  return [...found];
}
