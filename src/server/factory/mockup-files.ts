import { isAbsolute, join, relative, resolve } from 'path';
import { getConfig } from '../config.js';
import { projectHash } from './deps.js';
import type { Progress } from './templates.js';

/**
 * Where an item's mockup lives and what the unit remembers about it
 * (project/code-factory.md, "Mockup-first step served from the item's prompt
 * folder"). Pure helpers shared by the step (mockup-step.ts), the routes
 * (mockup-routes.ts) and the prompts that reference an approved mockup
 * (steps.ts, review-step.ts); importing none of them keeps the graph acyclic.
 *
 * The folder is `<dataDir>/factory/<project hash>/<feature id>/mockup`, beside
 * the item's shaped spec and summary page and outside every worktree: a file
 * in a worktree would be swept into the next `commitAll`.
 */

/** The page the mockup agent writes and the drawer frames. */
export const MOCKUP_PAGE = 'index.html';
/** The "what you'd do" walkthrough, the agent's reply written by the step. */
export const MOCKUP_WALKTHROUGH = 'walkthrough.md';
/** Comments a mockup takes before it escalates (parks for approve-or-cancel only). */
export const MOCKUP_REVISIONS_MAX = 3;
/** progress.notes key holding MockupState as JSON. */
export const MOCKUP_NOTE = 'mockup';

const HASH = /^[0-9a-f]{8}$/;
const FEATURE = /^f-[a-z0-9]+$/;

export function mockupDirOf(dataDir: string, hash: string, featureId: string): string {
  return join(dataDir, 'factory', hash, featureId, 'mockup');
}

export function mockupDirFor(projectCwd: string, featureId: string): string {
  return mockupDirOf(getConfig().persistence.dataDir, projectHash(projectCwd), featureId);
}

/** The route the mockup is served from, relative links included (mockup-routes.ts). */
export function mockupUrl(projectCwd: string, featureId: string, file = MOCKUP_PAGE): string {
  return `/api/factory/mockup/${projectHash(projectCwd)}/${featureId}/${file}`;
}

export interface MockupState {
  /** The mockup conversation, resumed by a comment. Never the unit's working session. */
  session: string | null;
  /** Comments already revised. */
  revisions: number;
  /** Your comment waiting for the next run of the step. */
  comment: string | null;
  /** The page exists and waits for (or got) your approval. */
  ready: boolean;
}

export function readMockupState(progress: Progress): MockupState {
  let raw: Partial<MockupState> = {};
  try {
    const parsed = JSON.parse(progress.notes[MOCKUP_NOTE] ?? '{}') as unknown;
    if (parsed && typeof parsed === 'object') raw = parsed as Partial<MockupState>;
  } catch {
    // An unreadable note starts the mockup over.
  }
  return {
    session: typeof raw.session === 'string' ? raw.session : null,
    revisions: typeof raw.revisions === 'number' && Number.isInteger(raw.revisions) && raw.revisions >= 0 ? raw.revisions : 0,
    comment: typeof raw.comment === 'string' && raw.comment ? raw.comment : null,
    ready: raw.ready === true,
  };
}

export function writeMockupState(progress: Progress, state: MockupState): void {
  progress.notes[MOCKUP_NOTE] = JSON.stringify(state);
}

/** The approved mockup's page, or null: only an approval makes it binding on implement. */
export function approvedMockup(progress: Progress, projectCwd: string, featureId: string): string | null {
  if (progress.outcomes.mockup !== 'approved' || !readMockupState(progress).ready) return null;
  return join(mockupDirFor(projectCwd, featureId), MOCKUP_PAGE);
}

/** The lines implement, the summary page and the reviewer get about an approved mockup ('' without one). */
export function mockupReference(progress: Progress, projectCwd: string, featureId: string): string {
  const page = approvedMockup(progress, projectCwd, featureId);
  if (!page) return '';
  const walkthrough = join(mockupDirFor(projectCwd, featureId), MOCKUP_WALKTHROUGH);
  return `Approved mockup: ${page} (walkthrough: ${walkthrough}). The user approved it before any code
was written: follow its layout, controls, wording and flow; where the code must differ, say why.`;
}

/**
 * The served file's absolute path, or null. Lexical only, and before any
 * filesystem call: a UNC path (`\\host\share`) reaching `stat`/`realpath`
 * makes Windows authenticate to that host with the user's NTLM hash
 * (CLAUDE.md, terminal paths). Every segment is a plain name — letters,
 * digits, `.`, `_`, `-`, never starting with a dot — so `..`, absolute,
 * drive, UNC, backslash, colon (alternate streams) and any percent-encoding
 * left after the router's decode are all refused; the containment check
 * after the join is the second lock.
 */
export function mockupFilePath(dataDir: string, hash: string, featureId: string, file: string): string | null {
  if (!HASH.test(hash) || !FEATURE.test(featureId)) return null;
  if (!file || file.length > 200) return null;
  const segments = file.split('/');
  if (segments.length > 4 || !segments.every((s) => /^[A-Za-z0-9_-][A-Za-z0-9._-]*$/.test(s))) return null;
  const root = resolve(mockupDirOf(dataDir, hash, featureId));
  const abs = resolve(root, ...segments);
  const rel = relative(root, abs);
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) return null;
  return abs;
}
