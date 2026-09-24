import { randomUUID } from 'crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync } from 'fs';
import { dirname, join, isAbsolute } from 'path';
import { getDatabase } from '../db/schema.js';
import { createLogger } from '../utils/logger.js';
import { COMMIT_IDENTITY, git } from '../agent/claude-run.js';
import { isInside } from '../utils/paths.js';
import { resolveInWorktree } from '../jobs/docs.js';
import { pathKey } from '../sessions/project-discovery.js';
import {
  createWorktree,
  currentBranch,
  ensureGitRepo,
  hasRemote,
  removeWorktree,
  worktreeRoot,
} from '../jobs/worktree.js';
import { listJobsForProject } from '../jobs/store.js';
import { isLive } from '../jobs/types.js';
import type { RegistryProject } from './registry.js';
import { mutateProjectDoc, readProjectDoc } from './project-store.js';
import {
  ensureTrack,
  featuresOf,
  findFeature,
  parseProjectDoc,
  updateFeature,
  type FeatureStatus,
} from './project-doc-format.js';
import { guessTrackWork, type GuessedFile } from './track-attribution.js';

const logger = createLogger('track-branches');

/**
 * A track's own branch and worktree.
 *
 * Planning happens on main (PROJECT.md lines and specs, which Delete track can
 * always remove). Implementation happens here, so that everything a track did
 * — a session's commits, its uncommitted edits, the jobs merged into it — can
 * be told apart from other work and landed or deleted as one unit. The
 * reasoning is in docs/track-branches.md.
 *
 * PROJECT.md in the MAIN checkout stays the one source of truth: the board,
 * dispatch and rebuild all read and write it there. The worktree's copy is
 * never authoritative; Land copies its ticks across and then drops it.
 */

export interface TrackBranch {
  id: string;
  projectCwd: string;
  trackName: string;
  branch: string;
  worktreePath: string;
  baseBranch: string;
  createdAt: string;
  landedAt: string | null;
  mergeSha: string | null;
}

interface TrackBranchRow {
  id: string;
  project_cwd: string;
  project_key: string;
  track_name: string;
  branch: string;
  worktree_path: string;
  base_branch: string;
  created_at: string;
  landed_at: string | null;
  merge_sha: string | null;
}

export class TrackBranchError extends Error {
  constructor(
    message: string,
    readonly status = 400
  ) {
    super(message);
    this.name = 'TrackBranchError';
  }
}

function toTrackBranch(row: TrackBranchRow): TrackBranch {
  return {
    id: row.id,
    projectCwd: row.project_cwd,
    trackName: row.track_name,
    branch: row.branch,
    worktreePath: row.worktree_path,
    baseBranch: row.base_branch,
    createdAt: row.created_at,
    landedAt: row.landed_at,
    mergeSha: row.merge_sha,
  };
}

// --- Store -------------------------------------------------------------

/** The track's branch that has not landed yet, if it has one. */
export function getActiveTrackBranch(cwd: string, trackName: string): TrackBranch | null {
  const row = getDatabase()
    .prepare(
      `SELECT * FROM track_branches
       WHERE project_key = ? AND track_name = ? AND landed_at IS NULL`
    )
    .get(pathKey(cwd), trackName) as TrackBranchRow | undefined;
  return row ? toTrackBranch(row) : null;
}

/** Every track branch of a project, landed ones included, oldest first. */
export function listTrackBranches(cwd: string): TrackBranch[] {
  const rows = getDatabase()
    .prepare('SELECT * FROM track_branches WHERE project_key = ? ORDER BY created_at')
    .all(pathKey(cwd)) as TrackBranchRow[];
  return rows.map(toTrackBranch);
}

/** The not-yet-landed track branch named `branch`, used by the merge stage. */
export function findActiveTrackBranchByName(cwd: string, branch: string): TrackBranch | null {
  const row = getDatabase()
    .prepare(
      `SELECT * FROM track_branches
       WHERE project_key = ? AND branch = ? AND landed_at IS NULL`
    )
    .get(pathKey(cwd), branch) as TrackBranchRow | undefined;
  return row ? toTrackBranch(row) : null;
}

/** True when `branch` is, or was, one of this project's track branches. */
export function isTrackBranch(cwd: string, branch: string): boolean {
  return (
    getDatabase()
      .prepare('SELECT 1 FROM track_branches WHERE project_key = ? AND branch = ?')
      .get(pathKey(cwd), branch) !== undefined
  );
}

/**
 * Forget a track's rows. Only Delete track calls this. `keepUnlanded` keeps the
 * row of a branch whose worktree could not be removed, so it stays on the
 * board and can be deleted again instead of being left on disk unrecorded.
 */
export function deleteTrackBranchRows(
  cwd: string,
  trackName: string,
  opts: { keepUnlanded?: boolean } = {}
): void {
  getDatabase()
    .prepare(
      `DELETE FROM track_branches WHERE project_key = ? AND track_name = ?${
        opts.keepUnlanded ? ' AND landed_at IS NOT NULL' : ''
      }`
    )
    .run(pathKey(cwd), trackName);
}

function markLanded(id: string, mergeSha: string): void {
  getDatabase()
    .prepare('UPDATE track_branches SET landed_at = ?, merge_sha = ? WHERE id = ?')
    .run(new Date().toISOString(), mergeSha, id);
}

// --- Naming ------------------------------------------------------------

function slugOf(trackName: string): string {
  return (
    trackName
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'track'
  );
}

/** `track/<slug>-<id8>`: the id suffix keeps same-named tracks of two projects apart. */
export function trackBranchNameFor(id: string, trackName: string): string {
  return `track/${slugOf(trackName)}-${id.slice(0, 8)}`;
}

export function trackWorktreePathFor(id: string): string {
  return join(worktreeRoot(), 'tracks', id);
}

// --- Branching ---------------------------------------------------------

/**
 * The track's branch and worktree, created on first use.
 *
 * Called by everything that starts implementation: Open session on a track
 * heading, the new-session dialog's track picker, and dispatching a job for
 * one of the track's features. A track that is only ever planned never gets
 * one. When the track has no heading in PROJECT.md yet (the picker's "New
 * track…"), the heading is added on main so the board shows it.
 */
export async function ensureTrackBranch(
  project: RegistryProject,
  trackName: string
): Promise<TrackBranch> {
  const name = trackName.trim();
  if (!name) throw new TrackBranchError('A track name is required');

  const existing = getActiveTrackBranch(project.cwd, name);
  if (existing) {
    await reattachIfMissing(project, existing);
    return existing;
  }

  await ensureGitRepo(project.cwd);
  const baseBranch = (await currentBranch(project.cwd)) || 'main';
  const id = randomUUID();
  const created = await createWorktree(project.cwd, id, name, {
    base: baseBranch,
    path: trackWorktreePathFor(id),
    branch: trackBranchNameFor(id, name),
  });

  const now = new Date().toISOString();
  try {
    getDatabase()
      .prepare(
        `INSERT INTO track_branches
           (id, project_cwd, project_key, track_name, branch, worktree_path, base_branch, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(id, project.cwd, pathKey(project.cwd), name, created.branch, created.path, baseBranch, now);
  } catch (error) {
    // Two callers raced (the board's Open session and a dispatch, say) and the
    // other one's row won the unique index. Drop the worktree this call made
    // and use theirs, rather than leaving an orphan branch behind.
    const winner = getActiveTrackBranch(project.cwd, name);
    if (!winner) throw error;
    await removeWorktree(project.cwd, id, { path: created.path, deleteBranch: created.branch });
    return winner;
  }

  if (!readProjectDoc(project).doc.tracks.some((t) => t.name === name)) {
    mutateProjectDoc(project, null, (doc) => ensureTrack(doc, name));
  }

  logger.info({ cwd: project.cwd, track: name, branch: created.branch }, 'track branch created');
  return getActiveTrackBranch(project.cwd, name) as TrackBranch;
}

/**
 * Re-create a track's worktree directory if it went missing (cleaned by hand,
 * a crash mid-create). The branch still holds the work, so this re-attaches to
 * it rather than starting over.
 */
async function reattachIfMissing(project: RegistryProject, track: TrackBranch): Promise<void> {
  if (existsSync(track.worktreePath)) return;
  await git(project.cwd, ['worktree', 'prune']);
  await createWorktree(project.cwd, track.id, track.trackName, {
    base: track.baseBranch,
    path: track.worktreePath,
    branch: track.branch,
  });
}

/** The track a feature sits in on main, or null for an unknown id. */
export function trackOfFeature(project: RegistryProject, featureId: string): string | null {
  return findFeature(readProjectDoc(project).doc, featureId)?.track.name ?? null;
}

/**
 * Read a spec, preferring the track worktree's copy when the track has one and
 * the file exists there: a spec written or revised during implementation is on
 * the track branch until it lands. Same containment rule as resolveSpecPath.
 */
export function readSpecForTrack(
  project: RegistryProject,
  trackName: string | null,
  spec: string | null
): string | null {
  if (!spec || !trackName || isAbsolute(spec)) return null;
  const branch = getActiveTrackBranch(project.cwd, trackName);
  if (!branch) return null;
  // Symlinks resolved before the containment check: a link a session or job
  // left under project/ could otherwise point anywhere on the machine.
  const abs = resolveInWorktree(branch.worktreePath, spec);
  if (!abs) return null;
  try {
    return existsSync(abs) ? readFileSync(abs, 'utf-8') : null;
  } catch {
    return null;
  }
}

// --- Land --------------------------------------------------------------

const STATUS_RANK: Record<FeatureStatus, number> = {
  pending: 0,
  blocked: 0,
  in_progress: 1,
  done: 2,
};

export interface LandResult {
  mergeSha: string;
  pushed: boolean;
  /** Feature ids whose status was carried over from the worktree's PROJECT.md. */
  synced: string[];
  detail: string;
}

/**
 * Land a track: merge its branch into the base once, then retire the worktree.
 *
 * Refused unless every job for the track has finished, both checkouts are
 * clean, and no live session is running inside the worktree (on Windows an
 * open shell holds the directory and `git worktree remove` fails half-way).
 *
 * PROJECT.md never goes through the merge. Ticks a session made in the
 * worktree's copy are applied to main's through mutateProjectDoc, and the
 * branch's copy is reset to its merge-base first, so the merge cannot conflict
 * on the file every track touches.
 */
export async function landTrack(
  project: RegistryProject,
  trackName: string,
  liveSessionCwds: string[]
): Promise<LandResult> {
  const track = getActiveTrackBranch(project.cwd, trackName);
  if (!track) throw new TrackBranchError('This track has no branch to land', 404);
  const docRel = project.doc || 'PROJECT.md';

  const onMain = readProjectDoc(project).doc.tracks.find((t) => t.name === trackName);
  const featureIds = new Set((onMain ? featuresOf(onMain) : []).map((f) => f.id));
  const liveJobs = listJobsForProject(project.cwd).filter(
    (j) =>
      isLive(j.status) &&
      ((j.featureId !== null && featureIds.has(j.featureId)) || j.baseBranch === track.branch)
  );
  if (liveJobs.length > 0) {
    throw new TrackBranchError(
      `${liveJobs.length} job(s) for this track are still active — let them finish or cancel them first`,
      409
    );
  }

  const inside = liveSessionCwds.filter((c) => isInside(track.worktreePath, c));
  if (inside.length > 0) {
    throw new TrackBranchError(
      'A session is still open in this track’s worktree — close it before landing',
      409
    );
  }

  await reattachIfMissing(project, track);
  if (await isDirty(track.worktreePath)) {
    throw new TrackBranchError(
      `The track worktree has uncommitted changes (${track.worktreePath}). Commit or discard them first.`,
      409
    );
  }
  if (await isDirty(project.cwd)) {
    throw new TrackBranchError(
      'The project has uncommitted changes. Commit or stash them before landing this track.',
      409
    );
  }
  const current = (await git(project.cwd, ['rev-parse', '--abbrev-ref', 'HEAD']))?.trim();
  if (current !== track.baseBranch) {
    throw new TrackBranchError(
      `The project is on "${current}" but this track branched from "${track.baseBranch}". ` +
        `Switch back to ${track.baseBranch} before landing.`,
      409
    );
  }

  // 1. Read the worktree's ticks, then take PROJECT.md out of the merge.
  const worktreeStatuses = readWorktreeStatuses(track.worktreePath, docRel, featureIds);
  const beforeReset = await resetDocToMergeBase(track, docRel);

  // 2. Merge.
  const merged = await git(project.cwd, [
    ...COMMIT_IDENTITY,
    'merge',
    '--no-ff',
    track.branch,
    '-m',
    `Merge track: ${trackName}`,
  ]);
  if (merged === null) {
    await git(project.cwd, ['merge', '--abort']);
    // Take the reset commit back off the track branch. Without this the
    // worktree's ticks exist only in memory, and the next Land reads the
    // already-reset copy: the progress is gone for good. Safe: the worktree
    // was checked clean above, so --hard discards nothing else.
    if (beforeReset) await git(track.worktreePath, ['reset', '--hard', beforeReset]);
    throw new TrackBranchError(
      `Merging ${track.branch} into ${track.baseBranch} failed. Merge ${track.baseBranch} into the track in its worktree, resolve, and land again.`,
      409
    );
  }
  const mergeSha = (await git(project.cwd, ['rev-parse', 'HEAD']))?.trim() || '';
  markLanded(track.id, mergeSha);

  // 3. Carry the ticks over to main, committing only PROJECT.md.
  const synced = await syncTicks(project, docRel, worktreeStatuses, trackName);

  // 4. Publish, as the merge stage does for a job.
  let pushed = false;
  if (await hasRemote(project.cwd)) {
    pushed = (await git(project.cwd, ['push'])) !== null;
  }

  // 5. The branch's commits now live on the base; only the label goes.
  await removeWorktree(project.cwd, track.id, {
    path: track.worktreePath,
    deleteBranch: track.branch,
  });

  logger.info({ cwd: project.cwd, track: trackName, mergeSha, pushed, synced }, 'track landed');
  return {
    mergeSha,
    pushed,
    synced,
    detail: pushed
      ? `Landed into ${track.baseBranch} and pushed`
      : `Landed into ${track.baseBranch}`,
  };
}

async function isDirty(cwd: string): Promise<boolean> {
  const status = await git(cwd, ['status', '--porcelain']);
  if (status === null) throw new TrackBranchError(`Could not read the repository state at ${cwd}`, 500);
  return status.trim().length > 0;
}

function readWorktreeStatuses(
  worktreePath: string,
  docRel: string,
  featureIds: Set<string>
): Map<string, FeatureStatus> {
  const out = new Map<string, FeatureStatus>();
  const path = join(worktreePath, docRel);
  if (!existsSync(path)) return out;
  const doc = parseProjectDoc(readFileSync(path, 'utf-8'));
  for (const id of featureIds) {
    const found = findFeature(doc, id);
    if (found) out.set(id, found.feature.status);
  }
  return out;
}

/**
 * Commit the branch's PROJECT.md back to its merge-base version, if it moved.
 * Returns the HEAD from before that commit, so a failed land can take it back
 * off — or null when nothing was committed.
 */
async function resetDocToMergeBase(track: TrackBranch, docRel: string): Promise<string | null> {
  const wt = track.worktreePath;
  const base = (await git(wt, ['merge-base', 'HEAD', track.baseBranch]))?.trim();
  if (!base) return null;
  const changed = (await git(wt, ['diff', '--name-only', base, 'HEAD', '--', docRel]))?.trim();
  if (!changed) return null;
  const before = (await git(wt, ['rev-parse', 'HEAD']))?.trim() ?? null;

  const existedAtBase = (await git(wt, ['cat-file', '-e', `${base}:${docRel}`])) !== null;
  if (existedAtBase) {
    await git(wt, ['checkout', base, '--', docRel]);
  } else {
    await git(wt, ['rm', '-q', '--', docRel]);
  }
  await git(wt, [
    ...COMMIT_IDENTITY,
    'commit',
    '-m',
    `Leave ${docRel} to the main checkout`,
    '--no-verify',
    '--',
    docRel,
  ]);
  return before;
}

async function syncTicks(
  project: RegistryProject,
  docRel: string,
  worktreeStatuses: Map<string, FeatureStatus>,
  trackName: string
): Promise<string[]> {
  const main = readProjectDoc(project).doc;
  const toApply: [string, FeatureStatus][] = [];
  for (const [id, status] of worktreeStatuses) {
    const onMain = findFeature(main, id);
    if (onMain && STATUS_RANK[status] > STATUS_RANK[onMain.feature.status]) {
      toApply.push([id, status]);
    }
  }
  if (toApply.length === 0) return [];

  mutateProjectDoc(project, null, (doc) => {
    for (const [id, status] of toApply) updateFeature(doc, id, { status });
  });
  await git(project.cwd, ['add', '--', docRel]);
  await git(project.cwd, [
    ...COMMIT_IDENTITY,
    'commit',
    '-m',
    `chore: carry "${trackName}" progress over from its track branch`,
    '--no-verify',
    '--',
    docRel,
  ]);
  return toApply.map(([id]) => id);
}

// --- Branch now ----------------------------------------------------------

/**
 * Move a track's work off main into a new track branch, after the fact.
 *
 * For a track whose sessions edited the main checkout. The file list comes
 * from the attribution guess and must be confirmed by the user; anything not
 * in the server's own guess is ignored, so a request can never move an
 * arbitrary path. Every file is copied into the worktree BEFORE any is
 * restored on main, so a failed copy leaves main untouched. Commits already on
 * main are not moved — that would rewrite main — and stay for Delete track to
 * offer.
 */
export async function branchNow(
  project: RegistryProject,
  trackName: string,
  files: string[]
): Promise<{ branch: TrackBranch; moved: string[] }> {
  if (getActiveTrackBranch(project.cwd, trackName)) {
    throw new TrackBranchError('This track already has a branch — open a session in it instead', 409);
  }
  const guess = await guessTrackWork(project, trackName);
  const allowed = new Map(guess.files.map((f) => [f.path.toLowerCase(), f]));
  const chosen = files
    .map((p) => allowed.get(p.replace(/\\/g, '/').toLowerCase()))
    .filter((f): f is GuessedFile => f !== undefined);
  if (chosen.length === 0) {
    throw new TrackBranchError('None of those files are uncommitted work of this track', 400);
  }

  const branch = await ensureTrackBranch(project, trackName);

  for (const f of chosen) {
    const dst = join(branch.worktreePath, f.path);
    if (f.status === 'deleted') {
      rmSync(dst, { force: true });
    } else {
      mkdirSync(dirname(dst), { recursive: true });
      copyFileSync(join(project.cwd, f.path), dst);
    }
  }
  for (const f of chosen) {
    if (f.status === 'untracked') {
      rmSync(join(project.cwd, f.path), { force: true });
    } else {
      await git(project.cwd, ['restore', '--source=HEAD', '--staged', '--worktree', '--', f.path]);
    }
  }

  logger.info({ cwd: project.cwd, track: trackName, moved: chosen.length }, 'track: work moved off main');
  return { branch, moved: chosen.map((f) => f.path) };
}
