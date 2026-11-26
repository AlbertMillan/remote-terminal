/**
 * The code factory's work items (project/code-factory.md).
 *
 * An item is a PROJECT.md feature the factory is executing. Its id IS the
 * feature id: the factory never generates, renumbers or rewrites one.
 */

/**
 * `open` is waiting to be claimed (ready once nothing blocks it); `in_progress`
 * is claimed and only ever set by a claim; `parked` waits for the user;
 * `done` and `cancelled` are closed and no longer block anything. `triage` is
 * discovered work waiting to be accepted (factory/triage.ts): never ready,
 * never claimed, and not "waiting for you" in the dispatcher's pause count.
 */
export type ItemStatus = 'open' | 'in_progress' | 'parked' | 'done' | 'cancelled' | 'triage';

/** Statuses an item can be moved to by an update; `in_progress` only comes from a claim. */
export type SettableItemStatus = Exclude<ItemStatus, 'in_progress'>;

export const CLOSED_STATUSES: readonly ItemStatus[] = ['done', 'cancelled'];

/**
 * Who holds a claim. A `run` is a headless agent and keeps its claim alive by
 * heartbeat; a `session` is a terminal, whose liveness is the open terminal
 * itself, so its claim has no lease and is never reclaimed by expiry.
 */
export type ClaimKind = 'run' | 'session';

/**
 * Dependency edges, from the item that waits to the one it waits on:
 * - `blocks`: `from` is not ready until `to` is done.
 * - `parent-child`: `from` is the child, `to` the parent. A child is blocked
 *   whenever its parent is (transitively), as in beads.
 * - `discovered-from`: `from` was found while working on `to`. Provenance only;
 *   it never blocks.
 */
export type DependencyType = 'blocks' | 'parent-child' | 'discovered-from';

export const DEPENDENCY_TYPES: readonly DependencyType[] = ['blocks', 'parent-child', 'discovered-from'];

/** How often a run renews its lease. */
export const LEASE_RENEW_MS = 60_000;
/** How long a run's lease lasts without a heartbeat before it can be reclaimed. */
export const LEASE_EXPIRY_MS = 5 * 60_000;

/** P2: the priority of a feature line that names none. */
export const DEFAULT_PRIORITY = 2;

/** Review a track once as a whole, or after each of its features' commits. */
export type ReviewGranularity = 'track' | 'feature';

export const REVIEW_GRANULARITIES: readonly ReviewGranularity[] = ['track', 'feature'];

export interface FactoryItem {
  projectCwd: string;
  featureId: string;
  trackName: string;
  workflow: string;
  step: string | null;
  status: ItemStatus;
  /** 1 (P1) is most urgent. */
  priority: number;
  modelTier: string | null;
  /** Overrides Settings → Factory's review granularity for this item's unit; null follows the setting. */
  reviewGranularity: ReviewGranularity | null;
  claimOwner: string | null;
  claimKind: ClaimKind | null;
  leaseExpiresAt: string | null;
  heartbeatAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface FactoryDependency {
  projectCwd: string;
  fromFeature: string;
  toFeature: string;
  type: DependencyType;
  /** Intake's scheduling hint, dropped once its blocker is done. */
  inferred: boolean;
  createdAt: string;
}

export interface Claimant {
  owner: string;
  kind: ClaimKind;
}

export type ClaimResult =
  | { ok: true; item: FactoryItem }
  | { ok: false; reason: 'held'; holder: Claimant }
  | { ok: false; reason: 'missing' | 'not-open' | 'blocked' };
