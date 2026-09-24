import { createHash } from 'crypto';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join, relative, resolve, isAbsolute } from 'path';
import { getConfig } from '../config.js';
import { createLogger } from '../utils/logger.js';
import { git, gitStatusEntries, isGitRepo } from '../agent/claude-run.js';
import { listJobsForProject } from '../jobs/store.js';
import { isLive, type JobWithStages } from '../jobs/types.js';
import { removeWorktree } from '../jobs/worktree.js';
import { parsePhasesBlock, removePhaseGroup } from '../sessions/session-log-format.js';
import type { RegistryProject } from './registry.js';
import { mutateProjectDoc, readProjectDoc, resolveSpecPath } from './project-store.js';
import { featuresOf, findFeature, parseProjectDoc, removeTrack, type FeatureStatus } from './project-doc-format.js';
import { deleteTrackBranchRows, listTrackBranches, type TrackBranch } from './track-branches.js';

const logger = createLogger('track-delete');

/**
 * Delete track: remove a track's plan and its code as one action.
 *
 * Two calls. `planTrackDelete` works out everything a delete would do and is
 * what the confirm dialog shows; `executeTrackDelete` re-plans, refuses if
 * anything moved since (409), and carries out only the parts the user ticked.
 * The step order in executeTrackDelete is what makes a failure harmless — see
 * the comment there and docs/track-branches.md.
 *
 * Attribution comes from records, never from guesses: the track's branch rows,
 * its jobs, and merges found by their exact pipeline message. Code a session
 * wrote on main without a branch is only reported (the `unattributed` note);
 * guessing at it is f-4blxce's job, and a guess must never be reverted by
 * default.
 */

export class TrackDeleteError extends Error {
  constructor(
    message: string,
    readonly status = 400,
    readonly conflicts: string[] = []
  ) {
    super(message);
    this.name = 'TrackDeleteError';
  }
}

export interface PlannedJob {
  id: string;
  title: string;
  status: string;
}

export interface PlannedMerge {
  sha: string;
  subject: string;
  /** How it was found: a track's recorded land, a job's recorded merge, or its exact message. */
  via: 'track' | 'job' | 'message';
  baseBranch: string;
}

export interface UnresolvedMerge {
  title: string;
  reason: string;
}

/**
 * - `committed`: tracked and clean — deleting is recoverable from git.
 * - `draft`: never committed, and neither were the track's lines — the whole plan is a draft.
 * - `late-draft`: never committed, but the lines were — written after them, maybe right now.
 * - `edited`: committed, with uncommitted edits that deleting would lose.
 */
export type SpecState = 'committed' | 'draft' | 'late-draft' | 'edited';

export interface PlannedSpec {
  path: string;
  state: SpecState;
  /** Ticked by default. */
  defaultDelete: boolean;
  /** False while something outside the track still references it. */
  offered: boolean;
  note: string;
  referencedBy: string[];
}

export interface TrackDeletePlan {
  /** Echoed back on execute; a mismatch means the plan is stale (409). */
  token: string;
  track: string;
  inDoc: boolean;
  features: { id: string; title: string; status: FeatureStatus }[];
  /** Live jobs, cancelled first. */
  cancel: PlannedJob[];
  /** Every job for the track, discarded after the cancel. */
  discard: PlannedJob[];
  /** The track's unlanded branch, removed with its worktree and uncommitted edits. */
  branch: {
    name: string;
    worktreePath: string;
    uncommittedFiles: number;
    sessionsToClose: number;
  } | null;
  currentBranch: string | null;
  /** Merges already on the current branch, newest first. Ticked by default. */
  merges: PlannedMerge[];
  unresolved: UnresolvedMerge[];
  specs: PlannedSpec[];
  sessionLogGroup: boolean;
  /** Uncommitted paths in the main checkout. Reverting requires none. */
  mainDirty: string[];
  /**
   * The track never had a branch, so code written for it on main cannot be
   * told apart from anything else, and this delete leaves it alone.
   */
  unattributed: { dirtyFiles: number } | null;
}

export interface TrackDeleteChoices {
  token: string;
  /** Shas from plan.merges to revert. */
  revert: string[];
  /** Paths from plan.specs to delete. */
  deleteSpecs: string[];
}

export interface TrackDeleteDeps {
  liveSessions: () => { id: string; cwd: string }[];
  terminateSession: (id: string) => Promise<unknown>;
  cancelJob: (id: string) => Promise<unknown>;
  discardJob: (id: string) => Promise<unknown>;
}

export interface TrackDeleteResult {
  committed: string | null;
  reverted: string[];
  cancelled: number;
  discarded: number;
  branchRemoved: boolean;
  specsDeleted: string[];
  detail: string;
}

const COMMIT_IDENTITY = ['-c', 'user.name=claude-remote', '-c', 'user.email=claude-remote@localhost'];

// --- Plan --------------------------------------------------------------

export async function planTrackDelete(
  project: RegistryProject,
  trackName: string,
  liveSessionCwds: string[]
): Promise<TrackDeletePlan> {
  const cwd = project.cwd;
  const docRel = project.doc || 'PROJECT.md';
  const state = readProjectDoc(project);
  const track = state.doc.tracks.find((t) => t.name === trackName) ?? null;
  const features = track ? featuresOf(track) : [];
  const featureIds = new Set(features.map((f) => f.id));

  const rows = listTrackBranches(cwd).filter((r) => r.trackName === trackName);
  if (!track && rows.length === 0) {
    throw new TrackDeleteError(`There is no track named "${trackName}"`, 404);
  }
  const active = rows.find((r) => r.landedAt === null) ?? null;
  const trackBranches = new Set(rows.map((r) => r.branch));

  const allJobs = listJobsForProject(cwd);
  const jobs = allJobs.filter(
    (j) =>
      (j.featureId !== null && featureIds.has(j.featureId)) ||
      (j.baseBranch !== null && trackBranches.has(j.baseBranch))
  );
  const jobIds = new Set(jobs.map((j) => j.id));
  const summary = (j: JobWithStages): PlannedJob => ({ id: j.id, title: j.title, status: j.status });

  const repo = await isGitRepo(cwd);
  const headSha = repo ? ((await git(cwd, ['rev-parse', 'HEAD']))?.trim() ?? null) : null;
  const currentBranch = repo
    ? ((await git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']))?.trim() ?? null)
    : null;
  const mainDirty = repo ? ((await gitStatusEntries(cwd)) ?? []).map((e) => e.path) : [];

  const { merges, unresolved } =
    repo && headSha && currentBranch
      ? await findMerges({ cwd, rows, jobs, features, trackBranches, currentBranch })
      : { merges: [], unresolved: [] };

  const specs = repo
    ? await planSpecs({ project, docRel, features, featureIds, trackName, otherJobs: allJobs.filter((j) => !jobIds.has(j.id)) })
    : [];

  let branch: TrackDeletePlan['branch'] = null;
  if (active) {
    const entries = existsSync(active.worktreePath) ? await gitStatusEntries(active.worktreePath) : [];
    branch = {
      name: active.branch,
      worktreePath: active.worktreePath,
      uncommittedFiles: entries?.length ?? 0,
      sessionsToClose: liveSessionCwds.filter((c) => isInside(active.worktreePath, c)).length,
    };
  }

  const sessionLogGroup = hasSessionLogGroup(cwd, trackName, docRel);

  const ours = new Set([docRel, ...specs.map((s) => s.path), getConfig().projectLog.fileName]);
  const unattributed =
    rows.length === 0 ? { dirtyFiles: mainDirty.filter((p) => !ours.has(p)).length } : null;

  const token = createHash('sha1')
    .update(
      JSON.stringify({
        revision: state.revision,
        headSha,
        jobs: jobs.map((j) => [j.id, j.status, j.updatedAt]),
        rows: rows.map((r) => [r.id, r.landedAt]),
      })
    )
    .digest('hex');

  return {
    token,
    track: trackName,
    inDoc: track !== null,
    features: features.map((f) => ({ id: f.id, title: f.title, status: f.status })),
    cancel: jobs.filter((j) => isLive(j.status)).map(summary),
    discard: jobs.map(summary),
    branch,
    currentBranch,
    merges,
    unresolved,
    specs,
    sessionLogGroup,
    mainDirty,
    unattributed,
  };
}

/**
 * Merges this track put on the current branch, newest first.
 *
 * Recorded shas win: a landed track's `merge_sha`, a job's `merge_sha`. A job
 * merged before that column existed — or discarded since, which deletes its
 * row and the record with it — is found by its exact pipeline subject
 * `Merge job: <title>`, and only when exactly one commit carries it. Anything
 * else is reported for a revert by hand, never guessed at.
 *
 * Jobs that merged into one of the track's own branches are skipped: a landed
 * track's merge covers them, and an unlanded branch goes with the branch.
 */
async function findMerges(opts: {
  cwd: string;
  rows: TrackBranch[];
  jobs: JobWithStages[];
  features: { id: string; title: string }[];
  trackBranches: Set<string>;
  currentBranch: string;
}): Promise<{ merges: PlannedMerge[]; unresolved: UnresolvedMerge[] }> {
  const { cwd, rows, jobs, features, trackBranches, currentBranch } = opts;
  const found = new Map<string, PlannedMerge>();
  const unresolved: UnresolvedMerge[] = [];

  const onCurrent = async (sha: string): Promise<boolean> =>
    (await git(cwd, ['merge-base', '--is-ancestor', sha, 'HEAD'])) !== null;
  const subjectOf = async (sha: string): Promise<string> =>
    (await git(cwd, ['log', '-1', '--format=%s', sha]))?.trim() ?? '';

  const consider = async (sha: string, via: PlannedMerge['via'], base: string, title: string) => {
    if (found.has(sha)) return;
    if (base !== currentBranch) {
      unresolved.push({
        title,
        reason: `merged into ${base}, but the project is on ${currentBranch} — switch to ${base} to revert it`,
      });
      return;
    }
    if (!(await onCurrent(sha))) {
      unresolved.push({ title, reason: `its merge ${sha.slice(0, 8)} is not on ${currentBranch}` });
      return;
    }
    found.set(sha, { sha, subject: await subjectOf(sha), via, baseBranch: base });
  };

  for (const row of rows) {
    if (row.landedAt && row.mergeSha) {
      await consider(row.mergeSha, 'track', row.baseBranch, `track branch ${row.branch}`);
    }
  }

  // Subject -> shas, for everything found by message.
  let bySubject: Map<string, string[]> | null = null;
  const withSubject = async (subject: string): Promise<string[]> => {
    if (!bySubject) {
      bySubject = new Map();
      const out = (await git(cwd, ['log', 'HEAD', '--merges', '--format=%H%x09%s'])) ?? '';
      for (const line of out.split('\n')) {
        const tab = line.indexOf('\t');
        if (tab < 0) continue;
        const s = line.slice(tab + 1).trim();
        bySubject.set(s, [...(bySubject.get(s) ?? []), line.slice(0, tab)]);
      }
    }
    return bySubject.get(subject) ?? [];
  };
  const byMessage = async (title: string, base: string, mustExist: boolean) => {
    const shas = await withSubject(`Merge job: ${title}`);
    if (shas.length === 1) return consider(shas[0], 'message', base, title);
    if (shas.length > 1) {
      unresolved.push({ title, reason: `${shas.length} merges share the message "Merge job: ${title}"` });
    } else if (mustExist) {
      unresolved.push({ title, reason: 'its merge commit could not be found' });
    }
  };

  for (const job of jobs) {
    const merged = job.stages.some((s) => s.name === 'merge' && s.status === 'passed');
    if (!merged || !job.baseBranch || trackBranches.has(job.baseBranch)) continue;
    if (job.mergeSha) await consider(job.mergeSha, 'job', job.baseBranch, job.title);
    else await byMessage(job.title, job.baseBranch, true);
  }

  // Features with no job row left at all: a done job is usually discarded,
  // and its merge is still on the branch. Found only by exact message.
  const withJobs = new Set(jobs.map((j) => j.featureId));
  for (const f of features) {
    if (!withJobs.has(f.id)) await byMessage(f.title, currentBranch, false);
  }

  // Newest first, by position in the current branch's history.
  const order = ((await git(cwd, ['rev-list', '--topo-order', 'HEAD'])) ?? '').split('\n');
  const rank = new Map(order.map((sha, i) => [sha.trim(), i]));
  const merges = [...found.values()].sort(
    (a, b) => (rank.get(a.sha) ?? Infinity) - (rank.get(b.sha) ?? Infinity)
  );
  return { merges, unresolved };
}

async function planSpecs(opts: {
  project: RegistryProject;
  docRel: string;
  features: { id: string; spec: string | null }[];
  featureIds: Set<string>;
  trackName: string;
  otherJobs: JobWithStages[];
}): Promise<PlannedSpec[]> {
  const { project, docRel, features, featureIds, trackName, otherJobs } = opts;
  const cwd = project.cwd;
  const paths = [...new Set(features.map((f) => f.spec).filter((s): s is string => !!s))];
  if (paths.length === 0) return [];

  // Were the track's lines in the last commit? Parsed, never grepped.
  const headDoc = await git(cwd, ['show', `HEAD:${docRel.replace(/\\/g, '/')}`]);
  const linesInHead =
    headDoc !== null && [...featureIds].some((id) => findFeature(parseProjectDoc(headDoc), id));

  const current = readProjectDoc(project).doc;
  const phaseSources = sessionLogGroups(cwd).filter((g) => g.group !== trackName);

  const out: PlannedSpec[] = [];
  for (const path of paths) {
    const abs = resolveSpecPath(project, path);
    if (!abs || !existsSync(abs)) continue; // nothing on main to delete

    const tracked = (await git(cwd, ['ls-files', '--error-unmatch', '--', path])) !== null;
    const dirty = ((await git(cwd, ['status', '--porcelain', '--', path])) ?? '').trim() !== '';

    const referencedBy: string[] = [];
    for (const t of current.tracks) {
      if (t.name === trackName) continue;
      for (const f of featuresOf(t)) {
        if (f.spec === path) referencedBy.push(`${f.id} in "${t.name}"`);
      }
    }
    const grep = await git(cwd, [
      'grep',
      '-l',
      '-F',
      '-e',
      path,
      '--',
      '.',
      `:(exclude)${docRel}`,
      `:(exclude)${path}`,
    ]);
    for (const file of (grep ?? '').split('\n').map((l) => l.trim()).filter(Boolean)) {
      referencedBy.push(file);
    }
    for (const g of phaseSources) {
      if (g.source === path) referencedBy.push(`SESSION-LOG group "${g.group}"`);
    }
    for (const j of otherJobs) {
      if (j.stages.some((s) => s.name === 'design' && s.detail === path)) {
        referencedBy.push(`job "${j.title}"`);
      }
    }

    let state: SpecState;
    let defaultDelete: boolean;
    let note: string;
    if (tracked && !dirty) {
      [state, defaultDelete, note] = ['committed', true, 'recoverable from git'];
    } else if (!tracked && !linesInHead) {
      [state, defaultDelete, note] = ['draft', true, 'never committed — deleted permanently'];
    } else if (!tracked) {
      [state, defaultDelete, note] = [
        'late-draft',
        false,
        'never committed, and written after the track’s lines were — deleted permanently',
      ];
    } else {
      [state, defaultDelete, note] = ['edited', false, 'has uncommitted edits that would be lost'];
    }

    const offered = referencedBy.length === 0;
    out.push({
      path,
      state,
      defaultDelete: offered && defaultDelete,
      offered,
      note: offered ? note : `kept — still referenced by ${referencedBy.join(', ')}`,
      referencedBy,
    });
  }
  return out;
}

function sessionLogPath(cwd: string): string {
  return join(cwd, getConfig().projectLog.fileName);
}

function sessionLogGroups(cwd: string) {
  try {
    const path = sessionLogPath(cwd);
    return existsSync(path) ? parsePhasesBlock(readFileSync(path, 'utf-8')) : [];
  } catch {
    return [];
  }
}

function hasSessionLogGroup(cwd: string, trackName: string, docRel: string): boolean {
  return sessionLogGroups(cwd).some((g) => g.group === trackName && g.source === docRel);
}

function isInside(root: string, p: string): boolean {
  const rel = relative(resolve(root), resolve(p));
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

// --- Execute -----------------------------------------------------------

/**
 * Carry out a confirmed plan.
 *
 * The order makes a failure harmless:
 *  1. re-plan and compare tokens — anything moved since the dialog opened is a 409;
 *  2. preflight: reverting needs a clean main checkout, checked before anything is touched;
 *  3. cancel live jobs — the only step before the revert can fail, and a cancelled
 *     job is still discardable, so a failed delete loses nothing;
 *  4. revert with --no-commit; on a conflict abort and `reset --hard` to the
 *     preflight HEAD (safe: step 2 left no uncommitted work to lose);
 *  5. tear down: close sessions in the track worktree, discard jobs, remove the
 *     worktree and branch, forget the rows;
 *  6. edit PROJECT.md, specs, the SESSION-LOG group;
 *  7. commit, only if something was reverted — one commit, never pushed.
 */
export async function executeTrackDelete(
  project: RegistryProject,
  trackName: string,
  choices: TrackDeleteChoices,
  deps: TrackDeleteDeps
): Promise<TrackDeleteResult> {
  const cwd = project.cwd;
  const docRel = project.doc || 'PROJECT.md';
  const sessions = deps.liveSessions();

  // 1.
  const plan = await planTrackDelete(project, trackName, sessions.map((s) => s.cwd));
  if (plan.token !== choices.token) {
    throw new TrackDeleteError('The track changed since this was opened — review it again', 409);
  }
  const reverts = plan.merges.filter((m) => choices.revert.includes(m.sha));
  const specs = plan.specs.filter((s) => s.offered && choices.deleteSpecs.includes(s.path));

  // 2.
  let preHead: string | null = null;
  if (reverts.length > 0) {
    if (plan.mainDirty.length > 0) {
      throw new TrackDeleteError(
        `Reverting needs a clean checkout, and these files have uncommitted changes: ${plan.mainDirty.join(', ')}`,
        409
      );
    }
    preHead = (await git(cwd, ['rev-parse', 'HEAD']))?.trim() ?? null;
    if (!preHead) throw new TrackDeleteError('Could not read the project’s HEAD', 500);
  }

  // 3.
  let cancelled = 0;
  for (const job of plan.cancel) {
    try {
      await deps.cancelJob(job.id);
      cancelled++;
    } catch (error) {
      // It may have finished on its own since the plan; Discard takes it next.
      logger.warn({ jobId: job.id, error: (error as Error).message }, 'track-delete: cancel failed');
    }
  }

  // 4.
  for (const merge of reverts) {
    const parents = ((await git(cwd, ['rev-list', '--parents', '-n', '1', merge.sha])) ?? '')
      .trim()
      .split(/\s+/).length - 1;
    const args = ['revert', '--no-commit', ...(parents > 1 ? ['-m', '1'] : []), merge.sha];
    if ((await git(cwd, [...COMMIT_IDENTITY, ...args])) === null) {
      const conflicts = ((await git(cwd, ['diff', '--name-only', '--diff-filter=U'])) ?? '')
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean);
      await git(cwd, ['revert', '--abort']);
      await git(cwd, ['reset', '--hard', preHead as string]);
      throw new TrackDeleteError(
        `Reverting ${merge.subject || merge.sha.slice(0, 8)} conflicts with later work, so nothing was changed. ` +
          'Revert it by hand, then delete the track again.',
        409,
        conflicts
      );
    }
  }

  // 5.
  let branchRemoved = false;
  if (plan.branch) {
    for (const s of sessions) {
      if (isInside(plan.branch.worktreePath, s.cwd)) await deps.terminateSession(s.id);
    }
  }
  let discarded = 0;
  for (const job of plan.discard) {
    try {
      await deps.discardJob(job.id);
      discarded++;
    } catch (error) {
      logger.warn({ jobId: job.id, error: (error as Error).message }, 'track-delete: discard failed');
    }
  }
  if (plan.branch) {
    const torn = await removeWorktree(cwd, 'track', {
      path: plan.branch.worktreePath,
      deleteBranch: plan.branch.name,
    });
    branchRemoved = torn.removed && torn.branchDeleted;
  }
  deleteTrackBranchRows(cwd, trackName);

  // 6.
  if (plan.inDoc) mutateProjectDoc(project, null, (doc) => removeTrack(doc, trackName));
  const specsDeleted: string[] = [];
  for (const spec of specs) {
    const abs = resolveSpecPath(project, spec.path);
    if (abs && existsSync(abs)) {
      rmSync(abs, { force: true });
      specsDeleted.push(spec.path);
    }
  }
  if (plan.sessionLogGroup) {
    const path = sessionLogPath(cwd);
    const next = removePhaseGroup(readFileSync(path, 'utf-8'), trackName, docRel);
    if (next !== null) writeFileSync(path, next);
  }

  // 7.
  let committed: string | null = null;
  if (reverts.length > 0) {
    // One path at a time: `git add` rejects the whole call when any pathspec
    // matches nothing, which a deleted never-committed spec does — and
    // PROJECT.md would silently drop out of the commit with it.
    for (const path of [docRel, ...specsDeleted]) await git(cwd, ['add', '-A', '--', path]);
    const ok = await git(cwd, [
      ...COMMIT_IDENTITY,
      'commit',
      '-q',
      '-m',
      `Delete track: ${trackName}`,
      '-m',
      `Reverts ${reverts.map((m) => m.sha.slice(0, 8)).join(', ')}.`,
      '--no-verify',
    ]);
    if (ok !== null) committed = (await git(cwd, ['rev-parse', 'HEAD']))?.trim() ?? null;
  }

  logger.info(
    { cwd, track: trackName, reverted: reverts.length, cancelled, discarded, branchRemoved, specsDeleted, committed },
    'track deleted'
  );
  return {
    committed,
    reverted: reverts.map((m) => m.sha),
    cancelled,
    discarded,
    branchRemoved,
    specsDeleted,
    detail: committed
      ? `Deleted "${trackName}" and reverted ${reverts.length} merge(s) in one commit (${committed.slice(0, 8)}), not pushed.`
      : `Deleted "${trackName}". The changes are left uncommitted.`,
  };
}
