import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { createLogger } from '../utils/logger.js';
import { COMMIT_IDENTITY, git, runGit } from '../utils/git.js';
import { resolveInWorktree } from '../worktrees/resolve.js';
import { pathKey } from '../utils/paths.js';
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

const logger = createLogger('track-branches');
import { TrackBranchError, reattachIfMissing } from './track-branches.js';

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
  const result = await runGit(cwd, ['merge-tree', '--write-tree', '--name-only', ours, theirs]);
  // Exit 1 is "conflicts", with the same output; anything else is a failure.
  if (!result.ok && result.code !== 1) return null;
  const stdout = result.stdout;
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

/** One side of a conflicting merge, for a resolver and for the message naming both. */
export interface MergeSide {
  branch: string;
  sha: string;
}

/** A merge stopped on conflicts, handed to a resolver while it is still in progress in `cwd`. */
export interface MergeConflict {
  cwd: string;
  /** Unmerged paths, repo-relative. */
  paths: string[];
  /** The branch being merged into (checked out in `cwd`). */
  ours: MergeSide;
  /** The branch being merged in. */
  theirs: MergeSide;
}

export interface UpdateOptions {
  /**
   * Settle the conflicts of the in-progress merge (the merge queue's resolver
   * agent). It must leave each path resolved and staged; any path still
   * unmerged afterwards refuses as with no resolver. A throw aborts the merge.
   */
  resolve?: (conflict: MergeConflict) => Promise<void>;
}

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
 * Refuses, like Land, on a running install and on uncommitted code in the
 * worktree (uncommitted planning is committed first). The caller holds the project lock. Never pushes, never runs tests.
 *
 * Says whether the merge changed a lockfile (`lockfileChanged`), and leaves
 * the reinstall to its caller (updateAndInstall), outside the lock.
 */
export async function updateTrackFromMain(project: RegistryProject, trackName: string): Promise<UpdateResult> {
  const { track, docRel } = await updatePreflight(project, trackName);
  const base = track.baseBranch;
  const wt = track.worktreePath;

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

  await mergeBaseIntoCheckout(wt, { trackName, branch: track.branch, docRel, base, baseSha, preMerge });
  return updateResult(project, wt, { trackName, base, baseSha, behind, preMerge, docRel });
}

/**
 * Step 1 of Update from main, in the track's worktree: refuse on a running
 * install or uncommitted code; commit uncommitted planning. The
 * caller holds the project lock.
 */
async function updatePreflight(
  project: RegistryProject,
  trackName: string
): Promise<{ track: TrackBranch; docRel: string }> {
  const track = getActiveTrackBranch(project.cwd, trackName);
  if (!track) throw new TrackBranchError('This track has no branch to update', 404);
  const docRel = docRelOf(project);
  const base = track.baseBranch;

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
  return { track, docRel };
}

interface CheckoutMerge {
  trackName: string;
  /** The track branch, named to a resolver as "ours". */
  branch: string;
  docRel: string;
  base: string;
  baseSha: string;
  /** HEAD of the checkout before the merge. */
  preMerge: string;
  resolve?: (conflict: MergeConflict) => Promise<void>;
}

/**
 * Steps 2–6 of Update from main in a checkout of the track branch (its
 * worktree, or the merge queue's scratch checkout): merge the base in, put
 * the plan back, hand conflicts to `resolve` when given, commit. Any failure
 * aborts the merge, leaving the checkout as it was, and throws.
 */
async function mergeBaseIntoCheckout(wt: string, o: CheckoutMerge): Promise<void> {
  const { trackName, docRel, base, baseSha, preMerge } = o;
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

    // 5. Anything still unmerged is a real conflict. The merge queue hands it
    // to its resolver first (while the merge is still in progress, after the
    // plan is back, so the resolver never sees the trap's deletions); whatever
    // it leaves unmerged refuses as before.
    let unmerged = await unmergedPaths(wt);
    if (unmerged.length > 0 && o.resolve) {
      try {
        await o.resolve({
          cwd: wt,
          paths: unmerged,
          ours: { branch: o.branch, sha: preMerge },
          theirs: { branch: base, sha: baseSha },
        });
      } catch (error) {
        await abortMerge(wt, base);
        throw new TrackBranchError(
          `Merging ${base} into the track conflicts in ${nameFiles(unmerged)}, and resolving it failed: ` +
            `${(error as Error).message}. Nothing was changed.`,
          409
        );
      }
      unmerged = await unmergedPaths(wt);
    }
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
}

/** Steps 7 and the message, once the merge is HEAD of the track's worktree `wt`. */
async function updateResult(
  project: RegistryProject,
  wt: string,
  o: { trackName: string; base: string; baseSha: string; behind: number; preMerge: string; docRel: string }
): Promise<UpdateResult> {
  const { trackName, base, behind, preMerge } = o;
  // What the board showed as "N behind", for the message.
  const counted = (await codeCommitsBetween(wt, preMerge, o.baseSha, o.docRel)) ?? behind;
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

// --- Update from main without holding the lock (the merge queue) -----------

/** An Update from main built off to the side, ready to fast-forward the track onto. */
export interface PreparedUpdate {
  /** The track branch's head it was built on. */
  from: string;
  /** The merge commit, whose first parent is `from`. */
  commit: string;
  baseSha: string;
  behind: number;
}

/**
 * Update from main's merge, built in a scratch checkout of the track branch
 * (detached, in a temp folder) so the project lock is NOT held while a
 * resolver works through its conflicts, which can take minutes: the lock is
 * try-only, and every Land, Delete and Branch now would be refused meanwhile.
 * The track's worktree is not touched; applyPreparedUpdate fast-forwards it
 * under the lock. Null when the branch is already up to date. Throws as
 * Update does when a conflict is left; the scratch checkout always goes.
 */
export async function prepareTrackUpdate(
  project: RegistryProject,
  trackName: string,
  opts: UpdateOptions = {}
): Promise<PreparedUpdate | null> {
  const track = getActiveTrackBranch(project.cwd, trackName);
  if (!track) throw new TrackBranchError('This track has no branch to update', 404);
  const docRel = docRelOf(project);
  const base = track.baseBranch;
  const shas = (await git(project.cwd, ['rev-parse', track.branch, `${base}^{commit}`]))?.trim().split(/\s+/);
  if (!shas || shas.length !== 2) throw new TrackBranchError(`Could not read ${track.branch} and ${base}`, 500);
  const [from, baseSha] = shas;
  const behind = Number((await git(project.cwd, ['rev-list', '--count', `${from}..${baseSha}`]))?.trim());
  if (!Number.isInteger(behind)) throw new TrackBranchError(`Could not compare ${track.branch} with ${base}`, 500);
  if (behind === 0) return null;

  const scratch = mkdtempSync(join(tmpdir(), 'cr-merge-'));
  const wt = join(scratch, 'wt');
  try {
    if ((await git(project.cwd, ['worktree', 'add', '-q', '--detach', wt, from])) === null) {
      throw new TrackBranchError(`Could not check out ${track.branch} to merge ${base} into it`, 500);
    }
    await mergeBaseIntoCheckout(wt, { trackName, branch: track.branch, docRel, base, baseSha, preMerge: from, resolve: opts.resolve });
    const commit = (await git(wt, ['rev-parse', 'HEAD']))?.trim();
    if (!commit || commit === from) throw new TrackBranchError(`Merging ${base} into ${track.branch} made no commit`, 500);
    return { from, commit, baseSha, behind };
  } finally {
    // A fresh checkout holds no link (docs/track-branches.md, teardown), and
    // the commit lives on in the object store until the fast-forward.
    await git(project.cwd, ['worktree', 'remove', '--force', wt]);
    rmSync(scratch, { recursive: true, force: true });
    await git(project.cwd, ['worktree', 'prune']);
  }
}

/**
 * Fast-forward the track's worktree onto a PreparedUpdate, after Update's own
 * refusals (install, uncommitted code; planning is committed). The
 * caller holds the project lock. `moved` when the branch's head is no longer
 * the one the merge was built on: build it again.
 */
export async function applyPreparedUpdate(
  project: RegistryProject,
  trackName: string,
  prepared: PreparedUpdate
): Promise<UpdateResult | 'moved'> {
  const { track, docRel } = await updatePreflight(project, trackName);
  const wt = track.worktreePath;
  const head = (await git(wt, ['rev-parse', 'HEAD']))?.trim();
  if (head !== prepared.from) return 'moved';
  if ((await git(wt, ['merge', '-q', '--ff-only', prepared.commit])) === null) {
    throw new TrackBranchError(`Could not fast-forward the track worktree (${wt}) onto the merge of ${track.baseBranch}`, 500);
  }
  return updateResult(project, wt, {
    trackName,
    base: track.baseBranch,
    baseSha: prepared.baseSha,
    behind: prepared.behind,
    preMerge: prepared.from,
    docRel,
  });
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
