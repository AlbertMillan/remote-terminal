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
  describeLinksLeft,
  ensureGitRepo,
  hasRemote,
  removeWorktree,
  worktreeRoot,
} from '../jobs/worktree.js';
import { listJobsForProject } from '../jobs/store.js';
import { isLive } from '../jobs/types.js';
import { loadRegistry, type RegistryProject } from './registry.js';
import { readProjectDoc } from './project-store.js';
import { featuresOf, findFeature } from './project-doc-format.js';
import {
  getActiveTrackBranch,
  listUnmigratedTrackBranches,
  markLanded,
  markPlanInBranch,
  type TrackBranch,
} from './track-store.js';
import { readProjectPlan, type ProjectPlan } from './project-plan.js';
import { isInstalling } from './project-deps.js';
import { guessTrackWork, type GuessedFile } from './track-attribution.js';
import {
  commitWorktreePlanning,
  isPlanningPath,
  isSessionLogPath,
  moveSectionOffMain,
  nameFiles,
  returnSectionToMain,
  specsOf,
  statusEntries,
  type MoveMode,
  type MoveResult,
} from './track-plan.js';

const logger = createLogger('track-branches');

// The table and the plan readers live in their own modules (track-store.ts,
// project-plan.ts) so attribution can read plans without importing this
// file, which imports attribution. Re-exported for existing callers.
export {
  deleteTrackBranchRows,
  findActiveTrackBranchByName,
  getActiveTrackBranch,
  isTrackBranch,
  listTrackBranches,
  type TrackBranch,
} from './track-store.js';
export {
  allFeatureIds,
  planCopies,
  planFileFor,
  readProjectPlan,
  worktreeProject,
  type PlanCopy,
  type ProjectPlan,
} from './project-plan.js';

/**
 * A track's own branch and worktree.
 *
 * A track's plan lives where its work lives (docs/track-branches.md):
 *  - backlog (no branch): its PROJECT.md section and specs are on main;
 *  - in progress (an unlanded branch): ONLY on the track branch — the move
 *    happens when the branch is created (track-plan.ts);
 *  - landed: on main again, put back by Land.
 *
 * So main's PROJECT.md is authoritative for the backlog and landed tracks,
 * and an in-progress track's worktree is authoritative for that track. The
 * board, dispatch, rebuild and attribution read both through readProjectPlan.
 * Land copies the section across and never merges the file.
 */

export class TrackBranchError extends Error {
  constructor(
    message: string,
    readonly status = 400
  ) {
    super(message);
    this.name = 'TrackBranchError';
  }
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

/**
 * A new track's worktree folder. Named by the first 8 characters of the row
 * id, not all 36: git on Windows refuses a worktree whose path passes about
 * 210 characters, so every character here comes off how deep
 * `persistence.dataDir` may be. The full id is
 * the fallback for the rare prefix already taken — createWorktree reuses an
 * existing folder, which would hand this track another one's checkout — and
 * so is a prefix an unlanded row records, whose missing folder reattachIfMissing
 * would otherwise re-create inside this track's. The path is stored on the
 * row, so existing tracks keep their full-id folders.
 */
export function trackWorktreePathFor(id: string): string {
  const short = join(worktreeRoot(), 'tracks', id.slice(0, 8));
  const recorded = getDatabase()
    .prepare('SELECT 1 FROM track_branches WHERE worktree_path = ? AND landed_at IS NULL')
    .get(short);
  return existsSync(short) || recorded ? join(worktreeRoot(), 'tracks', id) : short;
}

/** Spec paths linked from every section except `trackName`'s, on main and in every worktree. */
function specsOutside(plan: ProjectPlan, trackName: string): Set<string> {
  const out = new Set<string>();
  for (const t of plan.main.doc.tracks) if (t.name !== trackName) specsOf(t).forEach((s) => out.add(s));
  for (const c of plan.copies) {
    if (c.track && c.branch.trackName !== trackName) specsOf(c.track).forEach((s) => out.add(s));
  }
  return out;
}

// --- Branching ---------------------------------------------------------

/**
 * The track's branch and worktree, created on first use.
 *
 * Called by everything that starts implementation: Open session on a track
 * heading, the new-session dialog's track picker, dispatch, and Branch now.
 * A track that is only ever planned never gets one. Creating the branch moves
 * the track's plan into it (track-plan.ts); a track with no heading yet (the
 * picker's "New track…") gets its heading in the worktree, never on main.
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
        // plan_in_branch = 1: this row's plan moves into the branch below, so
        // the boot migration (old rows only) must never move it again.
        `INSERT INTO track_branches
           (id, project_cwd, project_key, track_name, branch, worktree_path, base_branch, created_at, plan_in_branch)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)`
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

  // A failed move is logged, not thrown: the branch exists and the plan is
  // then in both places, which the board ("also has lines on main") and
  // Land (merge by id) both handle.
  await movePlan(project, name, created.path, 'replace');

  logger.info({ cwd: project.cwd, track: name, branch: created.branch }, 'track branch created');
  return getActiveTrackBranch(project.cwd, name) as TrackBranch;
}

async function movePlan(
  project: RegistryProject,
  trackName: string,
  worktreePath: string,
  mode: MoveMode
): Promise<MoveResult | null> {
  try {
    return await moveSectionOffMain({
      project,
      worktreePath,
      trackName,
      sharedSpecs: specsOutside(readProjectPlan(project), trackName),
      mode,
    });
  } catch (error) {
    logger.warn(
      { cwd: project.cwd, track: trackName, error: (error as Error).message },
      'track plan: move off main failed — left in both places'
    );
    return null;
  }
}

/**
 * Move into branch: lines written on main for a track that already has a
 * branch go into its worktree, the worktree's lines winning by id.
 */
export async function moveIntoBranch(project: RegistryProject, trackName: string): Promise<MoveResult> {
  const track = getActiveTrackBranch(project.cwd, trackName);
  if (!track) throw new TrackBranchError('This track has no branch to move its lines into', 404);
  await reattachIfMissing(project, track);
  if (!readProjectDoc(project).doc.tracks.some((t) => t.name === trackName)) {
    throw new TrackBranchError('Main has no lines for this track', 404);
  }
  return moveSectionOffMain({
    project,
    worktreePath: track.worktreePath,
    trackName,
    sharedSpecs: specsOutside(readProjectPlan(project), trackName),
    mode: 'worktree-wins',
  });
}

/**
 * One-time migration at server start, for tracks branched before plans moved
 * into branches: their section is still on main. Move each once, keeping
 * main's lines (main was authoritative then) and the worktree's
 * further-along ticks, and flag the row so it is never moved this way again.
 *
 * Only unflagged rows (`plan_in_branch = 0`). A flagged track whose section
 * is on main again had it written there after branching: there the worktree
 * is authoritative, and Move into branch and Land merge it worktree-first.
 * Moving it main-first on every restart would revert the worktree's own edits.
 *
 * Flagged after any attempt, failed ones included: step 1 may already have
 * put main's lines in the worktree, and a retry would let main win again
 * over whatever was edited there since. A failed move is logged and left as
 * a "both copies" track, which the board (Move into branch) and Land handle.
 */
export async function migrateBranchedPlans(): Promise<void> {
  let rows: TrackBranch[];
  try {
    rows = listUnmigratedTrackBranches();
  } catch (error) {
    logger.warn({ error }, 'track plan migration: could not read track branches');
    return;
  }
  const registry = loadRegistry();
  for (const row of rows) {
    const project: RegistryProject = registry.projects.find((p) => pathKey(p.cwd) === pathKey(row.projectCwd)) ?? {
      cwd: row.projectCwd,
    };
    try {
      if (!existsSync(project.cwd)) continue; // the project may come back; retry then
      if (!readProjectDoc(project).doc.tracks.some((t) => t.name === row.trackName)) {
        markPlanInBranch(row.id); // nothing on main to move
        continue;
      }
      await reattachIfMissing(project, row);
      const moved = await movePlan(project, row.trackName, row.worktreePath, 'main-wins');
      markPlanInBranch(row.id);
      if (moved) logger.info({ cwd: project.cwd, track: row.trackName }, 'track plan migration: moved');
    } catch (error) {
      logger.warn(
        { cwd: project.cwd, track: row.trackName, error: (error as Error).message },
        'track plan migration failed'
      );
    }
  }
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

/** The track a feature sits in — main's plan or any in-progress worktree's — or null for an unknown id. */
export function trackOfFeature(project: RegistryProject, featureId: string): string | null {
  return findFeature(readProjectPlan(project).doc, featureId)?.track.name ?? null;
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

export interface LandResult {
  mergeSha: string;
  pushed: boolean;
  /** Feature ids in the section Land put back on main. */
  synced: string[];
  detail: string;
}

/**
 * Land a track: put its plan back on main, merge its branch into the base
 * once, then retire the worktree.
 *
 * Refused unless every job for the track has finished, no live session is
 * running inside the worktree (on Windows an open shell holds the directory
 * and `git worktree remove` fails half-way), the project is on the base
 * branch, and the checkouts hold nothing Land can't account for:
 *  - the worktree: uncommitted planning files are committed there first
 *    (it belongs to this track and never pushes); anything else refuses;
 *  - main: uncommitted planning files (backlog edits) and the session log
 *    (worktree sessions are logged into main's copy) are let through and
 *    left uncommitted; anything else refuses, since code edited on main may
 *    be this track's work. Nothing may be STAGED: git refuses to merge then.
 * Every refusal names the files.
 *
 * PROJECT.md never goes through the merge. The branch's copy is reset to its
 * merge-base first, and the section is copied onto main by its own commit
 * (returnSectionToMain), so the merge cannot conflict on the file every track
 * touches.
 */
export async function landTrack(
  project: RegistryProject,
  trackName: string,
  liveSessionCwds: string[]
): Promise<LandResult> {
  const track = getActiveTrackBranch(project.cwd, trackName);
  if (!track) throw new TrackBranchError('This track has no branch to land', 404);
  const docRel = (project.doc || 'PROJECT.md').replace(/\\/g, '/');

  const plan = readProjectPlan(project);
  const sections = [
    plan.main.doc.tracks.find((t) => t.name === trackName),
    plan.copies.find((c) => c.branch.id === track.id)?.track ?? undefined,
  ];
  const featureIds = new Set(sections.flatMap((t) => (t ? featuresOf(t) : [])).map((f) => f.id));
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
  // No session exists yet while Open session waits on the install, so the
  // check above can't see it; the teardown would delete under a running npm.
  if (isInstalling(track.worktreePath)) {
    throw new TrackBranchError(
      'Dependencies are still installing in this track’s worktree — land once the session has opened',
      409
    );
  }

  await reattachIfMissing(project, track);
  const current = (await git(project.cwd, ['rev-parse', '--abbrev-ref', 'HEAD']))?.trim();
  if (current !== track.baseBranch) {
    throw new TrackBranchError(
      `The project is on "${current}" but this track branched from "${track.baseBranch}". ` +
        `Switch back to ${track.baseBranch} before landing.`,
      409
    );
  }
  const mainEntries = await statusEntries(project.cwd);
  if (mainEntries === null) {
    throw new TrackBranchError(`Could not read the repository state at ${project.cwd}`, 500);
  }
  const mainCode = mainEntries
    .filter((e) => !isPlanningPath(e.path, docRel) && !isSessionLogPath(e.path))
    .map((e) => e.path);
  if (mainCode.length > 0) {
    throw new TrackBranchError(
      `The project has uncommitted changes outside the plan: ${nameFiles(mainCode)}. ` +
        'Commit or stash them before landing this track — code edited on main may be this track’s work.',
      409
    );
  }
  const mainStaged = mainEntries.filter((e) => !e.untracked && e.staged !== ' ').map((e) => e.path);
  if (mainStaged.length > 0) {
    throw new TrackBranchError(
      `These files are staged on main: ${nameFiles(mainStaged)}. git refuses to merge while anything ` +
        'is staged — commit or unstage them (they can stay uncommitted), then land again.',
      409
    );
  }
  const worktreeCode = await commitWorktreePlanning(
    track.worktreePath,
    docRel,
    `chore: commit "${trackName}" planning before landing`
  );
  if (worktreeCode) {
    throw new TrackBranchError(
      `The track worktree has uncommitted changes (${track.worktreePath}): ${nameFiles(worktreeCode)}. ` +
        'Commit or discard them first.',
      409
    );
  }

  // 1. The plan back onto main, then PROJECT.md out of the merge.
  const returned = await returnSectionToMain({ project, worktreePath: track.worktreePath, trackName });
  let beforeReset: string | null = null;
  try {
    beforeReset = await resetDocToMergeBase(track, docRel);
  } catch (error) {
    await returned.rollback();
    throw error;
  }

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
    await returned.rollback();
    // Take the reset commit back off the track branch. Without this the next
    // Land reads the already-reset copy and the track's section is gone for
    // good. Safe: the worktree was committed clean above, so --hard discards
    // nothing else.
    if (beforeReset) await git(track.worktreePath, ['reset', '--hard', beforeReset]);
    const planning = mainEntries.map((e) => e.path);
    throw new TrackBranchError(
      `Merging ${track.branch} into ${track.baseBranch} failed. Merge ${track.baseBranch} into the track in its worktree, resolve, and land again.` +
        (planning.length > 0
          ? ` If the uncommitted planning files on main are in the way (${nameFiles(planning)}), commit or stash them.`
          : ''),
      409
    );
  }
  const mergeSha = (await git(project.cwd, ['rev-parse', 'HEAD']))?.trim() || '';
  markLanded(track.id, mergeSha);

  // 3. Publish, as the merge stage does for a job. Only commits go: the
  // uncommitted backlog edits on main stay where they are.
  let pushed = false;
  if (await hasRemote(project.cwd)) {
    pushed = (await git(project.cwd, ['push'])) !== null;
  }

  // 4. The branch's commits now live on the base; only the label goes.
  const torn = await removeWorktree(project.cwd, track.id, {
    path: track.worktreePath,
    deleteBranch: track.branch,
  });
  // The land itself stands. A link the teardown could not remove leaves the
  // worktree registered and the branch checked out there, with nothing else
  // recording either, so the result has to say where they are.
  const leftover =
    torn.linksLeft.length > 0
      ? ` ${describeLinksLeft(track.worktreePath, torn.linksLeft)} ` +
        `Then run "git worktree remove ${track.worktreePath}" and "git branch -D ${track.branch}".`
      : '';

  const synced = returned.featureIds;
  logger.info({ cwd: project.cwd, track: trackName, mergeSha, pushed, synced }, 'track landed');
  return {
    mergeSha,
    pushed,
    synced,
    detail:
      (pushed ? `Landed into ${track.baseBranch} and pushed` : `Landed into ${track.baseBranch}`) + leftover,
  };
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
