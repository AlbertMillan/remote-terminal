import { getDatabase } from '../db/schema.js';
import { pathKey } from '../utils/paths.js';
import { factoryEvents } from './events.js';
import {
  CLOSED_STATUSES,
  DEFAULT_PRIORITY,
  DEPENDENCY_TYPES,
  LEASE_EXPIRY_MS,
  REVIEW_GRANULARITIES,
  type ClaimKind,
  type ClaimResult,
  type Claimant,
  type DependencyType,
  type FactoryDependency,
  type FactoryItem,
  type ItemStatus,
  type ReviewGranularity,
  type SettableItemStatus,
} from './types.js';

/**
 * Persistence for code factory items and their dependencies
 * (project/code-factory.md, "Item store").
 *
 * Beads-shaped, not beads: typed dependency edges, a ready queue computed as
 * "no open blocker, by priority", and an atomic claim with a lease that a run
 * keeps alive by heartbeat. The server is the only writer, so SQLite is enough.
 *
 * Items are keyed by project + PROJECT.md feature id. Nothing here generates or
 * rewrites an id: an item exists only for a feature that already has one.
 *
 * Every time-dependent call takes `now` (epoch ms) so leases can be tested
 * without waiting; callers in the server pass nothing.
 */

interface ItemRow {
  project_key: string;
  project_cwd: string;
  feature_id: string;
  track_name: string;
  workflow: string;
  step: string | null;
  status: string;
  priority: number;
  model_tier: string | null;
  review_granularity: string | null;
  claim_owner: string | null;
  claim_kind: string | null;
  lease_expires_at: string | null;
  heartbeat_at: string | null;
  created_at: string;
  updated_at: string;
}

interface DepRow {
  project_key: string;
  project_cwd: string;
  from_feature: string;
  to_feature: string;
  type: string;
  inferred: number;
  created_at: string;
}

function toItem(row: ItemRow): FactoryItem {
  return {
    projectCwd: row.project_cwd,
    featureId: row.feature_id,
    trackName: row.track_name,
    workflow: row.workflow,
    step: row.step,
    status: row.status as ItemStatus,
    priority: row.priority,
    modelTier: row.model_tier,
    reviewGranularity: isGranularity(row.review_granularity) ? row.review_granularity : null,
    claimOwner: row.claim_owner,
    claimKind: (row.claim_kind as ClaimKind | null) ?? null,
    leaseExpiresAt: row.lease_expires_at,
    heartbeatAt: row.heartbeat_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toDependency(row: DepRow): FactoryDependency {
  return {
    projectCwd: row.project_cwd,
    fromFeature: row.from_feature,
    toFeature: row.to_feature,
    type: row.type as DependencyType,
    inferred: row.inferred === 1,
    createdAt: row.created_at,
  };
}

export class FactoryStoreError extends Error {}

// What PROJECT.md ids look like (project-doc-format.ts: "f-" + base36). Checked so
// a title or a path passed by mistake is refused rather than stored as an id.
const FEATURE_ID = /^f-[a-z0-9]+$/;

function checkFeatureId(id: string): void {
  if (!FEATURE_ID.test(id)) throw new FactoryStoreError(`Not a feature id: ${JSON.stringify(id)}`);
}

// Priorities order the ready queue, so a NaN or fractional one would sort it wrongly.
function checkPriority(priority: number): void {
  if (!Number.isInteger(priority) || priority < 1) {
    throw new FactoryStoreError(`Not a priority: ${JSON.stringify(priority)}`);
  }
}

const SETTABLE_STATUSES: readonly string[] = ['open', 'parked', 'done', 'cancelled', 'triage'] satisfies SettableItemStatus[];

const iso = (ms: number) => new Date(ms).toISOString();

const CLOSED_SQL = CLOSED_STATUSES.map((s) => `'${s}'`).join(', ');

/**
 * Every item that has an open blocker, as (project_key, feature_id).
 *
 * Direct: a `blocks` edge to an item not yet closed. Inherited: a child of a
 * blocked parent that is itself still open (`parent-child`, followed down any
 * depth); a done or cancelled parent passes nothing on, or its children would
 * wait on a blocker their closed parent no longer cares about. `UNION`, not
 * `UNION ALL`, so the recursion stops on a row it has already produced.
 * `discovered-from` never appears: it is provenance, not ordering.
 */
const BLOCKED_CTE = `
  blocked(project_key, feature_id) AS (
    SELECT d.project_key, d.from_feature
      FROM factory_deps d
      JOIN factory_items b ON b.project_key = d.project_key AND b.feature_id = d.to_feature
     WHERE d.type = 'blocks' AND b.status NOT IN (${CLOSED_SQL})
    UNION
    SELECT d.project_key, d.from_feature
      FROM factory_deps d
      JOIN blocked p ON p.project_key = d.project_key AND p.feature_id = d.to_feature
      JOIN factory_items pi ON pi.project_key = p.project_key AND pi.feature_id = p.feature_id
     WHERE d.type = 'parent-child' AND pi.status NOT IN (${CLOSED_SQL})
  )`;

function isBlocked(projectKey: string, featureId: string): boolean {
  return !!getDatabase()
    .prepare(
      `WITH RECURSIVE ${BLOCKED_CTE}
       SELECT 1 FROM blocked WHERE project_key = ? AND feature_id = ? LIMIT 1`
    )
    .get(projectKey, featureId);
}

function getRow(projectKey: string, featureId: string): ItemRow | undefined {
  return getDatabase()
    .prepare('SELECT * FROM factory_items WHERE project_key = ? AND feature_id = ?')
    .get(projectKey, featureId) as ItemRow | undefined;
}

// ---------------------------------------------------------------------------
// Items

export interface CreateItemInput {
  projectCwd: string;
  featureId: string;
  trackName: string;
  workflow: string;
  step?: string | null;
  priority?: number;
  modelTier?: string | null;
  reviewGranularity?: ReviewGranularity | null;
  /** `triage` files discovered work that never runs until accepted; `open` otherwise. */
  status?: 'open' | 'triage';
}

function isGranularity(value: unknown): value is ReviewGranularity {
  return (REVIEW_GRANULARITIES as readonly unknown[]).includes(value);
}

function checkGranularity(value: unknown): void {
  if (value !== null && !isGranularity(value)) {
    throw new FactoryStoreError(`Not a review granularity: ${JSON.stringify(value)}`);
  }
}

/** Add a feature to the factory as an `open` (or `triage`) item. Refuses one already there. */
export function createItem(input: CreateItemInput, now = Date.now()): FactoryItem {
  checkFeatureId(input.featureId);
  if (input.priority !== undefined) checkPriority(input.priority);
  if (input.reviewGranularity !== undefined) checkGranularity(input.reviewGranularity);
  const key = pathKey(input.projectCwd);
  if (getRow(key, input.featureId)) {
    throw new FactoryStoreError(`${input.featureId} is already a factory item`);
  }
  const at = iso(now);
  getDatabase()
    .prepare(
      `INSERT INTO factory_items
         (project_key, project_cwd, feature_id, track_name, workflow, step, status,
          priority, model_tier, review_granularity, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      key,
      input.projectCwd,
      input.featureId,
      input.trackName,
      input.workflow,
      input.step ?? null,
      input.status === 'triage' ? 'triage' : 'open',
      input.priority ?? DEFAULT_PRIORITY,
      input.modelTier ?? null,
      input.reviewGranularity ?? null,
      at,
      at
    );
  factoryEvents.emitChange();
  return getItem(input.projectCwd, input.featureId) as FactoryItem;
}

export function getItem(projectCwd: string, featureId: string): FactoryItem | null {
  const row = getRow(pathKey(projectCwd), featureId);
  return row ? toItem(row) : null;
}

export interface ListItemsFilter {
  /** One project; every project when omitted. */
  projectCwd?: string;
  status?: ItemStatus[];
}

/** Items in creation order. */
export function listItems(filter: ListItemsFilter = {}): FactoryItem[] {
  const where: string[] = [];
  const values: string[] = [];
  if (filter.projectCwd !== undefined) {
    where.push('project_key = ?');
    values.push(pathKey(filter.projectCwd));
  }
  if (filter.status) {
    if (filter.status.length === 0) return [];
    where.push(`status IN (${filter.status.map(() => '?').join(', ')})`);
    values.push(...filter.status);
  }
  const rows = getDatabase()
    .prepare(
      `SELECT * FROM factory_items ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
        ORDER BY created_at, rowid`
    )
    .all(...values) as ItemRow[];
  return rows.map(toItem);
}

export interface ItemPatch {
  trackName?: string;
  workflow?: string;
  step?: string | null;
  status?: SettableItemStatus;
  priority?: number;
  modelTier?: string | null;
  reviewGranularity?: ReviewGranularity | null;
}

const COLUMN_OF: Record<keyof ItemPatch, string> = {
  trackName: 'track_name',
  workflow: 'workflow',
  step: 'step',
  status: 'status',
  priority: 'priority',
  modelTier: 'model_tier',
  reviewGranularity: 'review_granularity',
};

/**
 * Patch an item. Only the provided fields change; `updated_at` always does.
 *
 * Setting a status clears the claim: `in_progress` is the only status a claim
 * belongs to, and it comes only from `claimItem()`. An item reaching `done`
 * also drops the inferred dependencies that waited on it, in the same
 * transaction, so no reader sees a finished blocker still holding work back.
 */
export function updateItem(
  projectCwd: string,
  featureId: string,
  patch: ItemPatch,
  now = Date.now()
): FactoryItem | null {
  const key = pathKey(projectCwd);
  // Only known fields, checked at runtime too: a route may forward a request
  // body, and an unknown key would otherwise build `undefined = ?`.
  const entries = (Object.keys(patch) as (keyof ItemPatch)[]).filter(
    (k) => Object.prototype.hasOwnProperty.call(COLUMN_OF, k) && patch[k] !== undefined
  );
  // `in_progress` without a claim would be neither ready nor reclaimable: stuck.
  if (patch.status !== undefined && !SETTABLE_STATUSES.includes(patch.status)) {
    throw new FactoryStoreError(`Cannot set status ${JSON.stringify(patch.status)}; in_progress comes from a claim`);
  }
  if (patch.priority !== undefined) checkPriority(patch.priority);
  if (patch.reviewGranularity !== undefined) checkGranularity(patch.reviewGranularity);
  const sets = entries.map((k) => `${COLUMN_OF[k]} = ?`);
  const values: (string | number | null)[] = entries.map((k) => patch[k] as string | number | null);
  if (patch.status !== undefined) {
    sets.push('claim_owner = NULL', 'claim_kind = NULL', 'lease_expires_at = NULL', 'heartbeat_at = NULL');
  }
  sets.push('updated_at = ?');
  values.push(iso(now));

  const db = getDatabase();
  db.transaction(() => {
    db.prepare(`UPDATE factory_items SET ${sets.join(', ')} WHERE project_key = ? AND feature_id = ?`).run(
      ...values,
      key,
      featureId
    );
    if (patch.status === 'done') {
      db.prepare(
        'DELETE FROM factory_deps WHERE project_key = ? AND to_feature = ? AND inferred = 1'
      ).run(key, featureId);
    }
  })();
  factoryEvents.emitChange();
  return getItem(projectCwd, featureId);
}

/** Remove an item and, by cascade, every dependency touching it. */
export function deleteItem(projectCwd: string, featureId: string): boolean {
  const info = getDatabase()
    .prepare('DELETE FROM factory_items WHERE project_key = ? AND feature_id = ?')
    .run(pathKey(projectCwd), featureId);
  if (info.changes > 0) factoryEvents.emitChange();
  return info.changes > 0;
}

// ---------------------------------------------------------------------------
// Dependencies

export interface AddDependencyInput {
  projectCwd: string;
  /** The item that waits. */
  fromFeature: string;
  /** The item it waits on (its blocker, its parent, or where it was discovered). */
  toFeature: string;
  type: DependencyType;
  inferred?: boolean;
}

/**
 * Add an edge between two existing items of one project.
 *
 * Adding an edge that exists is a no-op, except that a declared edge wins over
 * an inferred one: re-adding it as declared keeps it past its blocker's done.
 * A `blocks` or `parent-child` edge that would close a cycle is refused, since
 * every item on the cycle would wait forever.
 */
export function addDependency(input: AddDependencyInput, now = Date.now()): FactoryDependency {
  const { fromFeature, toFeature, type } = input;
  if (!DEPENDENCY_TYPES.includes(type)) throw new FactoryStoreError(`Unknown dependency type: ${type}`);
  if (fromFeature === toFeature) throw new FactoryStoreError(`${fromFeature} cannot depend on itself`);
  const key = pathKey(input.projectCwd);
  const db = getDatabase();

  db.transaction(() => {
    for (const id of [fromFeature, toFeature]) {
      if (!getRow(key, id)) throw new FactoryStoreError(`${id} is not a factory item`);
    }
    if (type !== 'discovered-from' && reaches(key, toFeature, fromFeature)) {
      throw new FactoryStoreError(`${fromFeature} → ${toFeature} would make a dependency cycle`);
    }
    db.prepare(
      `INSERT INTO factory_deps (project_key, from_feature, to_feature, type, inferred, created_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (project_key, from_feature, to_feature, type)
       DO UPDATE SET inferred = MIN(inferred, excluded.inferred)`
    ).run(key, fromFeature, toFeature, type, input.inferred ? 1 : 0, iso(now));
  })();

  factoryEvents.emitChange();
  return listDependencies(input.projectCwd).find(
    (d) => d.fromFeature === fromFeature && d.toFeature === toFeature && d.type === type
  ) as FactoryDependency;
}

/** Whether `start` already waits, through ordering edges, on `target`. */
function reaches(projectKey: string, start: string, target: string): boolean {
  return !!getDatabase()
    .prepare(
      `WITH RECURSIVE up(feature_id) AS (
         SELECT ?
         UNION
         SELECT d.to_feature FROM factory_deps d JOIN up ON d.from_feature = up.feature_id
          WHERE d.project_key = ? AND d.type IN ('blocks', 'parent-child')
       )
       SELECT 1 FROM up WHERE feature_id = ? LIMIT 1`
    )
    .get(start, projectKey, target);
}

/** Remove one edge; every type between the pair when `type` is omitted. */
export function removeDependency(
  projectCwd: string,
  fromFeature: string,
  toFeature: string,
  type?: DependencyType
): number {
  const key = pathKey(projectCwd);
  const info =
    type === undefined
      ? getDatabase()
          .prepare('DELETE FROM factory_deps WHERE project_key = ? AND from_feature = ? AND to_feature = ?')
          .run(key, fromFeature, toFeature)
      : getDatabase()
          .prepare(
            'DELETE FROM factory_deps WHERE project_key = ? AND from_feature = ? AND to_feature = ? AND type = ?'
          )
          .run(key, fromFeature, toFeature, type);
  if (info.changes > 0) factoryEvents.emitChange();
  return info.changes;
}

/** A project's edges, or only those touching one feature (either end). */
export function listDependencies(projectCwd: string, featureId?: string): FactoryDependency[] {
  const key = pathKey(projectCwd);
  const rows = getDatabase()
    .prepare(
      `SELECT d.*, i.project_cwd FROM factory_deps d
         JOIN factory_items i ON i.project_key = d.project_key AND i.feature_id = d.from_feature
        WHERE d.project_key = ? AND (? IS NULL OR d.from_feature = ? OR d.to_feature = ?)
        ORDER BY d.created_at, d.rowid`
    )
    .all(key, featureId ?? null, featureId ?? null, featureId ?? null) as DepRow[];
  return rows.map(toDependency);
}

/**
 * Drop inferred dependencies whose blocker is done: they were intake's hints
 * about ordering, and once the blocker merged there is nothing left to order.
 * `updateItem()` already does this as an item reaches `done`; this sweeps any
 * left behind (an item closed before its hint was filed). Returns how many.
 */
export function dropResolvedInferredDeps(projectCwd?: string): number {
  const key = projectCwd === undefined ? null : pathKey(projectCwd);
  const info = getDatabase()
    .prepare(
      `DELETE FROM factory_deps
        WHERE inferred = 1 AND (? IS NULL OR project_key = ?)
          AND EXISTS (SELECT 1 FROM factory_items b
                       WHERE b.project_key = factory_deps.project_key
                         AND b.feature_id = factory_deps.to_feature
                         AND b.status = 'done')`
    )
    .run(key, key);
  if (info.changes > 0) factoryEvents.emitChange();
  return info.changes;
}

// ---------------------------------------------------------------------------
// Ready queue, claims and leases

/**
 * Items that can be claimed now: `open`, unclaimed and with no open blocker,
 * most urgent first, then oldest. One project, or all of them (seats are
 * shared across projects).
 */
export function readyItems(projectCwd?: string): FactoryItem[] {
  const key = projectCwd === undefined ? null : pathKey(projectCwd);
  const rows = getDatabase()
    .prepare(
      `WITH RECURSIVE ${BLOCKED_CTE}
       SELECT i.* FROM factory_items i
        WHERE i.status = 'open' AND i.claim_owner IS NULL
          AND (? IS NULL OR i.project_key = ?)
          AND NOT EXISTS (SELECT 1 FROM blocked b
                           WHERE b.project_key = i.project_key AND b.feature_id = i.feature_id)
        ORDER BY i.priority, i.created_at, i.rowid`
    )
    .all(key, key) as ItemRow[];
  return rows.map(toItem);
}

/**
 * Claim an item for a run or a session. The first claimer wins; claiming one
 * you already hold succeeds again (a run's lease is renewed); a lost claim
 * names who holds it. Only an `open` item with no open blocker can be claimed.
 *
 * The check and the write share one IMMEDIATE transaction and the UPDATE
 * repeats the "unclaimed" condition, so two claimers can never both win,
 * even from two connections.
 */
export function claimItem(
  projectCwd: string,
  featureId: string,
  claimant: Claimant,
  now = Date.now()
): ClaimResult {
  const key = pathKey(projectCwd);
  const db = getDatabase();
  const lease = claimant.kind === 'run' ? iso(now + LEASE_EXPIRY_MS) : null;
  const beat = claimant.kind === 'run' ? iso(now) : null;

  const result = db
    .transaction((): ClaimResult => {
      const row = getRow(key, featureId);
      if (!row) return { ok: false, reason: 'missing' };
      if (row.claim_owner !== null) {
        if (row.claim_owner === claimant.owner && row.claim_kind === claimant.kind) {
          db.prepare(
            `UPDATE factory_items SET lease_expires_at = ?, heartbeat_at = ?, updated_at = ?
              WHERE project_key = ? AND feature_id = ?`
          ).run(lease, beat, iso(now), key, featureId);
          return { ok: true, item: toItem(getRow(key, featureId) as ItemRow) };
        }
        return {
          ok: false,
          reason: 'held',
          holder: { owner: row.claim_owner, kind: row.claim_kind as ClaimKind },
        };
      }
      if (row.status !== 'open') return { ok: false, reason: 'not-open' };
      if (isBlocked(key, featureId)) return { ok: false, reason: 'blocked' };

      const info = db
        .prepare(
          `UPDATE factory_items
              SET claim_owner = ?, claim_kind = ?, lease_expires_at = ?, heartbeat_at = ?,
                  status = 'in_progress', updated_at = ?
            WHERE project_key = ? AND feature_id = ? AND claim_owner IS NULL AND status = 'open'`
        )
        .run(claimant.owner, claimant.kind, lease, beat, iso(now), key, featureId);
      const after = getRow(key, featureId) as ItemRow;
      if (info.changes === 1) return { ok: true, item: toItem(after) };
      return {
        ok: false,
        reason: 'held',
        holder: { owner: after.claim_owner as string, kind: after.claim_kind as ClaimKind },
      };
    })
    .immediate();
  if (result.ok) factoryEvents.emitChange();
  return result;
}

/**
 * A run's heartbeat: renew its lease for another `LEASE_EXPIRY_MS`. False when
 * the run no longer holds the item (reclaimed, released, or never claimed), so
 * the run knows to stop. Sessions have no lease and never heartbeat.
 */
export function heartbeat(projectCwd: string, featureId: string, owner: string, now = Date.now()): boolean {
  const info = getDatabase()
    .prepare(
      `UPDATE factory_items SET heartbeat_at = ?, lease_expires_at = ?, updated_at = ?
        WHERE project_key = ? AND feature_id = ? AND claim_owner = ? AND claim_kind = 'run'
          AND status = 'in_progress'`
    )
    .run(iso(now), iso(now + LEASE_EXPIRY_MS), iso(now), pathKey(projectCwd), featureId, owner);
  if (info.changes === 1) factoryEvents.emitChange();
  return info.changes === 1;
}

/**
 * Give a claim back: the item returns to `open`, keeping its step. False if the
 * claimant (owner AND kind, as for a claim) did not hold it.
 */
export function releaseClaim(
  projectCwd: string,
  featureId: string,
  claimant: Claimant,
  now = Date.now()
): boolean {
  const info = getDatabase()
    .prepare(
      `UPDATE factory_items
          SET claim_owner = NULL, claim_kind = NULL, lease_expires_at = NULL, heartbeat_at = NULL,
              status = CASE WHEN status = 'in_progress' THEN 'open' ELSE status END, updated_at = ?
        WHERE project_key = ? AND feature_id = ? AND claim_owner = ? AND claim_kind = ?`
    )
    .run(iso(now), pathKey(projectCwd), featureId, claimant.owner, claimant.kind);
  if (info.changes === 1) factoryEvents.emitChange();
  return info.changes === 1;
}

/**
 * Put every run whose lease has expired back in the queue: claim cleared,
 * status `open`, step kept, so the next claimer resumes from the last commit
 * rather than from scratch. Session claims carry no lease and are never taken.
 * Returns the items reclaimed, as they now are.
 */
export function reclaimExpiredLeases(now = Date.now()): FactoryItem[] {
  const db = getDatabase();
  const at = iso(now);
  const reclaimed = db
    .transaction(() => {
      const expired = db
        .prepare(
          `SELECT project_key, feature_id FROM factory_items
            WHERE claim_owner IS NOT NULL AND claim_kind = 'run' AND status = 'in_progress'
              AND lease_expires_at <= ?`
        )
        .all(at) as { project_key: string; feature_id: string }[];
      const reset = db.prepare(
        `UPDATE factory_items
            SET claim_owner = NULL, claim_kind = NULL, lease_expires_at = NULL, heartbeat_at = NULL,
                status = 'open', updated_at = ?
          WHERE project_key = ? AND feature_id = ?`
      );
      for (const row of expired) reset.run(at, row.project_key, row.feature_id);
      return expired.map((row) => toItem(getRow(row.project_key, row.feature_id) as ItemRow));
    })
    .immediate();
  if (reclaimed.length > 0) factoryEvents.emitChange();
  return reclaimed;
}

// ---------------------------------------------------------------------------
// Session claims (phase 2: project/code-factory.md, "Sessions and the factory
// share one model of work"). A terminal session's claim has no lease and no
// heartbeat: its liveness is the open terminal (factory/session-claims.ts).

export type SessionClaimResult =
  | {
      ok: true;
      items: FactoryItem[];
      /** Run owners whose claim moved to the session: the caller stops those runs. */
      displacedRuns: string[];
    }
  | { ok: false; featureId: string; reason: 'missing' | 'closed' | 'held'; holder?: Claimant };

/**
 * Claim every item of a unit for a terminal session, all or nothing, in one
 * IMMEDIATE transaction: the claim MOVES from a run that holds it (no moment
 * where the item is unclaimed and the dispatcher could take it back), and an
 * unclaimed `open` or `parked` item is claimed outright. Refused when any item
 * is gone, closed, in triage, or held by another session; re-claiming items
 * the session already holds succeeds. No lease, no heartbeat:
 * reclaimExpiredLeases() and recoverOrphans() only ever touch `run` claims.
 */
export function claimForSession(
  projectCwd: string,
  featureIds: string[],
  owner: string,
  now = Date.now()
): SessionClaimResult {
  const key = pathKey(projectCwd);
  const db = getDatabase();
  const result = db
    .transaction((): SessionClaimResult => {
      const displaced = new Set<string>();
      for (const id of featureIds) {
        const row = getRow(key, id);
        if (!row) return { ok: false, featureId: id, reason: 'missing' };
        if (CLOSED_STATUSES.includes(row.status as ItemStatus) || row.status === 'triage') {
          return { ok: false, featureId: id, reason: 'closed' };
        }
        if (row.claim_owner !== null && row.claim_kind === 'session' && row.claim_owner !== owner) {
          return { ok: false, featureId: id, reason: 'held', holder: { owner: row.claim_owner, kind: 'session' } };
        }
        if (row.claim_owner !== null && row.claim_kind === 'run') displaced.add(row.claim_owner);
      }
      const set = db.prepare(
        `UPDATE factory_items
            SET claim_owner = ?, claim_kind = 'session', lease_expires_at = NULL, heartbeat_at = NULL,
                status = 'in_progress', updated_at = ?
          WHERE project_key = ? AND feature_id = ?`
      );
      for (const id of featureIds) set.run(owner, iso(now), key, id);
      return {
        ok: true,
        items: featureIds.map((id) => toItem(getRow(key, id) as ItemRow)),
        displacedRuns: [...displaced],
      };
    })
    .immediate();
  if (result.ok) factoryEvents.emitChange();
  return result;
}

/** Items a session's claim holds, in every project. */
export function itemsClaimedBy(owner: string): FactoryItem[] {
  const rows = getDatabase()
    .prepare(
      `SELECT * FROM factory_items WHERE claim_owner = ? AND claim_kind = 'session' ORDER BY created_at, rowid`
    )
    .all(owner) as ItemRow[];
  return rows.map(toItem);
}
