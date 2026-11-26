import { basename } from 'path';
import { getDatabase } from '../db/schema.js';
import { createLogger } from '../utils/logger.js';
import { pathKey } from '../utils/paths.js';
import { loadRegistry, type RegistryProject } from '../projects/registry.js';
import { readProjectPlan } from '../projects/project-plan.js';
import { allFeatures } from '../projects/project-doc-format.js';
import type {
  FactoryBoard,
  FactoryBoardUnit,
  FactoryColumn,
  FactoryCounts,
  FactoryDispatchState,
  FactoryFeatureProgress,
  FactoryMergeSummary,
  FactoryQuestion,
  FactoryReport,
  FactorySummary,
  FactoryUnitClaim,
  FactoryUnitDetail,
  FactoryUnitStatus,
  FactoryUnitSummary,
} from '../../shared/protocol.js';
import { getItem, listDependencies, listItems } from './store.js';
import { sessionLiveness, sessionOfOwner } from './session-claims.js';
import { getRunState, unitIdFor, type RunState } from './run-state.js';
import { listMerges, type MergeRecord, type MergeStatus } from './merge-queue-store.js';
import { isTrackWorkflow } from './templates.js';
import { DEFAULT_FACTORY_LIMITS, type FactoryLimits } from './limits.js';
import { unitJobId, unitTokens } from './deps.js';
import { LEASE_RENEW_MS, type FactoryItem } from './types.js';
import type { DispatchStatus } from './dispatcher.js';

const logger = createLogger('factory-board');

/**
 * The factory's read model (project/code-factory.md, "Factory overlay … board view"):
 * every unit of work by board column, built from the store — items, run state,
 * merge entries and the usage ledger — and never by parsing every PROJECT.md on
 * each event. Feature titles come from a per-project cache (`planTitles`).
 *
 * The same builder feeds the pushed `factory.summary` (compact cards) and
 * GET /api/factory/board (cards plus each drawer's detail).
 */

export type { FactoryBoard, FactorySummary, FactoryUnitSummary, FactoryReport };

/** A claimed run whose heartbeat is older than this looks dead (it renews every LEASE_RENEW_MS). */
export const STALE_HEARTBEAT_MS = 2 * LEASE_RENEW_MS;
/** A ready item nobody claimed for this long, while a seat is free, is a stall (the spec's alert). */
export const READY_STALL_MS = 30 * 60_000;

const MAX_REASON = 200;

/** The tokens the runaway guard counts: input, output and cache writes (deps.ts `unitTokens`). */
const TOKEN_SUM = 'input_tokens + output_tokens + cache_write_5m_tokens + cache_write_1h_tokens';

export interface BoardOptions {
  /** One project; every project when omitted. */
  projectCwd?: string;
  now?: number;
  /** Start of "today": what the done column and tokensToday count from. Server-local midnight by default. */
  since?: string;
  dispatch?: DispatchStatus | null;
  limits?: FactoryLimits;
}

export function startOfToday(now: number): string {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return d.toISOString();
}

// ---------------------------------------------------------------------------
// Names and titles

/** Display names as workspace.ts resolves them: the registry's override, else the folder name. */
function nameResolver(): (cwd: string) => string {
  let overrides: Map<string, string> | null = null;
  return (cwd) => {
    if (!overrides) {
      try {
        overrides = new Map(
          loadRegistry()
            .projects.filter((p) => p.name)
            .map((p) => [pathKey(p.cwd), p.name as string])
        );
      } catch {
        overrides = new Map();
      }
    }
    return overrides.get(pathKey(cwd)) || basename(cwd) || cwd;
  };
}

function registryProject(projectCwd: string): RegistryProject {
  try {
    const found = loadRegistry().projects.find((p) => pathKey(p.cwd) === pathKey(projectCwd));
    if (found) return found;
  } catch {
    // No registry: the folder alone addresses it.
  }
  return { cwd: projectCwd };
}

interface PlanTitles {
  /** Feature id → title, in plan order (Map keeps insertion order). */
  titles: Map<string, string>;
  readAt: number;
}

/** Re-read a project's plan at most this often while it stays whole. */
const TITLES_TTL_MS = 5 * 60_000;
/** And at most this often while an item's title is missing (intake just filed it). */
const TITLES_MISS_MS = 10_000;

const titleCache = new Map<string, PlanTitles>();

/**
 * Feature titles of a project's plan (main and every track worktree's copy),
 * read through a cache: the feed is rebuilt on every factory write, and parsing
 * PROJECT.md each time is what the live-job-overlay design rules out. A read
 * happens when the cache is older than TITLES_TTL_MS, or when a wanted id is
 * missing and the last read is older than TITLES_MISS_MS.
 */
export function planTitles(projectCwd: string, wanted: string[], now: number): Map<string, string> {
  const key = pathKey(projectCwd);
  const cached = titleCache.get(key);
  const missing = cached ? wanted.some((id) => !cached.titles.has(id)) : true;
  const fresh = cached && now - cached.readAt < (missing ? TITLES_MISS_MS : TITLES_TTL_MS);
  if (cached && fresh) return cached.titles;
  let titles = new Map<string, string>();
  try {
    const doc = readProjectPlan(registryProject(projectCwd)).doc;
    titles = new Map(allFeatures(doc).map((f) => [f.id, f.title]));
  } catch (error) {
    logger.warn({ cwd: projectCwd, error: (error as Error).message }, 'factory board: could not read the plan');
    if (cached) titles = cached.titles;
  }
  titleCache.set(key, { titles, readAt: now });
  return titles;
}

/** Forget cached titles (tests; a plan rewritten from outside). */
export function clearPlanTitles(): void {
  titleCache.clear();
}

// ---------------------------------------------------------------------------
// Helpers

function truncate(text: string | null | undefined, max = MAX_REASON): string | null {
  if (!text) return null;
  const line = text.trim().split('\n')[0].trim();
  if (!line) return null;
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

function minutes(ms: number): string {
  const m = Math.max(1, Math.round(ms / 60_000));
  return m >= 120 ? `${Math.round(m / 60)}h` : `${m}m`;
}

const UNFINISHED: MergeStatus[] = ['queued', 'holding', 'running'];

/**
 * Factory runs and merge resolvers (`mq-…`), from the ledger, since an ISO time.
 * One project's are picked by job id — its units' `factory:<hash>:` prefix and its
 * merge entries' ids — never by `project_cwd`: runs execute in worktrees, so the
 * ledger records those folders, not the project's.
 */
function tokensSince(since: string, project?: { cwd: string; mergeIds: string[] }): { jobId: string; tokens: number }[] {
  try {
    const rows = getDatabase()
      .prepare(
        `SELECT job_id AS jobId, SUM(${TOKEN_SUM}) AS tokens FROM usage_messages
          WHERE (job_id LIKE 'factory:%' OR job_id LIKE 'mq-%') AND ts >= ?
          GROUP BY job_id ORDER BY tokens DESC`
      )
      .all(since) as { jobId: string; tokens: number }[];
    if (!project) return rows;
    const prefix = unitJobId(project.cwd, '');
    const merges = new Set(project.mergeIds);
    return rows.filter((r) => r.jobId.startsWith(prefix) || merges.has(r.jobId));
  } catch {
    return [];
  }
}

/** Items that reached done since an ISO time; filtered in SQL, as done items only accumulate. */
function doneSince(since: string, projectCwd?: string): FactoryItem[] {
  const key = projectCwd === undefined ? null : pathKey(projectCwd);
  const rows = getDatabase()
    .prepare(
      `SELECT project_cwd, feature_id FROM factory_items
        WHERE status = 'done' AND updated_at >= ? AND (? IS NULL OR project_key = ?)
        ORDER BY created_at, rowid`
    )
    .all(since, key, key) as { project_cwd: string; feature_id: string }[];
  return rows.map((r) => getItem(r.project_cwd, r.feature_id)).filter((i): i is FactoryItem => i !== null);
}

/** Shaping questions, from the unit's notes: a JSON array (or one object) of {question, options, default}. */
export function parseQuestions(raw: string | undefined): FactoryQuestion[] {
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  const list = Array.isArray(parsed) ? parsed : [parsed];
  const out: FactoryQuestion[] = [];
  list.forEach((q, i) => {
    if (!q || typeof q !== 'object') return;
    const r = q as Record<string, unknown>;
    const text = typeof r.question === 'string' ? r.question : typeof r.text === 'string' ? r.text : null;
    if (!text) return;
    const options = Array.isArray(r.options) ? r.options.filter((o): o is string => typeof o === 'string') : [];
    out.push({
      id: typeof r.id === 'string' ? r.id : `q${i + 1}`,
      question: text,
      options,
      default: typeof r.default === 'string' ? r.default : null,
    });
  });
  return out;
}

function mergeTitle(r: MergeRecord, titles: Map<string, string>): string {
  if (r.trackName) return r.trackName;
  const first = r.featureIds[0];
  return (first && titles.get(first)) || first || r.branch;
}

function toMergeSummary(r: MergeRecord, projectName: string, titles: Map<string, string>): FactoryMergeSummary {
  return {
    id: r.id,
    projectCwd: r.projectCwd,
    projectName,
    kind: r.kind,
    title: mergeTitle(r, titles),
    branch: r.branch,
    featureIds: [...r.featureIds],
    status: r.status,
    detail: truncate(r.detail, 400),
    conflictPaths: r.conflict?.paths ?? [],
    mergeSha: r.mergeSha,
    updatedAt: r.updatedAt,
  };
}

/** Projects with merge entries worth showing: unfinished, parked, or merged since `since`. */
function mergeProjects(since: string): string[] {
  try {
    const rows = getDatabase()
      .prepare(
        `SELECT DISTINCT project_cwd FROM factory_merges
          WHERE status IN ('queued', 'holding', 'running', 'parked') OR updated_at >= ?`
      )
      .all(since) as { project_cwd: string }[];
    return rows.map((r) => r.project_cwd);
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Units

interface UnitGroup {
  projectCwd: string;
  unitId: string;
  isTrack: boolean;
  items: FactoryItem[];
}

function groupUnits(items: FactoryItem[]): UnitGroup[] {
  const groups = new Map<string, UnitGroup>();
  for (const item of items) {
    const isTrack = isTrackWorkflow(item.workflow);
    const unitId = unitIdFor(item, isTrack);
    const key = `${pathKey(item.projectCwd)}\n${unitId}`;
    let g = groups.get(key);
    if (!g) {
      g = { projectCwd: item.projectCwd, unitId, isTrack, items: [] };
      groups.set(key, g);
    }
    g.items.push(item);
  }
  return [...groups.values()];
}

function unitStatus(items: FactoryItem[]): FactoryUnitStatus {
  if (items.some((i) => i.status === 'parked')) return 'parked';
  if (items.some((i) => i.status === 'in_progress')) return 'in_progress';
  if (items.every((i) => i.status === 'done')) return 'done';
  return 'open';
}

interface Seats {
  total: number;
  perProject: Map<string, number>;
}

/** Seats held now, by distinct run claim owner (a track's items share one). */
function seatsHeld(items: FactoryItem[]): Seats {
  const owners = new Map<string, string>();
  for (const i of items) {
    if (i.status === 'in_progress' && i.claimKind === 'run' && i.claimOwner) owners.set(i.claimOwner, pathKey(i.projectCwd));
  }
  const perProject = new Map<string, number>();
  for (const pk of owners.values()) perProject.set(pk, (perProject.get(pk) ?? 0) + 1);
  return { total: owners.size, perProject };
}

interface BuildContext {
  now: number;
  since: string;
  limits: FactoryLimits;
  seats: Seats;
  dispatch: DispatchStatus | null;
  nameOf: (cwd: string) => string;
  /** Per project: feature ids of open items still blocking, by the waiting feature. */
  blockers: Map<string, Map<string, string[]>>;
  merges: Map<string, MergeRecord[]>;
}

function blockersOf(projectCwd: string, open: Set<string>): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const d of listDependencies(projectCwd)) {
    if (d.type !== 'blocks' || !open.has(d.toFeature)) continue;
    const list = out.get(d.fromFeature) ?? [];
    list.push(d.toFeature);
    out.set(d.fromFeature, list);
  }
  return out;
}

/** The unit's merge entry: the newest for its branch, else the newest naming one of its features. */
function mergeFor(records: MergeRecord[], state: RunState | null, featureIds: string[]): MergeRecord | null {
  const own = records.filter((r) => r.kind !== 'session-land');
  const byBranch = state?.branch ? own.filter((r) => r.branch === state.branch) : [];
  const pool = byBranch.length > 0 ? byBranch : own.filter((r) => r.featureIds.some((id) => featureIds.includes(id)));
  return pool.length > 0 ? pool[pool.length - 1] : null;
}

function columnOf(
  group: UnitGroup,
  status: FactoryUnitStatus,
  step: string | null,
  state: RunState | null,
  merge: MergeRecord | null,
  triage: boolean
): FactoryColumn {
  if (status === 'done') return 'done';
  const progress = state?.progress;
  const inMerge =
    !!state?.handedOffAt ||
    (merge !== null && UNFINISHED.includes(merge.status)) ||
    (merge?.status === 'parked' && status === 'parked' && !progress?.parked);
  if (inMerge) return 'merging';
  if (triage) return 'intake';
  if (step === 'shape') return 'intake';
  // A loose item nobody has shaped yet: shaping is its first step, so it is intake until then.
  const lead = group.items[0];
  if (!group.isTrack && lead.workflow === 'item') {
    const shaped = !!progress && ('shape' in progress.outcomes || progress.skipped.includes('shape') || progress.skip.includes('shape'));
    if (!shaped) return 'intake';
  }
  // Only while the review runs or waits for you: a released unit keeps `review` as its
  // item step until it is claimed again, and until then it is ready, not under review.
  if (step === 'review' && status !== 'open') return 'review';
  if (status === 'open') return 'ready';
  return 'running';
}

function trackFeatures(
  group: UnitGroup,
  titles: Map<string, string>,
  state: RunState | null,
  status: FactoryUnitStatus
): FactoryFeatureProgress[] {
  if (!group.isTrack) return [];
  const ids = new Set(group.items.map((i) => i.featureId));
  // Plan order where the plan has them; the rest after, in creation order.
  const ordered = [...titles.keys()].filter((id) => ids.has(id));
  for (const i of group.items) if (!ordered.includes(i.featureId)) ordered.push(i.featureId);
  const done = new Set(state?.progress.featuresDone ?? []);
  for (const i of group.items) if (i.status === 'done') done.add(i.featureId);
  const pending = state?.progress.notes['review-feature'];
  const current =
    status === 'in_progress' || status === 'parked' ? (pending && !done.has(pending) ? pending : ordered.find((id) => !done.has(id))) : undefined;
  return ordered.map((id) => ({
    id,
    title: titles.get(id) ?? id,
    state: done.has(id) ? 'done' : id === current ? 'now' : 'todo',
  }));
}

function stallOf(
  group: UnitGroup,
  column: FactoryColumn,
  status: FactoryUnitStatus,
  waitsFor: string[],
  state: RunState | null,
  ctx: BuildContext
): string | null {
  const { now } = ctx;
  if (status === 'in_progress') {
    const runs = group.items.filter((i) => i.status === 'in_progress' && i.claimKind === 'run');
    if (runs.length === 0) return null;
    const beat = Math.max(...runs.map((i) => (i.heartbeatAt ? Date.parse(i.heartbeatAt) : 0)));
    if (now - beat > STALE_HEARTBEAT_MS) return beat ? `no heartbeat for ${minutes(now - beat)}` : 'claimed with no heartbeat';
    return null;
  }
  if (status !== 'open' || column !== 'ready' || waitsFor.length > 0 || state?.handedOffAt) return null;
  const since = Math.max(...group.items.map((i) => Date.parse(i.updatedAt)));
  if (now - since < READY_STALL_MS) return null;
  const pk = pathKey(group.projectCwd);
  const free = ctx.seats.total < ctx.limits.seats && (ctx.seats.perProject.get(pk) ?? 0) < ctx.limits.seatsPerProject;
  if (!free) return null;
  return `ready and unclaimed for ${minutes(now - since)} with a seat free`;
}

/** The terminal session holding the unit, and whether its terminal is open (session-claims.ts). */
function claimOf(items: FactoryItem[]): FactoryUnitClaim | null {
  for (const i of items) {
    const sessionId = i.claimKind === 'session' ? sessionOfOwner(i.claimOwner) : null;
    if (!sessionId) continue;
    const live = sessionLiveness();
    return { sessionId, sessionName: live.nameOf(sessionId), live: live.isRunning(sessionId) };
  }
  return null;
}

function buildUnit(group: UnitGroup, ctx: BuildContext): FactoryBoardUnit {
  const { projectCwd, unitId, isTrack, items } = group;
  const ids = items.map((i) => i.featureId);
  const titles = planTitles(projectCwd, ids, ctx.now);
  const state = getRunState(projectCwd, unitId);
  const status = unitStatus(items);
  const lead = items[0];
  const progress = state?.progress;
  const step = progress?.current ?? progress?.parked ?? lead.step ?? null;
  // The status is the store's truth; the step is what triage.ts also sets for the board.
  const triage = items.some((i) => i.status === 'triage' || i.step === 'triage');
  const merge = mergeFor(ctx.merges.get(pathKey(projectCwd)) ?? [], state, ids);
  const column = columnOf(group, status, step, state, merge, triage);
  const blockers = ctx.blockers.get(pathKey(projectCwd)) ?? new Map<string, string[]>();
  const waitsFor = [...new Set(ids.flatMap((id) => blockers.get(id) ?? []))].filter((id) => !ids.includes(id));
  const needsYou = status === 'parked' || triage;
  const escalated = !!state?.parkReason?.startsWith('review: escalated');
  const features = trackFeatures(group, titles, state, status);
  const stalled = stallOf(group, column, status, waitsFor, state, ctx);
  const mergeLive = column === 'merging' || column === 'done' ? merge : null;

  let reason: string | null = null;
  if (status === 'parked' && state?.parkReason) reason = truncate(state.parkReason);
  else if (mergeLive && mergeLive.status !== 'merged') reason = truncate(mergeLive.detail);
  if (!reason && waitsFor.length > 0) reason = `waits for ${waitsFor.join(', ')}`;
  if (!reason && triage) reason = 'filed by an agent: accept, backlog or dismiss';

  const updatedAt = [state?.updatedAt, ...items.map((i) => i.updatedAt)].filter((t): t is string => !!t).sort().pop() as string;
  const unit: FactoryUnitSummary = {
    key: `${pathKey(projectCwd)}|${unitId}`,
    projectCwd,
    projectName: ctx.nameOf(projectCwd),
    unitId,
    isTrack,
    trackName: lead.trackName,
    title: isTrack ? lead.trackName : (titles.get(lead.featureId) ?? lead.featureId),
    featureIds: features.length > 0 ? features.map((f) => f.id) : ids,
    column,
    status,
    step,
    needsYou,
    reviewer: column === 'review' ? (status === 'parked' ? 'you' : 'agent') : null,
    escalated,
    triage,
    reason,
    features,
    waitsFor,
    mergeId: mergeLive?.id ?? null,
    mergeStatus: mergeLive?.status ?? null,
    tokens: unitTokens(unitJobId(projectCwd, unitId)),
    modelTier: lead.modelTier,
    stalled,
    heartbeatAt: items.map((i) => i.heartbeatAt).filter((t): t is string => !!t).sort().pop() ?? null,
    updatedAt,
    claim: claimOf(items),
  };
  const detail: FactoryUnitDetail = {
    parkReason: state?.parkReason ?? null,
    verdict: progress?.notes.review ?? null,
    questions: parseQuestions(progress?.notes.questions ?? progress?.notes.question),
    hasSummary: !!progress?.notes.summary,
    worktreePath: state?.worktreePath ?? null,
    branch: state?.branch ?? null,
    baseBranch: state?.baseBranch ?? null,
    lastCommit: state?.lastCommit ?? null,
  };
  return { ...unit, detail };
}

/** Most urgent first: what waits for you, then running work, then the rest by column. */
const COLUMN_RANK: Record<FactoryColumn, number> = { review: 1, running: 2, intake: 3, ready: 4, merging: 5, done: 6 };

export function sortUnits<T extends FactoryUnitSummary>(units: T[]): T[] {
  return units.sort((a, b) => {
    const rank = (u: FactoryUnitSummary) => (u.needsYou ? 0 : COLUMN_RANK[u.column]);
    return rank(a) - rank(b) || b.updatedAt.localeCompare(a.updatedAt);
  });
}

export function countUnits(units: FactoryUnitSummary[]): FactoryCounts {
  const counts: FactoryCounts = { running: 0, reviewing: 0, needsYou: 0, merging: 0, done: 0 };
  for (const u of units) {
    if (u.column === 'done') counts.done++;
    else if (u.needsYou) counts.needsYou++;
    else if (u.column === 'merging') counts.merging++;
    else if (u.column === 'review') counts.reviewing++;
    else counts.running++;
  }
  return counts;
}

function dispatchState(dispatch: DispatchStatus | null, limits: FactoryLimits): FactoryDispatchState {
  return {
    started: dispatch !== null,
    paused: dispatch?.paused ?? null,
    capped: { ...(dispatch?.capped ?? {}) },
    seats: limits.seats,
    running: dispatch?.running ?? 0,
  };
}

function build(opts: BoardOptions, withDetail: boolean): FactoryBoard {
  const now = opts.now ?? Date.now();
  const since = opts.since ?? startOfToday(now);
  const limits = opts.limits ?? DEFAULT_FACTORY_LIMITS;
  const filter = opts.projectCwd !== undefined ? { projectCwd: opts.projectCwd } : {};

  // `triage`: discovered work waiting to be accepted (triage.ts), shown in intake.
  const live = listItems({ ...filter, status: ['open', 'in_progress', 'parked', 'triage'] });
  const doneToday = doneSince(since, opts.projectCwd);
  const items = [...live, ...doneToday];
  const allLive = opts.projectCwd !== undefined ? listItems({ status: ['in_progress'] }) : live;

  const nameOf = nameResolver();
  const projects = new Map<string, string>();
  for (const i of items) projects.set(pathKey(i.projectCwd), i.projectCwd);
  for (const cwd of mergeProjects(since)) {
    if (opts.projectCwd === undefined || pathKey(cwd) === pathKey(opts.projectCwd)) projects.set(pathKey(cwd), cwd);
  }

  const blockers = new Map<string, Map<string, string[]>>();
  const merges = new Map<string, MergeRecord[]>();
  for (const [pk, cwd] of projects) {
    const open = new Set(live.filter((i) => pathKey(i.projectCwd) === pk).map((i) => i.featureId));
    blockers.set(pk, blockersOf(cwd, open));
    merges.set(pk, listMerges(cwd));
  }

  const ctx: BuildContext = {
    now,
    since,
    limits,
    seats: seatsHeld(allLive),
    dispatch: opts.dispatch ?? null,
    nameOf,
    blockers,
    merges,
  };

  const built = groupUnits(items).map((g) => buildUnit(g, ctx));
  // The pushed feed leaves the drawer detail out: it is the bulky part, and only the board reads it.
  const units = sortUnits(withDetail ? built : built.map(({ detail: _detail, ...unit }) => unit as FactoryBoardUnit));

  const mergeList: FactoryMergeSummary[] = [];
  for (const [pk, records] of merges) {
    const cwd = projects.get(pk) as string;
    const titles = planTitles(cwd, records.flatMap((r) => r.featureIds), now);
    for (const r of records) {
      const show = r.status !== 'merged' || r.updatedAt >= since;
      if (show) mergeList.push(toMergeSummary(r, nameOf(cwd), titles));
    }
  }
  mergeList.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));

  const scope = opts.projectCwd !== undefined ? { cwd: opts.projectCwd, mergeIds: mergeList.map((m) => m.id) } : undefined;
  const tokensToday = tokensSince(since, scope).reduce((sum, r) => sum + r.tokens, 0);

  return {
    units,
    merges: mergeList,
    counts: countUnits(units),
    dispatch: dispatchState(ctx.dispatch, limits),
    tokensToday,
    since,
  };
}

/** The pushed feed: compact cards, no drawer detail. */
export function buildFactorySummary(opts: BoardOptions = {}): FactorySummary {
  return build(opts, false) as FactorySummary;
}

/** GET /api/factory/board: the same cards, each with its drawer's detail. */
export function buildFactoryBoard(opts: BoardOptions = {}): FactoryBoard {
  return build(opts, true);
}

/**
 * The morning report: what landed since `since`, what looks stuck now, and the
 * tokens each unit (and merge resolver) spent since then, most first.
 */
export function buildFactoryReport(since: string, opts: Omit<BoardOptions, 'since'> = {}): FactoryReport {
  const now = opts.now ?? Date.now();
  const board = build({ ...opts, now, since }, false);
  const landed = board.merges.filter((m) => m.status === 'merged' && m.updatedAt >= since);

  // Every item the factory knows, so a unit that merged and left the live feed still has a name.
  const nameOf = nameResolver();
  const units = new Map<string, { projectName: string; title: string }>();
  for (const group of groupUnits(listItems(opts.projectCwd !== undefined ? { projectCwd: opts.projectCwd } : {}))) {
    const lead = group.items[0];
    const title = group.isTrack
      ? lead.trackName
      : (planTitles(group.projectCwd, [lead.featureId], now).get(lead.featureId) ?? lead.featureId);
    units.set(unitJobId(group.projectCwd, group.unitId), { projectName: nameOf(group.projectCwd), title });
  }
  const mergeNames = new Map(board.merges.map((m) => [m.id, { projectName: m.projectName, title: `merge: ${m.title}` }]));

  const scope = opts.projectCwd !== undefined ? { cwd: opts.projectCwd, mergeIds: [...mergeNames.keys()] } : undefined;
  const tokens = tokensSince(since, scope).map((row) => {
    const named = units.get(row.jobId) ?? mergeNames.get(row.jobId);
    return { projectName: named?.projectName ?? '', title: named?.title ?? row.jobId, tokens: row.tokens };
  });
  return {
    since,
    landed,
    stalls: board.units.filter((u) => u.stalled),
    tokens,
    totalTokens: tokens.reduce((sum, t) => sum + t.tokens, 0),
  };
}
