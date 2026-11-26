import { randomUUID } from 'crypto';
import { createLogger } from '../utils/logger.js';
import { pathKey } from '../utils/paths.js';
import { claimItem, getItem, listItems, readyItems, reclaimExpiredLeases, releaseClaim, updateItem } from './store.js';
import type { FactoryItem } from './types.js';
import { defaultEngineDeps, unitJobId, type EngineDeps } from './deps.js';
import { DEFAULT_FACTORY_LIMITS, planCapReason, type FactoryLimits } from './limits.js';
import { getRunState, handedOffUnits, saveRunState, unitIdFor, unitKey } from './run-state.js';
import { runUnit, type RunEnd } from './runner.js';
import { isTrackWorkflow, recordOutcome, templateFor } from './templates.js';

const logger = createLogger('factory-dispatch');

/**
 * Claims ready work and starts runs, under the limits in limits.ts:
 * seats overall and per project, a pause while too many units wait for the
 * user (review capacity), and no NEW units once the project's plan usage is
 * past its cap — running units always finish.
 *
 * A unit takes one seat: a loose item, or a whole track whose open items are
 * claimed together under one owner and worked by one agent.
 */

export interface DispatchStatus {
  /** Why nothing new starts at all, or null. */
  paused: string | null;
  /** Projects held back by plan usage, with why. */
  capped: Record<string, string>;
  running: number;
}

interface Active {
  projectKey: string;
  ac: AbortController;
  done: Promise<RunEnd>;
}

const TICK_MS = 15_000;
/** How long a unit that stepped aside (busy project lock) waits before it is claimed again. */
export const DEFER_MS = 60_000;

/**
 * This process. Every run claim's owner carries it (`run:<boot>:<uuid>`), so a
 * restarted server can tell its own claims from a dead process's.
 */
const BOOT_ID = randomUUID();
const OWNER_PREFIX = `run:${BOOT_ID}:`;

const groupKey = (item: FactoryItem) => unitKey(item.projectCwd, unitIdFor(item, isTrackWorkflow(item.workflow)));

export class Dispatcher {
  private readonly active = new Map<string, Active>();
  /** Units that stepped aside, and the time before which they are not claimed again. */
  private readonly notBefore = new Map<string, number>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private ticking: Promise<string[]> | null = null;
  private last: DispatchStatus = { paused: null, capped: {}, running: 0 };

  constructor(
    private readonly deps: EngineDeps = defaultEngineDeps(),
    private readonly limits: FactoryLimits = DEFAULT_FACTORY_LIMITS
  ) {}

  status(): DispatchStatus {
    return { ...this.last, capped: { ...this.last.capped }, running: this.active.size };
  }

  start(intervalMs = TICK_MS): void {
    if (this.timer) return;
    this.recoverOrphans();
    this.timer = setInterval(() => void this.tick(), intervalMs);
    void this.tick();
  }

  /**
   * Give back every run claim held by an earlier server process. The server is
   * the only writer, so a claim from another boot belongs to a run that died
   * with it: waiting out its lease would hold a seat and stall the unit's
   * resume for up to LEASE_EXPIRY_MS for nothing. Called once, at start.
   * Returns the feature ids released.
   */
  recoverOrphans(): string[] {
    const now = this.deps.now();
    const released: string[] = [];
    for (const item of listItems({ status: ['in_progress'] })) {
      const owner = item.claimOwner;
      if (item.claimKind !== 'run' || !owner || owner.startsWith(OWNER_PREFIX)) continue;
      if (releaseClaim(item.projectCwd, item.featureId, { owner, kind: 'run' }, now)) released.push(item.featureId);
    }
    if (released.length > 0) logger.info({ items: released }, 'factory: released claims left by a previous server');
    return released;
  }

  /** Stop dispatching and stop every run; each gives its claim back, to resume on the next start. */
  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.ticking;
    for (const a of this.active.values()) a.ac.abort();
    await this.idle();
  }

  /**
   * Stop one unit's run (a Take over) and settle once it has unwound. The
   * caller moves the claim first (store.ts claimForSession), so the run's
   * owner-checked release touches nothing and the seat's refill cannot claim
   * the unit back. Its partial work stays in the worktree; nothing is reset.
   * False when no run of this unit is active here.
   */
  async stopUnit(key: string): Promise<boolean> {
    const run = this.active.get(key);
    if (!run) return false;
    run.ac.abort();
    await run.done;
    return true;
  }

  /** Settles once every run started so far has ended. */
  async idle(): Promise<void> {
    await Promise.all([...this.active.values()].map((a) => a.done));
  }

  /** One dispatch pass. Overlapping calls share the pass in flight. Returns the unit keys started. */
  tick(): Promise<string[]> {
    if (!this.ticking) {
      this.ticking = Promise.resolve()
        .then(() => this.dispatch())
        .catch((error) => {
          logger.warn({ error }, 'factory: dispatch failed');
          return [];
        })
        .finally(() => {
          this.ticking = null;
        });
    }
    return this.ticking;
  }

  private dispatch(): string[] {
    const now = this.deps.now();
    const reclaimed = reclaimExpiredLeases(now);
    if (reclaimed.length > 0) {
      logger.info({ items: reclaimed.map((i) => i.featureId) }, 'factory: reclaimed expired leases');
    }

    const capped: Record<string, string> = {};
    const parked = new Set(listItems({ status: ['parked'] }).map(groupKey));
    if (parked.size >= this.limits.pauseWhenParked) {
      this.last = { paused: `${parked.size} waiting for you`, capped, running: this.active.size };
      return [];
    }

    // Seats held, by claim owner: ours, and any a dead run still holds until its lease expires.
    // A unit a terminal session holds takes no seat and is never started: not even an
    // open sibling of its track, which would put a second agent in the session's worktree.
    const owners = new Map<string, string>();
    const sessionHeld = new Set<string>();
    for (const item of listItems({ status: ['in_progress'] })) {
      if (item.claimKind === 'run' && item.claimOwner) owners.set(item.claimOwner, pathKey(item.projectCwd));
      if (item.claimKind === 'session') sessionHeld.add(groupKey(item));
    }
    let total = owners.size;
    const perProject = new Map<string, number>();
    for (const pk of owners.values()) perProject.set(pk, (perProject.get(pk) ?? 0) + 1);

    const handedOff = handedOffUnits();
    const started: string[] = [];
    const capOf = new Map<string, string | null>();

    for (const item of readyItems()) {
      if (total >= this.limits.seats) break;
      const key = groupKey(item);
      if (handedOff.has(key) || this.active.has(key) || sessionHeld.has(key)) continue;
      if ((this.notBefore.get(key) ?? 0) > now) continue;
      const pk = pathKey(item.projectCwd);
      if ((perProject.get(pk) ?? 0) >= this.limits.seatsPerProject) continue;
      if (!capOf.has(pk)) capOf.set(pk, planCapReason(this.deps.planUsage(item.projectCwd), this.limits, now));
      const cap = capOf.get(pk);
      if (cap) {
        capped[item.projectCwd] = cap;
        continue;
      }

      const claimed = this.claimUnit(item, `${OWNER_PREFIX}${randomUUID()}`, now);
      if (!claimed) continue;
      this.launch(key, item, claimed.owner, claimed.ids);
      started.push(key);
      total++;
      perProject.set(pk, (perProject.get(pk) ?? 0) + 1);
    }

    this.last = { paused: null, capped, running: this.active.size };
    return started;
  }

  /** Claim the item, and for a track every other open item of it, under one owner. */
  private claimUnit(lead: FactoryItem, owner: string, now: number): { owner: string; ids: string[] } | null {
    const claimant = { owner, kind: 'run' as const };
    if (!claimItem(lead.projectCwd, lead.featureId, claimant, now).ok) return null;
    const ids = [lead.featureId];
    if (isTrackWorkflow(lead.workflow)) {
      for (const sib of readyItems(lead.projectCwd)) {
        if (sib.featureId === lead.featureId || sib.trackName !== lead.trackName || !isTrackWorkflow(sib.workflow)) continue;
        if (claimItem(sib.projectCwd, sib.featureId, claimant, now).ok) ids.push(sib.featureId);
      }
    }
    return { owner, ids };
  }

  private launch(key: string, lead: FactoryItem, owner: string, featureIds: string[]): void {
    const isTrack = isTrackWorkflow(lead.workflow);
    const ac = new AbortController();
    const done = runUnit(
      {
        ref: {
          projectCwd: lead.projectCwd,
          unitId: unitIdFor(lead, isTrack),
          trackName: lead.trackName,
          isTrack,
          featureIds,
        },
        workflow: lead.workflow,
        owner,
        modelTier: lead.modelTier,
      },
      this.deps,
      { signal: ac.signal, limits: this.limits }
    )
      .catch((error): RunEnd => {
        logger.error({ error, unit: key }, 'factory: run crashed');
        return { kind: 'lost' };
      })
      .then((end) => {
        // Without the cool-down the finally below would claim it straight back
        // into the same busy lock, again and again.
        if (end.kind === 'deferred') this.notBefore.set(key, this.deps.now() + DEFER_MS);
        else this.notBefore.delete(key);
        return end;
      })
      .finally(() => {
        this.active.delete(key);
        // A seat came free: fill it now rather than at the next interval.
        if (this.timer) void this.tick();
      });
    this.active.set(key, { projectKey: pathKey(lead.projectCwd), ac, done });
  }
}

// ---------------------------------------------------------------------------
// The user's side of a parked unit.

export class FactoryEngineError extends Error {}

/**
 * Put a parked unit back in the queue. With `outcome`, record it as the
 * parked step's outcome first (the review stub's `approved`); a unit parked
 * at a loop cap gets that loop's runs back; one parked by the runaway guard
 * gets a fresh token allowance from what it has spent so far.
 */
export function releaseParked(
  projectCwd: string,
  featureId: string,
  opts: { outcome?: string } = {},
  deps: Pick<EngineDeps, 'tokensUsed' | 'now'> = defaultEngineDeps()
): void {
  const item = getItem(projectCwd, featureId);
  if (!item || item.status !== 'parked') throw new FactoryEngineError(`${featureId} is not parked`);
  const isTrack = isTrackWorkflow(item.workflow);
  clearParkedProgress(item, opts, deps);
  const members = isTrack
    ? listItems({ projectCwd, status: ['parked'] }).filter((i) => i.trackName === item.trackName && isTrackWorkflow(i.workflow))
    : [item];
  for (const m of members) updateItem(projectCwd, m.featureId, { status: 'open' }, deps.now());
}

/**
 * A parked unit's progress made runnable again (releaseParked, and a Take over
 * of a parked unit): the outcome recorded against the parked step when given,
 * a loop cap's runs given back, a runaway's token allowance renewed.
 */
export function clearParkedProgress(
  item: FactoryItem,
  opts: { outcome?: string },
  deps: Pick<EngineDeps, 'tokensUsed' | 'now'>
): void {
  const { projectCwd } = item;
  const unitId = unitIdFor(item, isTrackWorkflow(item.workflow));
  const state = getRunState(projectCwd, unitId);
  const template = templateFor(item.workflow);
  if (!state || !template) return;
  const { progress } = state;
  const step = template.steps.find((s) => s.id === progress.parked);
  if (step && opts.outcome) recordOutcome(template, progress, step.id, opts.outcome);
  else if (step?.loop && (progress.loops[step.id] ?? 0) >= step.loop.max) progress.loops[step.id] = 0;
  if (state.parkReason?.startsWith('runaway')) progress.tokenBase = deps.tokensUsed(unitJobId(projectCwd, unitId));
  progress.parked = null;
  saveRunState(projectCwd, unitId, { progress, parkReason: null }, deps.now());
}

// ---------------------------------------------------------------------------
// The server's one dispatcher, started at boot by factory-boot.ts.

let dispatcher: Dispatcher | null = null;

export function startFactory(deps?: EngineDeps, limits?: FactoryLimits): Dispatcher {
  if (!dispatcher) {
    dispatcher = new Dispatcher(deps, limits);
    dispatcher.start();
  }
  return dispatcher;
}

export async function stopFactory(): Promise<void> {
  const d = dispatcher;
  dispatcher = null;
  await d?.stop();
}

export function getDispatcher(): Dispatcher | null {
  return dispatcher;
}
