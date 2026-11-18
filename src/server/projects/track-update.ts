import { execFile } from 'child_process';
import { mkdirSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { promisify } from 'util';
import { createLogger } from '../utils/logger.js';
import { COMMIT_IDENTITY, git } from '../agent/claude-run.js';
import { resolveInWorktree } from '../jobs/docs.js';
import { pathKey } from '../sessions/project-discovery.js';
import { loadRegistry, type RegistryProject } from './registry.js';
import { parseProjectDoc, renderProjectDoc, replaceTrack, type Track } from './project-doc-format.js';
import type { WorkspaceProject } from './workspace.js';
import { getActiveTrackBranch, type TrackBranch } from './track-store.js';
import { LOCKFILES, isInstalling } from './project-deps.js';
import {
  commitWorktreePlanning,
  docRelOf,
  mergeTrapAdvice,
  nameFiles,
  specFolderOf,
  specsOf,
} from './track-plan.js';

const execFileAsync = promisify(execFile);
const logger = createLogger('track-branches');
import { TrackBranchError, liveJobsOf, reattachIfMissing } from './track-branches.js';

/**
 * A track branch against main (docs/track-branches.md): how far behind it is and whether
 * merging main in would conflict (the board's badge, a session's Land preflight), and the
 * Update from main that merges it in, restoring the track's section and specs.
 */

// --- Behind main ---------------------------------------------------------

export interface BehindMain {
  /** Commits on the base branch the track branch lacks, outside planning files. */
  behind: number;
  /**
   * Paths a merge of the base into the branch would conflict on, minus the
   * plan doc and the track's own specs (Update settles those itself). Null
   * when the dry run couldn't be made (git older than 2.38, or it failed):
   * shown as "behind" only, never as a false "clean".
   */
  wouldConflict: string[] | null;
}

/** By track id: the result for one (base sha, branch sha) pair. */
const behindCache = new Map<string, { key: string; result: BehindMain }>();

/**
 * How far a track branch is behind its base, and what merging the base in
 * would conflict on. Cached by (base sha, branch sha), so the board pays one
 * rev-parse per branched track until one of them moves. Null when the shas
 * can't be read (a branch deleted underneath, say).
 */
export async function behindMain(project: RegistryProject, track: TrackBranch): Promise<BehindMain | null> {
  const shas = (await git(project.cwd, ['rev-parse', track.baseBranch, track.branch]))?.trim().split(/\s+/);
  if (!shas || shas.length !== 2) return null;
  const [baseSha, branchSha] = shas;
  // The plan doc decides which commits and conflicts count, so it is part of the key.
  const docRel = docRelOf(project);
  const key = `${baseSha}|${branchSha}|${docRel}`;
  const cached = behindCache.get(track.id);
  if (cached?.key === key) return cached.result;

  const count = await codeCommitsBetween(project.cwd, branchSha, baseSha, docRel);
  if (count === null) return null;
  let result: BehindMain = { behind: count, wouldConflict: [] };
  if (count > 0) {
    const conflicts = await dryRunConflicts(project.cwd, branchSha, baseSha);
    if (conflicts === null) {
      result = { behind: count, wouldConflict: null };
    } else {
      const section = await sectionAt(project.cwd, branchSha, docRel, track.trackName);
      const ownSpecs = await specsOffBase(project.cwd, baseSha, specsOf(section));
      const plan = new Set([docRel, ...ownSpecs].map((p) => p.toLowerCase()));
      result = { behind: count, wouldConflict: conflicts.filter((p) => !plan.has(p.toLowerCase())) };
    }
  }
  behindCache.set(track.id, { key, result });
  return result;
}

/**
 * Commits in `to` that `from` lacks, leaving out those that touch only
 * planning files. Branching itself puts one on main (the move of the section
 * off it), so every new track would otherwise read "1 behind" — and the plan
 * never needs an Update: Land copies it across instead of merging it.
 */
async function codeCommitsBetween(cwd: string, from: string, to: string, docRel: string): Promise<number | null> {
  const out = await git(cwd, [
    'rev-list',
    '--count',
    `${from}..${to}`,
    '--',
    '.',
    `:(exclude)${docRel}`,
    `:(exclude)${specFolderOf(docRel)}*.md`,
  ]);
  const count = Number(out?.trim());
  return out !== null && Number.isInteger(count) ? count : null;
}

/**
 * `git merge-tree --write-tree --name-only`: the paths a merge of `theirs`
 * into `ours` conflicts on, without touching any checkout. Null when git
 * can't do it (`--write-tree` needs 2.38+) or fails.
 */
async function dryRunConflicts(cwd: string, ours: string, theirs: string): Promise<string[] | null> {
  let stdout: string;
  try {
    ({ stdout } = await execFileAsync('git', ['merge-tree', '--write-tree', '--name-only', ours, theirs], {
      cwd,
      windowsHide: true,
      maxBuffer: 16 * 1024 * 1024,
    }));
  } catch (error) {
    // Exit 1 is "conflicts", with the same output; anything else is a failure.
    const e = error as { code?: unknown; stdout?: string };
    if (e.code !== 1 || typeof e.stdout !== 'string') return null;
    stdout = e.stdout;
  }
  // The tree's oid, then one conflicted path per line, then a blank line and
  // git's informational messages.
  const lines = stdout.split('\n').map((l) => l.replace(/\r$/, ''));
  const paths: string[] = [];
  for (const line of lines.slice(1)) {
    if (line === '') break;
    paths.push(line.startsWith('"') && line.endsWith('"') ? line.slice(1, -1) : line);
  }
  return [...new Set(paths)];
}

/**
 * The specs among `specs` that `baseSha` lacks: the ones the branch's move
 * took off main, which Update restores from the branch. A spec main still
 * has is shared with another section; it merges like any other file, and a
 * conflict on it is a real one — taking the branch's copy would revert
 * main's edit when the track lands.
 */
async function specsOffBase(cwd: string, baseSha: string, specs: string[]): Promise<string[]> {
  const out: string[] = [];
  for (const spec of specs) {
    if ((await git(cwd, ['cat-file', '-e', `${baseSha}:${spec}`])) === null) out.push(spec);
  }
  return out;
}

/** A track's section in the plan doc as committed at `rev`, or undefined. */
async function sectionAt(cwd: string, rev: string, docRel: string, trackName: string): Promise<Track | undefined> {
  const text = await git(cwd, ['show', `${rev}:${docRel}`]);
  return text === null ? undefined : parseProjectDoc(text).tracks.find((t) => t.name === trackName);
}

/**
 * The board's `behind` and `wouldConflict` for every branched track. Run
 * after the board is built, since that is synchronous and this is git. Never
 * throws: a track whose state can't be read just shows no warning.
 */
export async function addBehindMain(projects: WorkspaceProject[]): Promise<WorkspaceProject[]> {
  // The registry entry, not just the cwd: a project's `doc` override decides
  // which files are its plan, and so which commits and conflicts count.
  let registered: RegistryProject[] = [];
  try {
    registered = loadRegistry().projects;
  } catch (error) {
    logger.warn({ error: (error as Error).message }, 'behind main: registry not read');
  }
  const jobs: Promise<void>[] = [];
  for (const p of projects) {
    const entry = registered.find((r) => pathKey(r.cwd) === pathKey(p.cwd)) ?? { cwd: p.cwd };
    for (const t of p.tracks) {
      if (!t.branch || t.worktreeMissing) continue;
      jobs.push(
        (async () => {
          try {
            const row = getActiveTrackBranch(p.cwd, t.name);
            const state = row ? await behindMain({ ...entry, cwd: p.cwd }, row) : null;
            if (state) Object.assign(t, state);
          } catch (error) {
            logger.warn({ cwd: p.cwd, track: t.name, error: (error as Error).message }, 'behind main: not read');
          }
        })()
      );
    }
  }
  await Promise.all(jobs);
  return projects;
}

// --- Update from main ----------------------------------------------------

export interface UpdateResult {
  /** The merge commit on the track branch, or null when it was already up to date. */
  mergeSha: string | null;
  /**
   * The merge brought in a different lockfile, so the worktree's
   * `node_modules` is stale; null when git could not tell.
   */
  lockfileChanged: boolean | null;
  detail: string;
}

/**
 * Merge the base branch into a track's worktree, keeping the track's plan.
 *
 * The trap: main holds the commit that took this track's section and specs
 * off it when the track branched (moveSectionOffMain). A plain
 * `git merge <base>` applies that deletion to the branch: the section goes,
 * every spec the branch never touched is deleted with no conflict, and one
 * it revised is a modify/delete conflict. So after the merge, before the
 * commit, the plan is put back as the branch's HEAD had it:
 *  - the plan doc becomes the BASE's version with this track's section
 *    replaced by HEAD's. The worktree's copy is authoritative only for this
 *    section, the rest is a stale copy of main's, so a three-way merge of the
 *    file would conflict on nearly every Update;
 *  - each of the section's specs that the base lacks is restored from HEAD,
 *    whether git deleted it or conflicted on it. A spec the base still has
 *    is shared with another section and merges like any file: taking HEAD's
 *    copy over a conflict there would revert main's edit when the track
 *    lands.
 * Any other conflict aborts the merge, leaving the worktree as it was, and
 * refuses naming the paths. The fix goes on either side, then Update again;
 * a plain `git merge` in a session would walk into the trap above.
 *
 * Refuses, like Land, on a live job for the track, a running install, and
 * uncommitted code in the worktree (uncommitted planning is committed
 * first). The caller holds the project lock. Never pushes, never runs tests.
 *
 * Says whether the merge changed a lockfile (`lockfileChanged`), and leaves
 * the reinstall to its caller (updateAndInstall), outside the lock.
 */
export async function updateTrackFromMain(project: RegistryProject, trackName: string): Promise<UpdateResult> {
  const track = getActiveTrackBranch(project.cwd, trackName);
  if (!track) throw new TrackBranchError('This track has no branch to update', 404);
  const docRel = docRelOf(project);
  const base = track.baseBranch;

  // A job merging into the track branch meanwhile would race this merge.
  const liveJobs = liveJobsOf(project, track);
  if (liveJobs.length > 0) {
    throw new TrackBranchError(
      `${liveJobs.length} job(s) for this track are still active — let them finish or cancel them first`,
      409
    );
  }
  if (isInstalling(track.worktreePath)) {
    throw new TrackBranchError('Dependencies are still installing in this track’s worktree — try again shortly', 409);
  }
  await reattachIfMissing(project, track);
  const wt = track.worktreePath;
  const worktreeCode = await commitWorktreePlanning(
    wt,
    docRel,
    `chore: commit "${trackName}" planning before updating from ${base}`
  );
  if (worktreeCode) {
    throw new TrackBranchError(
      `The track worktree has uncommitted changes (${wt}): ${nameFiles(worktreeCode)}. ` +
        'Commit or discard them first.',
      409
    );
  }

  const baseSha = (await git(wt, ['rev-parse', '--verify', `${base}^{commit}`]))?.trim();
  if (!baseSha) throw new TrackBranchError(`Could not find the branch "${base}"`, 500);
  const behindOut = await git(wt, ['rev-list', '--count', `HEAD..${baseSha}`]);
  const behind = Number(behindOut?.trim());
  if (behindOut === null || !Number.isInteger(behind)) {
    throw new TrackBranchError(`Could not compare the track branch with ${base} in ${wt}`, 500);
  }
  if (behind === 0) return { mergeSha: null, lockfileChanged: false, detail: `Already up to date with ${base}` };
  const preMerge = (await git(wt, ['rev-parse', 'HEAD']))?.trim();
  if (!preMerge) throw new TrackBranchError(`Could not read the track branch's HEAD in ${wt}`, 500);
  // What the board showed as "N behind", for the message.
  const counted = (await codeCommitsBetween(wt, 'HEAD', baseSha, docRel)) ?? behind;

  // 2. The plan as the branch has it: its section, and the specs it links to
  // that the base lacks (the ones the move took off main).
  const section = await sectionAt(wt, 'HEAD', docRel, trackName);
  const specs: string[] = [];
  for (const spec of await specsOffBase(wt, baseSha, specsOf(section))) {
    if (!resolveInWorktree(wt, spec)) continue;
    if ((await git(wt, ['cat-file', '-e', `HEAD:${spec}`])) !== null) specs.push(spec);
  }

  // 3. Merge, leaving the result uncommitted.
  await git(wt, [...COMMIT_IDENTITY, 'merge', '--no-ff', '--no-commit', baseSha]);
  if ((await git(wt, ['rev-parse', '-q', '--verify', 'MERGE_HEAD'])) === null) {
    // Refused before it started (nothing to abort): the worktree is as it was.
    throw new TrackBranchError(`Could not merge ${base} into the track worktree (${wt})`, 500);
  }

  try {
    // 4. The plan back.
    const mainText = await git(wt, ['show', `${baseSha}:${docRel}`]);
    if (section || mainText !== null) {
      const doc = parseProjectDoc(mainText ?? '');
      if (section) replaceTrack(doc, section);
      const abs = join(wt, docRel);
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, renderProjectDoc(doc), 'utf-8');
      if ((await git(wt, ['add', '--', docRel])) === null) throw new Error(`Could not stage ${docRel}`);
    }
    // The base lacks each of these, so git either deleted it (the branch left
    // it alone) or conflicted on it (the branch revised it): the branch's
    // copy is the only one there is.
    for (const spec of specs) {
      if ((await git(wt, ['checkout', 'HEAD', '--', spec])) === null) throw new Error(`Could not restore ${spec}`);
    }

    // 5. Anything still unmerged is a real conflict.
    const unmerged = await unmergedPaths(wt);
    if (unmerged.length > 0) {
      await abortMerge(wt, base);
      throw new TrackBranchError(
        `Merging ${base} into the track conflicts in ${nameFiles(unmerged)}. Nothing was changed. ` +
          `Make those files agree on either side — commit the fix on the track branch in its session, ` +
          `or on ${base} — then Update again. ${mergeTrapAdvice(base)}`,
        409
      );
    }

    // 6. Commit. Track branches are local: never pushed.
    const committed = await git(wt, [
      ...COMMIT_IDENTITY,
      'commit',
      '-q',
      '--no-verify',
      '-m',
      `Merge ${base} into track: ${trackName}`,
    ]);
    if (committed === null) throw new Error('Could not commit the merge');
  } catch (error) {
    if (error instanceof TrackBranchError) throw error;
    await abortMerge(wt, base);
    throw new TrackBranchError(
      `Updating from ${base} failed: ${(error as Error).message}. Nothing was changed.`,
      500
    );
  }

  const mergeSha = (await git(wt, ['rev-parse', 'HEAD']))?.trim() || '';
  logger.info({ cwd: project.cwd, track: trackName, base, behind, mergeSha }, 'track updated from main');

  // 7. Whether the worktree's node_modules still matches.
  const lockDiff = await git(wt, ['diff', '--name-only', preMerge, 'HEAD', '--', ...LOCKFILES]);
  if (lockDiff === null) logger.warn({ wt }, 'update from main: could not tell whether the lockfile changed');

  return {
    mergeSha,
    lockfileChanged: lockDiff === null ? null : lockDiff.trim() !== '',
    detail:
      (counted > 0
        ? `Merged ${counted} commit${counted === 1 ? '' : 's'} from ${base} into the track. `
        : `Merged ${base}'s planning changes into the track. `) + 'Run the tests in the track’s session.',
  };
}

/**
 * `git merge --abort`, or a refusal saying the worktree was left mid-merge —
 * never a "nothing was changed" that isn't true (another git process holding
 * the index is enough to make the abort fail).
 */
async function abortMerge(wt: string, base: string): Promise<void> {
  if ((await git(wt, ['merge', '--abort'])) !== null) return;
  throw new TrackBranchError(
    `Merging ${base} into the track failed, and so did undoing it: the worktree (${wt}) is mid-merge. ` +
      'Run `git merge --abort` there before anything else.',
    500
  );
}

async function unmergedPaths(cwd: string): Promise<string[]> {
  const out = await git(cwd, ['diff', '--name-only', '--diff-filter=U']);
  return [...new Set((out ?? '').split('\n').map((l) => l.trim()).filter(Boolean))];
}
