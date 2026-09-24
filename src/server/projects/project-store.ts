import { createHash } from 'crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'fs';
import { dirname, isAbsolute, join, relative, resolve } from 'path';
import { createLogger } from '../utils/logger.js';
import { docPathFor, type RegistryProject } from './registry.js';
import { resolveInWorktree } from '../jobs/docs.js';
import {
  healMissingIds,
  parseProjectDoc,
  renderProjectDoc,
  type ProjectDoc,
} from './project-doc-format.js';

const logger = createLogger('project-store');

/**
 * Read/modify/write for a project's canonical PROJECT.md.
 *
 * The file is human-owned: it lives in the repo, is edited by hand, by the
 * migration agent, and by pipeline stages. So every UI write carries a
 * `revision` precondition and fails with 409 when the file moved underneath it
 * — the same staleness contract deleteHistoryEntry() uses for entry indices,
 * for the same reason (the board is a poll snapshot and may be stale).
 */
export class ProjectStoreError extends Error {
  constructor(
    message: string,
    readonly status: number
  ) {
    super(message);
    this.name = 'ProjectStoreError';
  }
}

export interface ProjectDocState {
  cwd: string;
  path: string; // absolute path to the index document
  exists: boolean;
  /** Content fingerprint; pass back on write to detect concurrent edits. */
  revision: string;
  mtimeMs: number;
  doc: ProjectDoc;
}

/** Fingerprint of the exact bytes on disk. Empty file and missing file differ. */
export function revisionOf(content: string | null): string {
  if (content === null) return 'absent';
  return createHash('sha256').update(content, 'utf8').digest('hex').slice(0, 16);
}

function readFileOrNull(path: string): string | null {
  try {
    return readFileSync(path, 'utf-8');
  } catch {
    return null;
  }
}

function mtimeOf(path: string): number {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return 0;
  }
}

/**
 * Load a project's index. A missing file yields an empty-but-valid doc with
 * revision 'absent', so callers can treat "no PROJECT.md yet" and "empty
 * PROJECT.md" through one code path.
 */
export function readProjectDoc(project: RegistryProject): ProjectDocState {
  const path = docPathFor(project);
  const content = readFileOrNull(path);
  return {
    cwd: project.cwd,
    path,
    exists: content !== null,
    revision: revisionOf(content),
    mtimeMs: mtimeOf(path),
    doc: parseProjectDoc(content ?? ''),
  };
}

/**
 * Write the document back, refusing if the on-disk bytes no longer match
 * `expectedRevision`. Pass `null` to skip the check (only for writes that
 * genuinely don't care, such as the initial migration).
 *
 * The write is atomic via a temp file + rename, so an interrupted write can
 * never leave a half-written PROJECT.md — this file is the source of truth for
 * the whole board.
 */
export function writeProjectDoc(
  project: RegistryProject,
  doc: ProjectDoc,
  expectedRevision: string | null
): ProjectDocState {
  const path = docPathFor(project);

  if (expectedRevision !== null) {
    const current = revisionOf(readFileOrNull(path));
    if (current !== expectedRevision) {
      throw new ProjectStoreError(
        'PROJECT.md changed on disk since it was read — reload and retry.',
        409
      );
    }
  }

  const markdown = renderProjectDoc(doc);
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}`;
  try {
    writeFileSync(tmp, markdown, 'utf-8');
    renameSync(tmp, path);
  } catch (error) {
    logger.error({ error, path }, 'project-store: write failed');
    throw new ProjectStoreError('Failed to write PROJECT.md', 500);
  }

  return {
    cwd: project.cwd,
    path,
    exists: true,
    revision: revisionOf(markdown),
    mtimeMs: mtimeOf(path),
    doc,
  };
}

/**
 * Read, apply `mutate`, and write back under the revision precondition. The
 * mutation runs against a freshly parsed doc, so callers never operate on a
 * board snapshot that may be minutes old.
 *
 * Ids missing from hand-written lines are healed before mutating, so a feature
 * added by hand becomes addressable the first time the UI touches the file.
 */
export function mutateProjectDoc<T>(
  project: RegistryProject,
  expectedRevision: string | null,
  mutate: (doc: ProjectDoc) => T
): { state: ProjectDocState; result: T } {
  const state = readProjectDoc(project);
  if (expectedRevision !== null && state.revision !== expectedRevision) {
    throw new ProjectStoreError(
      'PROJECT.md changed on disk since it was read — reload and retry.',
      409
    );
  }
  healMissingIds(state.doc);
  const result = mutate(state.doc);
  // Write against the revision we just read, closing the gap between the
  // precondition check and the write itself.
  const written = writeProjectDoc(project, state.doc, state.revision);
  return { state: written, result };
}

// --- Companion files -------------------------------------------------------
// Specs, QA instructions, and review findings live in a folder beside the index.

/** Folder name holding specs/QA/reviews, as a sibling of the index document. */
export const COMPANION_DIR = 'project';

/** Review findings are per-job scratch output; they must never reach the repo. */
export const REVIEWS_DIR = 'reviews';

export function companionRoot(project: RegistryProject): string {
  return join(dirname(docPathFor(project)), COMPANION_DIR);
}

export function qaDocPath(project: RegistryProject): string {
  return join(companionRoot(project), 'QA.md');
}

export function reviewsDir(project: RegistryProject): string {
  return join(companionRoot(project), REVIEWS_DIR);
}

/**
 * Resolve a spec path recorded in PROJECT.md to an absolute path, refusing
 * anything that escapes the project directory. Spec links come from a
 * hand-editable markdown file, so they are untrusted input — the same posture
 * history-delete.ts takes toward marker session ids.
 */
export function resolveSpecPath(project: RegistryProject, spec: string): string | null {
  if (!spec || isAbsolute(spec)) return null;
  const abs = resolve(project.cwd, spec);
  const rel = relative(project.cwd, abs);
  if (rel.startsWith('..') || isAbsolute(rel)) return null;
  return abs;
}

/** Read a feature's spec file, or null when it is missing/unsafe/unreadable. */
export function readSpec(project: RegistryProject, spec: string | null): string | null {
  if (!spec) return null;
  // Reading follows symlinks, so resolve them before the containment check
  // (resolveSpecPath alone is lexical — right for deleting a link, not for
  // reading through one).
  const abs = resolveSpecPath(project, spec) ? resolveInWorktree(project.cwd, spec) : null;
  if (!abs) {
    logger.warn({ cwd: project.cwd, spec }, 'project-store: refusing spec path outside project');
    return null;
  }
  return readFileOrNull(abs);
}

/**
 * Ensure the review-findings directory is gitignored. Findings are per-job
 * scratch that would otherwise land in every commit; the user asked for them
 * beside PROJECT.md but out of the repo.
 *
 * Appends to the project's .gitignore only when the rule isn't already covered,
 * and never rewrites existing lines.
 */
export function ensureReviewsIgnored(project: RegistryProject): boolean {
  const rule = `${COMPANION_DIR}/${REVIEWS_DIR}/`;
  const gitignorePath = join(project.cwd, '.gitignore');
  const existing = readFileOrNull(gitignorePath);

  if (existing !== null) {
    const lines = existing.split(/\r?\n/).map((l) => l.trim());
    if (lines.includes(rule) || lines.includes(`/${rule}`) || lines.includes(rule.slice(0, -1))) {
      return false;
    }
  }

  const prefix = existing === null ? '' : existing.endsWith('\n') ? '' : '\n';
  const block = `${prefix}\n# claude-remote: per-job review findings (scratch, not source)\n${rule}\n`;
  try {
    writeFileSync(gitignorePath, (existing ?? '') + block, 'utf-8');
    logger.info({ cwd: project.cwd, rule }, 'project-store: added reviews dir to .gitignore');
    return true;
  } catch (error) {
    logger.warn({ error, cwd: project.cwd }, 'project-store: could not update .gitignore');
    return false;
  }
}

/** True when the project already has a canonical index. */
export function hasProjectDoc(project: RegistryProject): boolean {
  return existsSync(docPathFor(project));
}
