import { execFile } from 'child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { promisify } from 'util';
import { getConfig } from '../config.js';
import { createLogger } from '../utils/logger.js';
import { COMMIT_IDENTITY, git } from '../agent/claude-run.js';
import { resolveInWorktree } from '../jobs/docs.js';
import type { RegistryProject } from './registry.js';
import { readProjectDoc, writeProjectDoc } from './project-store.js';
import {
  cloneTrack,
  ensureTrack,
  featuresOf,
  mergeTracks,
  parseProjectDoc,
  removeTrack,
  renderProjectDoc,
  replaceTrack,
  type FeatureStatus,
  type Track,
} from './project-doc-format.js';

const execFileAsync = promisify(execFile);
const logger = createLogger('track-plan');

/**
 * Moving a track's plan between main and its track branch.
 *
 * While a track has an unlanded branch, its PROJECT.md section and its specs
 * live only on that branch; main gets them back when the track lands
 * (docs/track-branches.md, "Where a track's plan lives"). Everything here is
 * plain git plus file writes, with no knowledge of the track_branches table:
 * track-branches.ts decides when to move, this file does the moving.
 *
 * Every commit made on MAIN goes through a temporary index (GIT_INDEX_FILE),
 * built from HEAD plus exactly the paths being changed. Whatever the user has
 * staged stays staged and never rides along in a commit they didn't make, and
 * the working copy is edited separately so their other uncommitted edits in
 * the same file survive.
 */

// --- Status --------------------------------------------------------------

export interface StatusEntry {
  path: string;
  /** Porcelain X: what is staged. ' ' when nothing, '?' for untracked. */
  staged: string;
  untracked: boolean;
}

/** `git status --porcelain` with every untracked file listed (never a bare `dir/`). */
export async function statusEntries(cwd: string): Promise<StatusEntry[] | null> {
  const out = await git(cwd, ['status', '--porcelain', '--untracked-files=all']);
  if (out === null) return null;
  const entries: StatusEntry[] = [];
  for (const line of out.split('\n')) {
    if (!line.trim()) continue;
    let p = line.slice(3).trim();
    const arrow = p.indexOf(' -> ');
    if (arrow !== -1) p = p.slice(arrow + 4);
    if (p.startsWith('"') && p.endsWith('"')) p = p.slice(1, -1);
    entries.push({ path: p, staged: line[0], untracked: line.startsWith('??') });
  }
  return entries;
}

/**
 * PROJECT.md itself, or a markdown file in its companion `project/` folder
 * outside `project/reviews/` (per-job scratch). These are what a session
 * writes while planning, and the only files Land lets through uncommitted.
 */
export function isPlanningPath(rel: string, docRel: string): boolean {
  const k = rel.replace(/\\/g, '/').toLowerCase();
  const doc = docRel.replace(/\\/g, '/').toLowerCase();
  if (k === doc) return true;
  const dir = doc.includes('/') ? doc.slice(0, doc.lastIndexOf('/') + 1) : '';
  return k.startsWith(`${dir}project/`) && k.endsWith('.md') && !k.startsWith(`${dir}project/reviews/`);
}

/**
 * The session log at the repo root. Like planning, claude-remote writes it and
 * it is never code; a worktree session's entry is written into main's copy, so
 * a tracked one leaves main dirty. Land lets it through on MAIN only — not in
 * commitWorktreePlanning, which would commit a worktree copy onto the track
 * branch and make every Land conflict with main's.
 */
export function isSessionLogPath(rel: string): boolean {
  const norm = (p: string) => p.replace(/\\/g, '/').replace(/^\.\//, '').toLowerCase();
  return norm(rel) === norm(getConfig().projectLog.fileName);
}

/** A list of paths for an error message, capped so a huge tree can't flood it. */
export function nameFiles(paths: string[], max = 8): string {
  const shown = paths.slice(0, max).join(', ');
  return paths.length > max ? `${shown} and ${paths.length - max} more` : shown;
}

/**
 * Commit the track worktree's uncommitted planning files, when they are the
 * only uncommitted files. That worktree belongs to one track and never
 * pushes, so committing board ticks and session-written specs there is safe —
 * and without it every board write would block Land and the next job merge.
 * Returns the paths that are NOT planning files (nothing is committed then),
 * or null when the tree is clean or was committed.
 */
export async function commitWorktreePlanning(
  worktreePath: string,
  docRel: string,
  message: string
): Promise<string[] | null> {
  const entries = await statusEntries(worktreePath);
  if (entries === null) return [`(could not read the repository state at ${worktreePath})`];
  if (entries.length === 0) return null;
  const other = entries.filter((e) => !isPlanningPath(e.path, docRel)).map((e) => e.path);
  if (other.length > 0) return other;
  // One path at a time: `git add` rejects the whole call when any pathspec
  // matches nothing, which a deleted file can.
  for (const e of entries) await git(worktreePath, ['add', '-A', '--', e.path]);
  await git(worktreePath, [...COMMIT_IDENTITY, 'commit', '-q', '-m', message, '--no-verify']);
  return null;
}

// --- Commits through a temporary index ------------------------------------

async function gitWithIndex(cwd: string, indexFile: string, args: string[]): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('git', args, {
      cwd,
      windowsHide: true,
      maxBuffer: 16 * 1024 * 1024,
      env: { ...process.env, GIT_INDEX_FILE: indexFile },
    });
    return stdout;
  } catch {
    return null;
  }
}

export interface PathChange {
  /** Repo-relative, forward slashes. */
  path: string;
  /** New content, or null to delete the path. */
  content: string | Buffer | null;
}

/**
 * Commit HEAD's tree plus `changes` on top of HEAD, through a temporary index.
 * The real index is then brought along for each changed path — but only
 * where it still matched HEAD, so something the user staged is never
 * overwritten. The working copy is the caller's to update. Returns the old
 * and new HEAD, or null when the changes made no difference.
 */
export async function commitOnHead(
  cwd: string,
  changes: PathChange[],
  message: string
): Promise<{ before: string; after: string } | null> {
  const before = (await git(cwd, ['rev-parse', 'HEAD']))?.trim();
  if (!before || changes.length === 0) return null;

  const scratch = mkdtempSync(join(tmpdir(), 'cr-plan-index-'));
  const index = join(scratch, 'index');
  try {
    if ((await gitWithIndex(cwd, index, ['read-tree', 'HEAD'])) === null) {
      throw new Error('Could not read HEAD into a temporary index');
    }
    const staged: { path: string; entry: string | null; old: string | null }[] = [];
    for (const [i, change] of changes.entries()) {
      const old = (await git(cwd, ['rev-parse', '-q', '--verify', `${before}:${change.path}`]))?.trim() || null;
      if (change.content === null) {
        await gitWithIndex(cwd, index, ['update-index', '--force-remove', '--', change.path]);
        staged.push({ path: change.path, entry: null, old });
        continue;
      }
      const file = join(scratch, `blob-${i}`);
      writeFileSync(file, change.content);
      // --path applies the repo's clean filters (autocrlf), as `git add` would.
      const sha = (await git(cwd, ['hash-object', '-w', `--path=${change.path}`, file]))?.trim();
      if (!sha) throw new Error(`Could not store ${change.path}`);
      const mode = (await git(cwd, ['ls-tree', before, '--', change.path]))?.trim().split(/\s+/)[0] || '100644';
      const entry = `${mode},${sha},${change.path}`;
      if ((await gitWithIndex(cwd, index, ['update-index', '--add', '--cacheinfo', entry])) === null) {
        throw new Error(`Could not stage ${change.path}`);
      }
      staged.push({ path: change.path, entry, old });
    }

    const tree = (await gitWithIndex(cwd, index, ['write-tree']))?.trim();
    if (!tree) throw new Error('Could not write the commit tree');
    if (tree === (await git(cwd, ['rev-parse', `${before}^{tree}`]))?.trim()) return null;
    const after = (await git(cwd, [...COMMIT_IDENTITY, 'commit-tree', tree, '-p', before, '-m', message]))?.trim();
    if (!after) throw new Error('Could not create the commit');
    // The expected old value makes this fail, rather than drop a commit, if
    // HEAD moved while the tree was being built.
    if ((await git(cwd, ['update-ref', '-m', message, 'HEAD', after, before])) === null) {
      throw new Error('HEAD moved while committing — try again');
    }

    for (const s of staged) {
      const cur = (await git(cwd, ['ls-files', '-s', '--', s.path]))?.trim().split(/\s+/)[1] ?? null;
      if ((cur || null) !== s.old) continue; // the user staged something here: leave it
      if (s.entry === null) await git(cwd, ['update-index', '--force-remove', '--', s.path]);
      else await git(cwd, ['update-index', '--add', '--cacheinfo', s.entry]);
    }
    return { before, after };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

// --- Sections --------------------------------------------------------------

function docRelOf(project: RegistryProject): string {
  return (project.doc || 'PROJECT.md').replace(/\\/g, '/');
}

async function headDocText(cwd: string, docRel: string): Promise<string | null> {
  return git(cwd, ['show', `HEAD:${docRel}`]);
}

/** Spec paths a section's lines link to, deduped, in order. */
export function specsOf(track: Track | null | undefined): string[] {
  return [...new Set((track ? featuresOf(track) : []).map((f) => f.spec).filter((s): s is string => !!s))];
}

/**
 * Edit the working copy's section without healing ids or touching any other
 * line, so the user's other uncommitted edits in the file are kept as typed.
 */
function editWorkingDoc(project: RegistryProject, edit: (doc: ReturnType<typeof parseProjectDoc>) => boolean): void {
  const state = readProjectDoc(project);
  if (!edit(state.doc)) return;
  writeProjectDoc(project, state.doc, state.revision);
}

const STATUS_RANK: Record<FeatureStatus, number> = { pending: 0, blocked: 0, in_progress: 1, done: 2 };

/**
 * How two copies of a section combine when both exist:
 *  - `replace`: main's working copy wins outright (branch creation — the
 *    worktree's copy is only HEAD's, so main's is the newer one);
 *  - `worktree-wins`: the worktree's lines win, main-only lines are kept
 *    (Move into branch, for lines a session wrote on main later);
 *  - `main-wins`: main's lines win but keep the further-along status, and
 *    worktree-only lines are kept (the boot migration of tracks branched
 *    before plans moved: main was authoritative then, and only ticks were
 *    made in the worktree).
 */
export type MoveMode = 'replace' | 'worktree-wins' | 'main-wins';

function combine(main: Track, worktree: Track | undefined, mode: MoveMode): Track {
  if (!worktree || mode === 'replace') return cloneTrack(main);
  if (mode === 'worktree-wins') return mergeTracks(worktree, main);
  const merged = mergeTracks(main, worktree);
  const wtStatus = new Map(featuresOf(worktree).map((f) => [f.id, f.status]));
  for (const f of featuresOf(merged)) {
    const s = wtStatus.get(f.id);
    if (s && STATUS_RANK[s] > STATUS_RANK[f.status]) f.status = s;
  }
  return merged;
}

export interface MoveResult {
  /** The commit on main that took the section out, or null when HEAD had nothing to remove. */
  mainCommit: string | null;
  /** Specs copied into the worktree because main's copy was uncommitted or missing there. */
  specsCopied: string[];
  /** Specs removed from main (only this track's lines referenced them). */
  specsRemoved: string[];
  /**
   * Specs left on main because the worktree's copy differs from main's: the
   * track revised its own while main's changed too. Both versions are kept;
   * reconciling them is the user's call.
   */
  specsKept: string[];
}

/** Same text, ignoring line endings (a checkout may write CRLF on Windows). */
function sameText(a: string, b: string): boolean {
  try {
    const norm = (p: string) => readFileSync(p, 'utf-8').replace(/\r\n/g, '\n');
    return norm(a) === norm(b);
  } catch {
    return false;
  }
}

/**
 * Move a track's section (and the specs only it uses) off main into its
 * worktree. Two steps, in this order and no other:
 *
 *  1. Into the worktree. Main's WORKING copy of the section is written into
 *     the worktree's PROJECT.md, so uncommitted lines come along, and so are
 *     the track's specs that are uncommitted on main. Both are committed on
 *     the track branch.
 *  2. Off main. One commit, built from HEAD's PROJECT.md minus the section
 *     through a temporary index, also removes the specs that no other
 *     section references. Then the working copy drops the section too,
 *     keeping its other uncommitted edits. Never pushed: only Land pushes.
 *
 * Worktree first: if step 2 fails, the plan exists in both places, which the
 * board and Land handle ("both copies"). Main first would leave a window in
 * which it exists nowhere.
 *
 * `sharedSpecs` are spec paths some other section links to; they stay on
 * main and are only copied.
 */
export async function moveSectionOffMain(opts: {
  project: RegistryProject;
  worktreePath: string;
  trackName: string;
  sharedSpecs: Set<string>;
  mode: MoveMode;
}): Promise<MoveResult> {
  const { project, worktreePath, trackName, sharedSpecs, mode } = opts;
  const cwd = project.cwd;
  const docRel = docRelOf(project);
  const wtProject: RegistryProject = { ...project, cwd: worktreePath };

  // 1. Into the worktree.
  const mainSection = readProjectDoc(project).doc.tracks.find((t) => t.name === trackName);
  editWorkingDoc(wtProject, (doc) => {
    const existing = doc.tracks.find((t) => t.name === trackName);
    if (!mainSection) {
      if (existing) return false;
      ensureTrack(doc, trackName);
      return true;
    }
    replaceTrack(doc, combine(mainSection, existing, mode));
    return true;
  });

  const status = new Map(((await statusEntries(cwd)) ?? []).map((e) => [e.path.toLowerCase(), e]));
  const specs = specsOf(mainSection).filter((s) => resolveInWorktree(cwd, s) && resolveInWorktree(worktreePath, s));
  const specsCopied: string[] = [];
  for (const spec of specs) {
    const from = resolveInWorktree(cwd, spec) as string;
    const to = resolveInWorktree(worktreePath, spec) as string;
    if (!existsSync(from)) continue;
    const dirtyOnMain = status.has(spec.toLowerCase());
    // The track's own revision of a spec is never overwritten, except at
    // branch creation, when the worktree's copy is only HEAD's.
    if (existsSync(to) && !(mode === 'replace' && dirtyOnMain)) continue;
    mkdirSync(dirname(to), { recursive: true });
    writeFileSync(to, readFileSync(from));
    specsCopied.push(spec);
  }
  for (const path of [docRel, ...specsCopied]) await git(worktreePath, ['add', '-A', '--', path]);
  await git(worktreePath, [
    ...COMMIT_IDENTITY,
    'commit',
    '-q',
    '-m',
    `Plan "${trackName}" in its track branch`,
    '--no-verify',
    '--',
    docRel,
    ...specsCopied,
  ]);

  // 2. Off main. A spec leaves main only once the worktree holds main's
  // content: copied just now, or the same text already. One the track
  // revised while main's copy differs (Move into branch, the migration) stays
  // on main, or main's version — uncommitted edits, or an untracked file with
  // no history at all — would be deleted with nothing anywhere to recover it.
  const holdsMains = (s: string): boolean =>
    specsCopied.includes(s) || !existsSync(join(cwd, s)) || sameText(join(cwd, s), join(worktreePath, s));
  const unshared = specs.filter((s) => !sharedSpecs.has(s) && existsSync(join(worktreePath, s)));
  const removable = unshared.filter(holdsMains);
  const specsKept = unshared.filter((s) => !holdsMains(s));
  const changes: PathChange[] = [];
  const headText = await headDocText(cwd, docRel);
  if (headText !== null) {
    const headDoc = parseProjectDoc(headText);
    if (removeTrack(headDoc, trackName)) changes.push({ path: docRel, content: renderProjectDoc(headDoc) });
  }
  for (const spec of removable) {
    if ((await git(cwd, ['cat-file', '-e', `HEAD:${spec}`])) !== null) changes.push({ path: spec, content: null });
  }
  const committed = await commitOnHead(cwd, changes, `Move "${trackName}" plan into its track branch`);

  editWorkingDoc(project, (doc) => removeTrack(doc, trackName));
  for (const spec of removable) rmSync(join(cwd, spec), { force: true });

  logger.info(
    { cwd, track: trackName, mainCommit: committed?.after ?? null, specsCopied, specsRemoved: removable, specsKept },
    'track plan moved into its branch'
  );
  return { mainCommit: committed?.after ?? null, specsCopied, specsRemoved: removable, specsKept };
}

export interface ReturnResult {
  /** Feature ids now in main's section. */
  featureIds: string[];
  /** Undo this, for a Land whose merge failed. */
  rollback: () => Promise<void>;
}

/**
 * Land's half of the move: put the worktree's section back into main's
 * PROJECT.md, and the specs it links to that main's HEAD lacks, in one commit
 * on main through a temporary index. The working copy gets the same section
 * and keeps its uncommitted backlog edits.
 *
 * It runs BEFORE the land merge. A spec the move removed from main and the
 * track then revised would otherwise be a modify/delete conflict, and one it
 * never touched would be deleted by the merge; with main holding the track's
 * version, both sides agree.
 *
 * A section main also has ("both copies") is merged by feature id: the
 * worktree's line wins, and lines only main has are kept. With none, the
 * section goes after main's last one.
 *
 * `rollback` resets HEAD and the index to before this commit and puts the
 * working files back. It is only safe because Land refuses anything staged on
 * main, so the index matched HEAD when this began.
 */
export async function returnSectionToMain(opts: {
  project: RegistryProject;
  worktreePath: string;
  trackName: string;
}): Promise<ReturnResult> {
  const { project, worktreePath, trackName } = opts;
  const cwd = project.cwd;
  const docRel = docRelOf(project);
  const wtSection = readProjectDoc({ ...project, cwd: worktreePath }).doc.tracks.find((t) => t.name === trackName);
  const docPath = join(cwd, docRel);
  const originalDoc = existsSync(docPath) ? readFileSync(docPath) : null;
  const noop: ReturnResult = { featureIds: [], rollback: async () => {} };
  if (!wtSection) {
    const onMain = readProjectDoc(project).doc.tracks.find((t) => t.name === trackName);
    return { ...noop, featureIds: (onMain ? featuresOf(onMain) : []).map((f) => f.id) };
  }

  const withSection = (text: string): { text: string; section: Track } => {
    const doc = parseProjectDoc(text);
    const there = doc.tracks.find((t) => t.name === trackName);
    const section = there ? mergeTracks(wtSection, there) : wtSection;
    replaceTrack(doc, section);
    return { text: renderProjectDoc(doc), section };
  };

  const changes: PathChange[] = [];
  const head = withSection((await headDocText(cwd, docRel)) ?? '');
  changes.push({ path: docRel, content: head.text });
  const specs: { path: string; content: Buffer }[] = [];
  for (const spec of specsOf(wtSection)) {
    const from = resolveInWorktree(worktreePath, spec);
    if (!from || !existsSync(from) || !resolveInWorktree(cwd, spec)) continue;
    if ((await git(cwd, ['cat-file', '-e', `HEAD:${spec}`])) !== null) continue;
    specs.push({ path: spec, content: readFileSync(from) });
  }
  changes.push(...specs.map((s) => ({ path: s.path, content: s.content })));

  const committed = await commitOnHead(cwd, changes, `Return "${trackName}" plan to main`);

  // The working copy, through the same merge, with nothing else touched.
  const working = originalDoc === null ? head : withSection(originalDoc.toString('utf-8'));
  if (originalDoc === null || working.text !== originalDoc.toString('utf-8')) {
    mkdirSync(dirname(docPath), { recursive: true });
    writeFileSync(docPath, working.text, 'utf-8');
  }
  const created: string[] = [];
  for (const s of specs) {
    const abs = join(cwd, s.path);
    if (existsSync(abs)) continue;
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, s.content);
    created.push(abs);
  }

  return {
    featureIds: featuresOf(head.section).map((f) => f.id),
    rollback: async () => {
      if (committed) await git(cwd, ['reset', '-q', committed.before]);
      if (originalDoc === null) rmSync(docPath, { force: true });
      else writeFileSync(docPath, originalDoc);
      for (const abs of created) rmSync(abs, { force: true });
    },
  };
}
