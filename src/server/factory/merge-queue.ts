import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { createLogger } from '../utils/logger.js';
import { pathKey } from '../utils/paths.js';
import { COMMIT_IDENTITY, git, gitStatusEntries, hasRemote, offBranch } from '../utils/git.js';
import { getConfig } from '../config.js';
import { runClaude } from '../agent/claude-run.js';
import { sessionManager } from '../sessions/manager.js';
import { broadcastLandResult, removeWorktreeSessions } from '../websocket/connections.js';
import { pushLandResult } from '../push/wire.js';
import type { LandNotificationPayload } from '../websocket/protocol.js';
import { loadRegistry, type RegistryProject } from '../projects/registry.js';
import { ProjectBusyError, withProjectLock } from '../projects/project-lock.js';
import { buildProject, type BuildResult } from '../projects/project-build.js';
import { landAndBuild } from '../projects/track-land.js';
import { landPreflight, type LandResult } from '../projects/track-land-core.js';
import { TrackBranchError } from '../projects/track-branches.js';
import { findActiveTrackBranchByName, getActiveTrackBranch, trackBranchContaining, type TrackBranch } from '../projects/track-store.js';
import {
  applyPreparedUpdate,
  behindMain,
  prepareTrackUpdate,
  type MergeConflict,
  type PreparedUpdate,
} from '../projects/track-update.js';
import {
  commitOnHead,
  commitWorktreePlanning,
  docRelOf,
  isPlanningPath,
  isSessionLogPath,
  nameFiles,
} from '../projects/track-plan.js';
import { findFeature, parseProjectDoc, renderProjectDoc, updateFeature } from '../projects/project-doc-format.js';
import { readProjectPlan } from '../projects/project-plan.js';
import { invalidateProjectCache } from '../projects/project-discovery.js';
import { multiFeatureMergeMessageArgs } from '../projects/merge-trailers.js';
import { readQaDoc } from '../qa/qa-doc.js';
import { readProjectDoc } from '../projects/project-store.js';
import { runCommand } from '../qa/run-command.js';
import { getItem, updateItem } from './store.js';
import {
  getMerge,
  insertMerge,
  latestMergeFor,
  listMerges,
  listUnfinishedMerges,
  updateMerge,
  type MergeRecord,
  type ParkedConflict,
} from './merge-queue-store.js';

const logger = createLogger('merge-queue');

/**
 * The factory's merge queue (project/code-factory.md, "Merges go through one
 * queue per project"). One slot per project: entries run one at a time, so
 * two merges never interleave their checks and git calls.
 *
 * An entry, at its turn:
 *  1. waits (`holding`) while the checkout it merges into has uncommitted
 *     code, staged files, or another branch checked out: the queue never
 *     merges under the user. It resumes by itself once that is clean.
 *  2. brings its branch up to date with the base. A conflict goes to a
 *     resolver agent in the entry's worktree; whatever it can't settle parks
 *     the entry with both sides named, and the worktree is as it was.
 *  3. re-verifies (QA.md commands and PROJECT.md `verify:`) whenever the code
 *     being merged changed, and parks on a failure: a red result never merges.
 *  4. merges with the Job-Id/Feature trailers, records the merge sha, ticks
 *     the features in the plan that holds them (through a temporary index,
 *     never `git add`), pushes main where there is a remote, and rebuilds.
 *
 * The project lock is taken only around the git that touches a shared
 * checkout (the merge, the fast-forward of a track's Update, Land), never
 * across a resolver run or a verification — an item resolves in its own
 * worktree, a track in a scratch checkout: the lock is try-only, and
 * holding it for minutes would refuse every Land, Delete and board write.
 * A busy lock makes the entry hold and retry; nothing waits on the queue
 * while holding the lock, so this cannot deadlock.
 *
 * Kinds:
 *  - `item`: a factory item's branch and worktree, merged into `baseBranch`
 *    where it is checked out (the project for main, the track's worktree for
 *    a track branch). Always re-verified.
 *  - `track`: a track the factory ran, landed through Land after Update from
 *    main (with the resolver) and verification; its features ticked on main.
 *  - `session-land`: a session's or the board's Land. Every Land rule stays
 *    Land's own (landTrack): it refuses rather than holds. The queue only adds
 *    the turn, and Update from main with the resolver when the dry run says
 *    the merge would conflict (then verification, since the code changed).
 */

// --- The engine seam (src/server/factory/merge-sink.ts declares the same) ---

export interface MergeEntry {
  projectCwd: string;
  kind: 'item' | 'track' | 'session-land';
  branch: string;
  worktreePath: string;
  baseBranch: string;
  featureIds: string[];
  trackName?: string;
}

export interface MergeOutcome {
  id: string;
  status: 'merged' | 'parked';
  mergeSha: string | null;
  detail: string;
  /** For a parked entry stopped by a conflict: both sides and the paths. */
  conflict: ParkedConflict | null;
  /** The error that parked it (a Land refusal keeps its HTTP status). */
  error: Error | null;
  /** For the land kinds: Land's own result, with its build. */
  land: (LandResult & { build: BuildResult }) | null;
}

export interface MergeTicket {
  /** The entry's row in `factory_merges`. */
  id: string;
  /** Entries ahead of it when it was queued; 0 means it runs now. */
  position: number;
  /** Settles when the entry has merged or parked. Never rejects. */
  done: Promise<MergeOutcome>;
}

// --- Dependencies (tests replace them) -------------------------------------

export interface VerifyResult {
  ok: boolean;
  detail: string;
}

export interface MergeQueueDeps {
  /** Run the project's declared checks in `cwd`. */
  verify(cwd: string): Promise<VerifyResult>;
  /**
   * The resolver agent: edit the conflicting files in `conflict.cwd` so no
   * conflict marker is left. The queue checks and stages the result itself.
   */
  resolve(conflict: MergeConflict, ctx: { projectCwd: string; entryId: string }): Promise<void>;
  /** Build the main checkout after a merge into main. */
  build(cwd: string): Promise<BuildResult>;
  /** Land as the board runs it: closes the worktree's sessions, lands under the lock, builds. */
  land(project: RegistryProject, trackName: string): Promise<LandResult & { build: BuildResult }>;
  /** The registry entry for a project folder (its plan doc may be overridden). */
  project(cwd: string): RegistryProject;
  /** Report a resumed Land's result (resumeMergeQueues): its requester is gone. Never throws. */
  notifyLand(payload: LandNotificationPayload): void;
  /** How often a holding entry re-checks the checkout. */
  holdPollMs: number;
  /** How long to wait before retrying a busy project lock. */
  busyRetryMs: number;
  /** Re-updates allowed when the base keeps moving between verification and merge. */
  maxRounds: number;
}

const defaultDeps: MergeQueueDeps = {
  verify: verifyDeclaredChecks,
  resolve: resolveWithAgent,
  build: buildProject,
  land: (project, trackName) =>
    landAndBuild(project, trackName, {
      sessions: sessionManager.getRunningSessions().map((s) => ({ id: s.id, cwd: s.cwd })),
      terminateSession: (id) => sessionManager.terminateSession(id),
      removeSessions: removeWorktreeSessions,
    }),
  project: (cwd) => {
    try {
      const found = loadRegistry().projects.find((p) => pathKey(p.cwd) === pathKey(cwd));
      if (found) return { ...found, cwd };
    } catch (error) {
      logger.warn({ cwd, error: (error as Error).message }, 'merge queue: registry not read');
    }
    return { cwd };
  },
  notifyLand: (payload) => {
    try {
      broadcastLandResult(payload);
      pushLandResult(payload);
    } catch (error) {
      logger.warn({ error }, 'merge queue: could not send a land result');
    }
  },
  holdPollMs: 15_000,
  busyRetryMs: 5_000,
  maxRounds: 3,
};

let deps: MergeQueueDeps = { ...defaultDeps };

/** Replace some dependencies (tests). */
export function configureMergeQueue(overrides: Partial<MergeQueueDeps>): void {
  deps = { ...deps, ...overrides };
}

/** Back to the real dependencies, with every lane forgotten (tests). */
export function resetMergeQueue(): void {
  deps = { ...defaultDeps };
  for (const lane of lanes.values()) lane.wake?.();
  lanes.clear();
  tickets.clear();
}

// --- Lanes: one slot per project -------------------------------------------

interface Pending {
  record: MergeRecord;
  resolve: (outcome: MergeOutcome) => void;
}

interface Lane {
  pending: Pending[];
  current: Pending | null;
  running: boolean;
  /** Ends the current hold's wait early (kickMergeQueue). */
  wake: (() => void) | null;
}

const lanes = new Map<string, Lane>();

function laneOf(projectCwd: string): Lane {
  const key = pathKey(projectCwd);
  let lane = lanes.get(key);
  if (!lane) {
    lane = { pending: [], current: null, running: false, wake: null };
    lanes.set(key, lane);
  }
  return lane;
}

/**
 * Queue a merge. Returns at once; the entry runs when the entries ahead of
 * it in its project are done. The factory store's items for `featureIds` are
 * set `done` when it merges and `parked` when it parks.
 */
export function enqueueMerge(entry: MergeEntry): MergeTicket {
  // Idempotent per (project, branch): the engine may hand the same unit over
  // twice (a crash between its enqueue and recording the handoff). An entry
  // already queued, running, merged or parked answers with its own ticket;
  // a parked one runs again only through requeueMerge. Not for a Land: a
  // refused Land is parked and the user lands again once it is fixed (a
  // second Land while one is under way is refused by its callers).
  const existing = entry.kind === 'session-land' ? null : latestMergeFor(entry.projectCwd, entry.branch);
  if (existing) {
    const live = tickets.get(existing.id);
    if (live) return { ...live, position: positionOf(existing.id) };
    if (existing.status === 'merged' || existing.status === 'parked') return settledTicket(existing);
    // Queued or running in a server that has since restarted: nothing runs
    // it any more, so it goes back in the queue under its own row.
    updateMerge(existing.id, { status: 'queued', detail: null });
    return schedule(existing);
  }
  return schedule(insertMerge({ ...entry, featureIds: [...entry.featureIds] }));
}

/**
 * At boot: put back in the queue, under their own rows and in their order,
 * the entries the last server left queued, holding or running. A Land a
 * session or the board was told is "queued" would otherwise never happen;
 * its result goes out as the land notification, as it would have. Never on
 * an isolated boot (CLAUDE_REMOTE_CONFIG) or under vitest: their entries
 * would merge into the user's real repositories from code that hasn't landed.
 * Returns the ids it queued.
 */
export async function resumeMergeQueues(env: NodeJS.ProcessEnv = process.env): Promise<string[]> {
  if (env.CLAUDE_REMOTE_CONFIG || env.VITEST) return [];
  const resumed: string[] = [];
  for (const record of listUnfinishedMerges()) {
    if (tickets.has(record.id)) continue;
    // A server stopped while an item's worktree was mid-merge (the update, or
    // a resolver at work) leaves it there; the entry starts that over.
    if (record.kind === 'item' && record.status === 'running') await abortLeftMerge(record.worktreePath);
    updateMerge(record.id, { status: 'queued', detail: null });
    const ticket = schedule({ ...record, status: 'queued', detail: null });
    resumed.push(record.id);
    if (record.kind === 'session-land') {
      const track = record.trackName ?? record.branch;
      void ticket.done.then((outcome) =>
        deps.notifyLand({
          kind: 'land',
          projectCwd: record.projectCwd,
          track,
          ok: outcome.status === 'merged',
          detail: outcome.status === 'merged' ? outcome.detail : `Landing "${track}" failed: ${outcome.detail}`,
          timestamp: new Date().toISOString(),
        })
      );
    }
  }
  if (resumed.length > 0) logger.info({ resumed }, 'merge queue: resumed entries left by the last server');
  return resumed;
}

async function abortLeftMerge(worktreePath: string): Promise<void> {
  if ((await git(worktreePath, ['rev-parse', '-q', '--verify', 'MERGE_HEAD'])) !== null) {
    await git(worktreePath, ['merge', '--abort']);
  }
}

/**
 * Run a parked entry again (after the user settled what parked it), under the
 * same row. Null when there is no such entry or it is not parked.
 */
export function requeueMerge(id: string): MergeTicket | null {
  const record = getMerge(id);
  if (!record || record.status !== 'parked') return null;
  tickets.delete(id);
  updateMerge(id, { status: 'queued', detail: null, conflict: null });
  return schedule({ ...record, status: 'queued', detail: null, conflict: null });
}

/** Tickets of entries this server has queued, by row id (enqueueMerge's idempotency). */
const tickets = new Map<string, MergeTicket>();

function schedule(record: MergeRecord): MergeTicket {
  const lane = laneOf(record.projectCwd);
  const position = lane.pending.length + (lane.current ? 1 : 0);
  let resolve!: (outcome: MergeOutcome) => void;
  const done = new Promise<MergeOutcome>((r) => (resolve = r));
  lane.pending.push({ record, resolve });
  const ticket = { id: record.id, position, done };
  tickets.set(record.id, ticket);
  logger.info({ id: record.id, cwd: record.projectCwd, kind: record.kind, branch: record.branch, position }, 'merge queued');
  void drain(lane);
  return ticket;
}

/** Entries ahead of `id` in its lane now; 0 once it runs or has finished. */
function positionOf(id: string): number {
  for (const lane of lanes.values()) {
    if (lane.current?.record.id === id) return 0;
    const at = lane.pending.findIndex((p) => p.record.id === id);
    if (at !== -1) return at + (lane.current ? 1 : 0);
  }
  return 0;
}

/** A finished entry's ticket, rebuilt from its row. */
function settledTicket(r: MergeRecord): MergeTicket {
  const merged = r.status === 'merged';
  const detail = r.detail ?? (merged ? 'Merged' : 'Parked');
  return {
    id: r.id,
    position: 0,
    done: Promise.resolve({
      id: r.id,
      status: merged ? 'merged' : 'parked',
      mergeSha: r.mergeSha,
      detail,
      conflict: r.conflict,
      error: merged ? null : new TrackBranchError(detail, 409),
      land: null,
    }),
  };
}

/**
 * What the project's queue is doing, for a Land that has to say what it is
 * queued behind; null when its queue is empty.
 */
export function mergeQueueBusy(projectCwd: string): string | null {
  const lane = lanes.get(pathKey(projectCwd));
  if (!lane || (!lane.current && lane.pending.length === 0)) return null;
  const count = lane.pending.length + (lane.current ? 1 : 0);
  const now = lane.current ? ` (now: ${describe(lane.current.record)})` : '';
  return `${count} merge${count === 1 ? '' : 's'} in the merge queue${now}`;
}

export interface QueuedLand {
  /** What it waits behind when it was queued (mergeQueueBusy), or null when it runs now. */
  queuedBehind: string | null;
  /** Land's result once it merged; rejects with Land's refusal (its status kept) or the park. */
  result: Promise<LandResult & { build: BuildResult }>;
}

/**
 * A Land (the board's button, a session's POST /api/agent/land) as a queue
 * entry, so a merge in progress queues it instead of refusing it on the
 * project lock. Land's own rules all still run, in landTrack, at its turn.
 */
export function queueLand(project: RegistryProject, trackName: string): QueuedLand {
  const track = getActiveTrackBranch(project.cwd, trackName);
  if (!track) throw new TrackBranchError('This track has no branch to land', 404);
  // A second Land of the same track (a double click, a Land resumed at boot)
  // would only fail at its turn with "no branch to land", after the first.
  const lane = lanes.get(pathKey(project.cwd));
  const sameLand = (p: Pending | null) => p?.record.kind === 'session-land' && p.record.branch === track.branch;
  if (lane && (sameLand(lane.current) || lane.pending.some(sameLand))) {
    throw new TrackBranchError(`A Land of "${trackName}" is already in the merge queue; its result comes as a notification`, 409);
  }
  const queuedBehind = mergeQueueBusy(project.cwd);
  const ticket = enqueueMerge({
    projectCwd: project.cwd,
    kind: 'session-land',
    branch: track.branch,
    worktreePath: track.worktreePath,
    baseBranch: track.baseBranch,
    featureIds: [],
    trackName,
  });
  const result = ticket.done.then((outcome) => {
    if (outcome.status === 'merged' && outcome.land) return outcome.land;
    // A Land refusal keeps its own status; a park (conflict, red checks) is a 409.
    if (!outcome.conflict && (outcome.error instanceof TrackBranchError || outcome.error instanceof ProjectBusyError)) {
      throw outcome.error;
    }
    throw new TrackBranchError(outcome.detail, 409);
  });
  return { queuedBehind, result };
}

/** Re-check a holding entry now instead of at its next poll (the checkout was just cleaned). */
export function kickMergeQueue(projectCwd: string): void {
  lanes.get(pathKey(projectCwd))?.wake?.();
}

/** The project's entries still to run, the running one first. */
export function pendingMerges(projectCwd: string): MergeRecord[] {
  return listMerges(projectCwd, ['running', 'holding', 'queued']);
}

function describe(r: MergeRecord): string {
  if (r.kind === 'item') return `${r.branch} into ${r.baseBranch}`;
  return `${r.kind === 'session-land' ? 'Land of' : 'track'} "${r.trackName ?? r.branch}"`;
}

async function drain(lane: Lane): Promise<void> {
  if (lane.running) return;
  lane.running = true;
  try {
    for (let next = lane.pending.shift(); next; next = lane.pending.shift()) {
      lane.current = next;
      let outcome: MergeOutcome;
      try {
        outcome = await processEntry(lane, next.record);
      } catch (error) {
        // processEntry catches the entry's own failures; what reaches here is
        // its bookkeeping failing (the database). Never let it escape: `drain`
        // runs unawaited, and an unhandled rejection shuts the server down.
        logger.error({ id: next.record.id, error: (error as Error).message }, 'merge queue: entry bookkeeping failed');
        const detail = `The merge queue could not record this entry: ${(error as Error).message}`;
        outcome = { id: next.record.id, status: 'parked', mergeSha: null, detail, conflict: null, error: error as Error, land: null };
      }
      lane.current = null;
      // Only unfinished entries need a live ticket; a finished one answers from its row.
      tickets.delete(next.record.id);
      next.resolve(outcome);
    }
  } finally {
    lane.current = null;
    lane.running = false;
  }
}

function sleep(lane: Lane, ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      lane.wake = null;
      resolve();
    }, ms);
    lane.wake = () => {
      clearTimeout(timer);
      lane.wake = null;
      resolve();
    };
  });
}

// --- One entry ---------------------------------------------------------------

/** Stops an entry for the user. `conflict` names both sides when a conflict stopped it. */
class ParkError extends Error {
  constructor(
    message: string,
    readonly conflict: ParkedConflict | null = null,
    readonly original: Error | null = null
  ) {
    super(message);
    this.name = 'ParkError';
  }
}

interface Done {
  mergeSha: string | null;
  detail: string;
  land: (LandResult & { build: BuildResult }) | null;
}

async function processEntry(lane: Lane, record: MergeRecord): Promise<MergeOutcome> {
  updateMerge(record.id, { status: 'running', detail: null });
  try {
    const done =
      record.kind === 'item' ? await mergeItem(lane, record) : await mergeTrack(lane, record);
    updateMerge(record.id, { status: 'merged', detail: done.detail, mergeSha: done.mergeSha });
    setItems(record, 'done');
    logger.info({ id: record.id, kind: record.kind, mergeSha: done.mergeSha }, 'merge queue: merged');
    return { id: record.id, status: 'merged', mergeSha: done.mergeSha, detail: done.detail, conflict: null, error: null, land: done.land };
  } catch (error) {
    const park = error instanceof ParkError ? error : null;
    const detail = (error as Error).message || String(error);
    const conflict = park?.conflict ?? null;
    updateMerge(record.id, { status: 'parked', detail, conflict });
    setItems(record, 'parked');
    logger.warn({ id: record.id, kind: record.kind, detail }, 'merge queue: parked');
    return {
      id: record.id,
      status: 'parked',
      mergeSha: null,
      detail,
      conflict,
      error: park ? (park.original ?? park) : (error as Error),
      land: null,
    };
  }
}

/** The factory store's items for the entry's features, where the store has them. */
function setItems(record: MergeRecord, status: 'done' | 'parked'): void {
  for (const featureId of record.featureIds) {
    try {
      if (getItem(record.projectCwd, featureId)) updateItem(record.projectCwd, featureId, { status });
    } catch (error) {
      logger.warn({ featureId, error: (error as Error).message }, 'merge queue: could not update the item');
    }
  }
}

function setHolding(record: MergeRecord, reason: string): void {
  updateMerge(record.id, { status: 'holding', detail: reason });
}

/**
 * Wait until the checkout the merge goes into is clean: no uncommitted code,
 * nothing staged, the base checked out. Planning files (backlog edits on
 * main) and the session log don't hold it, as they don't refuse Land.
 */
async function holdUntilClear(lane: Lane, record: MergeRecord, cwd: string, base: string, docRel: string): Promise<void> {
  let held = false;
  for (;;) {
    const reason = await holdReason(cwd, base, docRel);
    if (reason === null) break;
    if (!held) logger.info({ id: record.id, reason }, 'merge queue: holding');
    held = true;
    setHolding(record, `Holding: ${reason}. It merges once that is clean.`);
    await sleep(lane, deps.holdPollMs);
  }
  if (held) updateMerge(record.id, { status: 'running', detail: null });
}

export async function holdReason(cwd: string, base: string, docRel: string): Promise<string | null> {
  const off = await offBranch(cwd, base);
  if (off !== null) return `${cwd} has "${off}" checked out, not ${base}`;
  const entries = await gitStatusEntries(cwd, { allUntracked: true });
  if (entries === null) return `the repository state at ${cwd} could not be read`;
  const code = entries.filter((e) => !isPlanningPath(e.path, docRel) && !isSessionLogPath(e.path)).map((e) => e.path);
  if (code.length > 0) return `${cwd} has uncommitted changes (${nameFiles(code)})`;
  const staged = entries.filter((e) => !e.untracked && e.staged !== ' ').map((e) => e.path);
  if (staged.length > 0) return `${cwd} has staged files (${nameFiles(staged)})`;
  return null;
}

/** `fn` under the project lock, holding and retrying while something else has it. */
async function withLockRetry<T>(lane: Lane, record: MergeRecord, what: string, fn: () => Promise<T>): Promise<T> {
  for (;;) {
    try {
      return await withProjectLock(record.projectCwd, what, fn);
    } catch (error) {
      if (!(error instanceof ProjectBusyError)) throw error;
      setHolding(record, `Waiting: ${error.message}`);
      await sleep(lane, deps.busyRetryMs);
      updateMerge(record.id, { status: 'running', detail: null });
    }
  }
}

// --- item --------------------------------------------------------------------

async function mergeItem(lane: Lane, record: MergeRecord): Promise<Done> {
  const project = deps.project(record.projectCwd);
  const docRel = docRelOf(project);
  const base = record.baseBranch;
  // Where the base is checked out: a worktree can't check out a branch
  // another one holds, so a track branch merges in the track's worktree.
  const track = findActiveTrackBranchByName(record.projectCwd, base);
  const mergeCwd = track ? track.worktreePath : record.projectCwd;
  const title = itemTitle(project, record);

  for (let round = 1; ; round++) {
    await holdUntilClear(lane, record, mergeCwd, base, docRel);
    // The item's worktree is its own: no lock while it updates and verifies.
    const updated = await updateItemBranch(record, base);
    const verified = await deps.verify(record.worktreePath);
    if (!verified.ok) {
      throw new ParkError(`Verification failed in ${record.worktreePath}${updated.merged ? ` after merging ${base} in` : ''}: ${verified.detail}`);
    }

    const merged = await withLockRetry(lane, record, `merging ${record.branch}`, async () => {
      // Checked again under the lock: the user may have started editing.
      const reason = await holdReason(mergeCwd, base, docRel);
      if (reason !== null) return { retry: 'hold' as const };
      const baseNow = (await git(mergeCwd, ['rev-parse', base]))?.trim();
      if (baseNow !== updated.baseSha) return { retry: 'moved' as const };
      return { retry: null, ...(await mergeIntoBase(record, { mergeCwd, intoTrack: Boolean(track), docRel, title })) };
    });
    if (merged.retry === 'hold') continue;
    if (merged.retry === 'moved') {
      if (round >= deps.maxRounds) {
        throw new ParkError(`${base} moved ${round} times while ${record.branch} was being verified; nothing was merged`);
      }
      continue;
    }

    let detail = merged.detail;
    if (!track) {
      const build = await deps.build(record.projectCwd);
      if (build.ran) detail += ` — ${build.detail}`;
    }
    return { mergeSha: merged.mergeSha, detail, land: null };
  }
}

function itemTitle(project: RegistryProject, record: MergeRecord): string {
  let first: string | null = null;
  try {
    const plan = readProjectPlan(project);
    const id = record.featureIds[0];
    first = id ? (findFeature(plan.doc, id)?.feature.title ?? null) : null;
  } catch {
    // The title only names the merge; the trailers identify it.
  }
  const more = record.featureIds.length > 1 ? ` (+${record.featureIds.length - 1} more)` : '';
  return `${first ?? record.trackName ?? record.branch}${more}`;
}

/**
 * Merge the base into the item's branch, in its worktree. A conflict goes to
 * the resolver while the merge is in progress; anything it leaves aborts the
 * merge (the worktree is as it was) and parks with both sides named.
 */
async function updateItemBranch(record: MergeRecord, base: string): Promise<{ merged: boolean; baseSha: string }> {
  const wt = record.worktreePath;
  const dirty = await gitStatusEntries(wt, { allUntracked: true });
  if (dirty === null) throw new ParkError(`Could not read the item's worktree (${wt})`);
  if (dirty.length > 0) {
    throw new ParkError(`The item's worktree has uncommitted changes (${wt}): ${nameFiles(dirty.map((e) => e.path))}`);
  }
  const baseSha = (await git(wt, ['rev-parse', '--verify', `${base}^{commit}`]))?.trim();
  if (!baseSha) throw new ParkError(`Could not find the base branch "${base}"`);
  const ours = (await git(wt, ['rev-parse', 'HEAD']))?.trim();
  if (!ours) throw new ParkError(`Could not read the item branch's HEAD in ${wt}`);
  const behind = Number((await git(wt, ['rev-list', '--count', `HEAD..${baseSha}`]))?.trim());
  if (!Number.isInteger(behind)) throw new ParkError(`Could not compare ${record.branch} with ${base}`);
  if (behind === 0) return { merged: false, baseSha };

  await git(wt, [...COMMIT_IDENTITY, 'merge', '--no-ff', '--no-commit', baseSha]);
  if ((await git(wt, ['rev-parse', '-q', '--verify', 'MERGE_HEAD'])) === null) {
    throw new ParkError(`Could not merge ${base} into ${record.branch} in ${wt}`);
  }
  const paths = await unmergedPaths(wt);
  if (paths.length > 0) {
    const conflict: MergeConflict = {
      cwd: wt,
      paths,
      ours: { branch: record.branch, sha: ours },
      theirs: { branch: base, sha: baseSha },
    };
    try {
      await settleConflict(conflict, record);
    } catch (error) {
      await git(wt, ['merge', '--abort']);
      throw new ParkError(conflictMessage(conflict, (error as Error).message), parked(conflict));
    }
  }
  const committed = await git(wt, [
    ...COMMIT_IDENTITY,
    'commit',
    '-q',
    '--no-verify',
    '-m',
    `Merge ${base} into ${record.branch}`,
  ]);
  if (committed === null) {
    await git(wt, ['merge', '--abort']);
    throw new ParkError(`Could not commit the merge of ${base} into ${record.branch} in ${wt}`);
  }
  return { merged: true, baseSha };
}

/** The merge into the base, under the lock: trailers, sha, ticks, push. */
async function mergeIntoBase(
  record: MergeRecord,
  at: { mergeCwd: string; intoTrack: boolean; docRel: string; title: string }
): Promise<{ mergeSha: string; detail: string }> {
  const { mergeCwd, intoTrack, docRel, title } = at;
  // A track worktree's own uncommitted planning is committed first, as the
  // job merge stage does; holdReason has already ruled out code.
  if (intoTrack) await commitWorktreePlanning(mergeCwd, docRel, `chore: commit planning before merging "${title}"`);
  const merged = await git(mergeCwd, [
    ...COMMIT_IDENTITY,
    'merge',
    '--no-ff',
    record.branch,
    ...multiFeatureMergeMessageArgs(title, { jobId: record.id, featureIds: record.featureIds }),
  ]);
  if (merged === null) {
    await git(mergeCwd, ['merge', '--abort']);
    throw new ParkError(
      `Merging ${record.branch} into ${record.baseBranch} failed in ${mergeCwd} although it was up to date; nothing was merged`
    );
  }
  const mergeSha = (await git(mergeCwd, ['rev-parse', 'HEAD']))?.trim() ?? '';
  updateMerge(record.id, { mergeSha });
  const where = intoTrack ? `the track branch ${record.baseBranch}` : record.baseBranch;
  // Track branches are local and never pushed (as the job merge stage).
  const after = await tickAndPush(mergeCwd, docRel, record.featureIds, title, !intoTrack);
  return { mergeSha, detail: `Merged ${record.branch} into ${where}${after}` };
}

/**
 * After a merge has landed: tick its features, then push (main only, where
 * there is a remote). Never throws — the merge stands, so a failure here is
 * reported in the detail and logged, never turned into a park. The push goes
 * after the tick so the tick commit is published with the merge.
 */
async function tickAndPush(cwd: string, docRel: string, featureIds: string[], title: string, push: boolean): Promise<string> {
  let note = '';
  try {
    const ticked = await tickFeatures(cwd, docRel, featureIds, title);
    if (ticked.length > 0) note += `; ticked ${ticked.join(', ')}`;
  } catch (error) {
    logger.warn({ cwd, featureIds, error: (error as Error).message }, 'merge queue: ticking failed after the merge');
    note += `; could not tick ${featureIds.join(', ')} in ${docRel} (${(error as Error).message}): tick them by hand`;
  }
  if (push && (await hasRemote(cwd))) {
    note += (await git(cwd, ['push'])) !== null ? '; pushed' : '; the push failed — push by hand';
  }
  return note;
}

// --- track and session-land --------------------------------------------------

async function mergeTrack(lane: Lane, record: MergeRecord): Promise<Done> {
  const project = deps.project(record.projectCwd);
  const docRel = docRelOf(project);
  const track = trackOf(record);
  if (!track) throw new ParkError(`"${record.trackName ?? record.branch}" has no branch to land`, null, new TrackBranchError('This track has no branch to land', 404));
  const factoryRun = record.kind === 'track';

  for (let round = 1; ; round++) {
    // Land refuses on a dirty main by itself; only the factory's own track
    // waits for it instead, as an item does.
    if (factoryRun) await holdUntilClear(lane, record, record.projectCwd, track.baseBranch, docRel);

    // A session's Land merges as Land always has, unless the dry run says it
    // would conflict: then Update from main with the resolver first.
    const behind = factoryRun ? null : await behindMain(project, track);
    if (factoryRun || behind?.wouldConflict?.length) {
      // Land's own refusals first, so no resolver works for a Land that is
      // going to be refused anyway. They close nothing: landTrack runs them
      // again, and closes the worktree's sessions only after all of them.
      try {
        await withLockRetry(lane, record, `checking "${track.trackName}" before it lands`, () =>
          landPreflight(project, track.trackName)
        );
      } catch (error) {
        throw new ParkError((error as Error).message, null, error as Error);
      }
      const updated = await updateWithResolver(lane, record, project, track);
      if (factoryRun || updated) {
        const verified = await deps.verify(track.worktreePath);
        if (!verified.ok) {
          throw new ParkError(`Verification failed in the track's worktree (${track.worktreePath}): ${verified.detail}`);
        }
      }
    }

    let landed: LandResult & { build: BuildResult };
    try {
      landed = await withLandRetry(lane, record, project, track.trackName);
    } catch (error) {
      // The base moved between the update and the Land: update again.
      if (error instanceof TrackBranchError && /^Merging .* failed/.test(error.message) && round < deps.maxRounds) {
        continue;
      }
      throw new ParkError((error as Error).message, null, error as Error);
    }
    updateMerge(record.id, { mergeSha: landed.mergeSha });
    // The section is back on main now: the factory's features are ticked
    // there, and the tick pushed after Land's own push.
    const after =
      record.featureIds.length > 0
        ? await tickAndPush(record.projectCwd, docRel, record.featureIds, track.trackName, landed.pushed)
        : '';
    const detail = landed.detail + after;
    return { mergeSha: landed.mergeSha, detail, land: { ...landed, detail } };
  }
}

function trackOf(record: MergeRecord): TrackBranch | null {
  if (record.trackName) return getActiveTrackBranch(record.projectCwd, record.trackName);
  const found = trackBranchContaining(record.worktreePath);
  return found && found.landedAt === null ? found : null;
}

/**
 * Update from main with the resolver, holding the project lock only for the
 * fast-forward: the merge (and the resolver's minutes) happens in a scratch
 * checkout (prepareTrackUpdate), then the worktree is fast-forwarded onto it
 * under the lock, after Update's refusals. A branch that moved meanwhile is
 * merged again, a bounded number of times. True when it merged something
 * (the code to land changed).
 */
async function updateWithResolver(
  lane: Lane,
  record: MergeRecord,
  project: RegistryProject,
  track: TrackBranch
): Promise<boolean> {
  for (let round = 1; ; round++) {
    let conflict: MergeConflict | null = null;
    let prepared: PreparedUpdate | null;
    try {
      prepared = await prepareTrackUpdate(project, track.trackName, {
        resolve: async (c) => {
          conflict = c;
          await settleConflict(c, record);
        },
      });
    } catch (error) {
      const c = conflict as MergeConflict | null;
      // The scratch checkout is gone; the track's own worktree was never touched.
      if (c) throw new ParkError(conflictMessage({ ...c, cwd: track.worktreePath }, (error as Error).message), parked(c), error as Error);
      throw new ParkError((error as Error).message, null, error as Error);
    }
    if (!prepared) return false;
    const ready = prepared;
    let applied: Awaited<ReturnType<typeof applyPreparedUpdate>>;
    try {
      applied = await withLockRetry(lane, record, `updating "${track.trackName}" before it lands`, () =>
        applyPreparedUpdate(project, track.trackName, ready)
      );
    } catch (error) {
      throw new ParkError((error as Error).message, null, error as Error);
    }
    if (applied !== 'moved') return true;
    if (round >= deps.maxRounds) {
      throw new ParkError(`${track.branch} kept moving while ${track.baseBranch} was merged into it; nothing was landed`);
    }
  }
}

/** Land, retrying while the project lock is busy (Land takes it itself). */
async function withLandRetry(
  lane: Lane,
  record: MergeRecord,
  project: RegistryProject,
  trackName: string
): Promise<LandResult & { build: BuildResult }> {
  for (;;) {
    try {
      return await deps.land(project, trackName);
    } catch (error) {
      if (!(error instanceof ProjectBusyError)) throw error;
      setHolding(record, `Waiting: ${error.message}`);
      await sleep(lane, deps.busyRetryMs);
      updateMerge(record.id, { status: 'running', detail: null });
    }
  }
}

// --- Conflicts -----------------------------------------------------------------

const MARKER = /^(<{7}|>{7})( |$)|^={7}$/m;

/** Whether a file still holds a conflict marker line. */
export function hasConflictMarkers(text: string): boolean {
  return MARKER.test(text);
}

/**
 * Hand an in-progress merge's conflicts to the resolver, then check its work:
 * every path must be free of markers, and is then staged (or removed, when
 * the resolver deleted it). Throws naming what is left.
 */
async function settleConflict(conflict: MergeConflict, record: MergeRecord): Promise<void> {
  updateMerge(record.id, { detail: `Resolving conflicts in ${nameFiles(conflict.paths)}` });
  await deps.resolve(conflict, { projectCwd: record.projectCwd, entryId: record.id });
  const left: string[] = [];
  for (const path of conflict.paths) {
    const abs = join(conflict.cwd, path);
    if (existsSync(abs)) {
      if (hasConflictMarkers(readFileSync(abs, 'utf-8'))) {
        left.push(path);
        continue;
      }
      if ((await git(conflict.cwd, ['add', '--', path])) === null) left.push(path);
    } else if ((await git(conflict.cwd, ['rm', '-q', '--cached', '--', path])) === null) {
      left.push(path);
    }
  }
  if (left.length > 0) throw new Error(`the resolver left conflicts in ${nameFiles(left)}`);
  const still = await unmergedPaths(conflict.cwd);
  if (still.length > 0) throw new Error(`still unmerged: ${nameFiles(still)}`);
}

function parked(c: MergeConflict): ParkedConflict {
  return { paths: c.paths, ours: c.ours, theirs: c.theirs };
}

function conflictMessage(c: MergeConflict, why: string): string {
  return (
    `Merging ${c.theirs.branch} (${c.theirs.sha.slice(0, 7)}) into ${c.ours.branch} (${c.ours.sha.slice(0, 7)}) ` +
    `conflicts in ${nameFiles(c.paths)}, and it could not be resolved: ${why}. ` +
    `Nothing was merged; ${c.cwd} is as it was. Make those files agree on either side, then queue it again.`
  );
}

async function unmergedPaths(cwd: string): Promise<string[]> {
  const out = await git(cwd, ['diff', '--name-only', '--diff-filter=U']);
  return [...new Set((out ?? '').split('\n').map((l) => l.trim()).filter(Boolean))];
}

/** The default resolver: a headless run allowed to edit only the conflicting files. */
async function resolveWithAgent(conflict: MergeConflict, ctx: { projectCwd: string; entryId: string }): Promise<void> {
  const prompt = `A git merge in this checkout stopped on conflicts. Resolve them.

Merging: ${conflict.theirs.branch} (${conflict.theirs.sha}) — "theirs"
Into: ${conflict.ours.branch} (${conflict.ours.sha}) — "ours", checked out here

Conflicting files:
${conflict.paths.map((p) => `- ${p}`).join('\n')}

HOW TO WORK
1. Read each file. Between <<<<<<< and ======= is ours, between ======= and >>>>>>> is theirs.
2. Keep the intent of BOTH sides: combine them so each side's change still works.
   Read the surrounding code (and its callers) to understand what each side meant.
3. Edit each file so no conflict marker line is left. Delete a file only if both
   sides' intent is that it goes.

RULES
- Edit only the files listed above. Do not run git; the merge is committed for you.
- If the two sides cannot be reconciled without a decision you can't make,
  leave the markers in place and say why.
- End with one final line: "RESOLVED" or "UNRESOLVED: <reason>".`;
  const result = await runClaude(conflict.cwd, prompt, conflict.paths, {
    allowedTools: ['Read', 'Glob', 'Grep', 'Edit', 'Write'],
    timeoutMs: getConfig().jobs.stageTimeoutMs,
    failOnDenial: false,
    // Factory work, told apart from the engine's own runs by its stage.
    tag: { projectCwd: ctx.projectCwd, kind: 'factory', jobId: ctx.entryId, stage: 'merge-resolve' },
    // Its own lane: a resolver must not wait behind the project's other runs
    // while its entry holds the merge slot (and, for a track, the lock).
    laneKey: `merge:${pathKey(ctx.projectCwd)}`,
  });
  const verdict = result.result.match(/(UNRESOLVED:?.*|RESOLVED)\s*$/);
  if (!verdict || verdict[1].startsWith('UNRESOLVED')) {
    throw new Error(verdict ? verdict[1].replace(/^UNRESOLVED:?\s*/, '') || 'unresolved' : 'the resolver gave no verdict');
  }
}

// --- Verification ----------------------------------------------------------------

/**
 * The project's declared commands (QA.md's and PROJECT.md's `verify:`), as
 * the QA stage runs them. Only commands: the QA flows need an agent and a
 * driver and stay with the factory's own verify step. Nothing declared is
 * not a failure — there is nothing red to merge.
 */
async function verifyDeclaredChecks(cwd: string): Promise<VerifyResult> {
  const qa = readQaDoc(cwd);
  const verify = readProjectDoc({ cwd }).doc.frontmatter.verify;
  const commands = [...new Set([...(qa?.commands ?? []), ...verify])];
  if (commands.length === 0) return { ok: true, detail: 'no verify commands declared' };
  for (const command of commands) {
    const check = await runCommand(cwd, command);
    if (check.status !== 'passed') return { ok: false, detail: `${command}: ${check.detail ?? check.status}` };
  }
  return { ok: true, detail: `${commands.length} command${commands.length === 1 ? '' : 's'} passed` };
}

// --- Ticking the plan --------------------------------------------------------------

/**
 * Mark features done in the plan doc at `cwd` (main's, or a track worktree's):
 * one commit through a temporary index (commitOnHead), so whatever the user
 * has staged stays staged and out of it; the working copy gets the same ticks
 * and keeps its own edits. Returns the ids it ticked.
 */
export async function tickFeatures(cwd: string, docRel: string, featureIds: string[], title: string): Promise<string[]> {
  const headText = await git(cwd, ['show', `HEAD:${docRel}`]);
  if (headText === null || featureIds.length === 0) return [];
  const tick = (text: string): { text: string; ids: string[] } => {
    const doc = parseProjectDoc(text);
    const ids: string[] = [];
    for (const id of featureIds) {
      const found = findFeature(doc, id);
      if (!found || found.feature.status === 'done') continue;
      updateFeature(doc, id, { status: 'done' });
      ids.push(id);
    }
    return { text: ids.length > 0 ? renderProjectDoc(doc) : text, ids };
  };
  const head = tick(headText);
  if (head.ids.length === 0) return [];
  await commitOnHead(cwd, [{ path: docRel, content: head.text }], `chore: mark "${title}" done`);

  const abs = join(cwd, docRel);
  const working = existsSync(abs) ? readFileSync(abs, 'utf-8') : null;
  const next = working === null || working === headText ? head.text : tick(working).text;
  if (next !== working) {
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, next, 'utf-8');
  }
  invalidateProjectCache();
  return head.ids;
}
