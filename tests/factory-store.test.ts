import { describe, it, expect, beforeEach, beforeAll, afterAll } from 'vitest';
import { writeFileSync } from 'fs';
import { join } from 'path';
import { makeTmpDataDir } from './helpers/tmp-data-dir.js';

/**
 * The code factory's item store (project/code-factory.md, f-zrdzuy): the ready
 * queue, dependency semantics, claims and leases. Every time-dependent call
 * takes `now`, so leases are tested by passing the clock, not by waiting.
 */

const dataDir = makeTmpDataDir('factory-store');
const configPath = join(dataDir, 'config.json');
writeFileSync(configPath, JSON.stringify({ persistence: { dataDir } }));
process.env.CLAUDE_REMOTE_CONFIG = configPath;

const { loadConfig } = await import('../src/server/config.js');
const { initDatabase, closeDatabase, getDatabase } = await import('../src/server/db/schema.js');
const store = await import('../src/server/factory/store.js');
const { LEASE_EXPIRY_MS, LEASE_RENEW_MS } = await import('../src/server/factory/types.js');

const ALPHA = 'C:\\projects\\alpha';
const BETA = 'C:\\projects\\beta';
const T0 = Date.parse('2026-11-26T10:00:00.000Z');

beforeAll(() => {
  loadConfig();
  initDatabase();
});

afterAll(() => {
  closeDatabase();
});

beforeEach(() => {
  getDatabase().exec('DELETE FROM factory_deps; DELETE FROM factory_items');
});

/** Items are created a second apart, so "age" is unambiguous. */
let clock = T0;
function item(featureId: string, opts: { priority?: number; cwd?: string } = {}) {
  clock += 1000;
  return store.createItem(
    {
      projectCwd: opts.cwd ?? ALPHA,
      featureId,
      trackName: 'Code factory',
      workflow: 'track',
      priority: opts.priority,
    },
    clock
  );
}

const ready = (...cwd: [string?]) => store.readyItems(cwd.length ? cwd[0] : ALPHA).map((i) => i.featureId);
const run = (owner: string) => ({ owner, kind: 'run' as const });

describe('items', () => {
  it('keeps the PROJECT.md id and refuses anything that is not one', () => {
    const created = item('f-abc123');
    expect(created).toMatchObject({ featureId: 'f-abc123', status: 'open', priority: 2, claimOwner: null });
    expect(() => item('Item store')).toThrow(store.FactoryStoreError);
    expect(() => item('f-abc123')).toThrow(/already/);
  });

  it('matches a project path case- and separator-insensitively', () => {
    item('f-aaaaaa');
    expect(store.getItem('c:/projects/ALPHA/', 'f-aaaaaa')?.featureId).toBe('f-aaaaaa');
  });

  it('updates only the fields given and lists by project and status', () => {
    item('f-aaaaaa');
    item('f-bbbbbb', { cwd: BETA });
    const updated = store.updateItem(ALPHA, 'f-aaaaaa', { step: 'implement', modelTier: 'opus' });
    expect(updated).toMatchObject({ step: 'implement', modelTier: 'opus', workflow: 'track', status: 'open' });
    expect(store.listItems().map((i) => i.featureId)).toEqual(['f-aaaaaa', 'f-bbbbbb']);
    expect(store.listItems({ projectCwd: BETA }).map((i) => i.featureId)).toEqual(['f-bbbbbb']);
    store.updateItem(BETA, 'f-bbbbbb', { status: 'done' });
    expect(store.listItems({ status: ['done'] }).map((i) => i.featureId)).toEqual(['f-bbbbbb']);
  });

  it('deleting an item removes its dependencies', () => {
    item('f-aaaaaa');
    item('f-bbbbbb');
    store.addDependency({ projectCwd: ALPHA, fromFeature: 'f-bbbbbb', toFeature: 'f-aaaaaa', type: 'blocks' });
    expect(store.deleteItem(ALPHA, 'f-aaaaaa')).toBe(true);
    expect(store.listDependencies(ALPHA)).toEqual([]);
    expect(ready()).toEqual(['f-bbbbbb']);
  });
});

describe('ready queue', () => {
  it('orders by priority, then age', () => {
    item('f-p3old', { priority: 3 });
    item('f-p2old');
    item('f-p1new', { priority: 1 });
    item('f-p2new');
    expect(ready()).toEqual(['f-p1new', 'f-p2old', 'f-p2new', 'f-p3old']);
  });

  it('spans every project when none is named', () => {
    item('f-aaaaaa', { priority: 2 });
    item('f-bbbbbb', { priority: 1, cwd: BETA });
    expect(ready(undefined)).toEqual(['f-bbbbbb', 'f-aaaaaa']);
    expect(ready(BETA)).toEqual(['f-bbbbbb']);
  });

  it('holds an item back while a blocker is open, and releases it once the blocker closes', () => {
    item('f-first');
    item('f-second', { priority: 1 });
    store.addDependency({ projectCwd: ALPHA, fromFeature: 'f-second', toFeature: 'f-first', type: 'blocks' });
    expect(ready()).toEqual(['f-first']);

    // A claimed or parked blocker still blocks; only done or cancelled releases.
    store.claimItem(ALPHA, 'f-first', run('r1'), T0);
    expect(ready()).toEqual([]);
    store.updateItem(ALPHA, 'f-first', { status: 'parked' });
    expect(ready()).toEqual([]);
    store.updateItem(ALPHA, 'f-first', { status: 'done' });
    expect(ready()).toEqual(['f-second']);
  });

  it('a cancelled blocker no longer blocks', () => {
    item('f-first');
    item('f-second');
    store.addDependency({ projectCwd: ALPHA, fromFeature: 'f-second', toFeature: 'f-first', type: 'blocks' });
    store.updateItem(ALPHA, 'f-first', { status: 'cancelled' });
    expect(ready()).toEqual(['f-second']);
  });

  it('excludes claimed, parked and closed items', () => {
    item('f-open');
    item('f-claimed');
    item('f-parked');
    item('f-done');
    store.claimItem(ALPHA, 'f-claimed', run('r1'), T0);
    store.updateItem(ALPHA, 'f-parked', { status: 'parked' });
    store.updateItem(ALPHA, 'f-done', { status: 'done' });
    expect(ready()).toEqual(['f-open']);
  });
});

describe('dependency types', () => {
  it('parent-child: a child inherits its parent\'s blockers, at any depth', () => {
    item('f-blocker');
    item('f-parent');
    item('f-child');
    item('f-grandkid');
    store.addDependency({ projectCwd: ALPHA, fromFeature: 'f-parent', toFeature: 'f-blocker', type: 'blocks' });
    store.addDependency({ projectCwd: ALPHA, fromFeature: 'f-child', toFeature: 'f-parent', type: 'parent-child' });
    store.addDependency({ projectCwd: ALPHA, fromFeature: 'f-grandkid', toFeature: 'f-child', type: 'parent-child' });
    expect(ready()).toEqual(['f-blocker']);

    store.updateItem(ALPHA, 'f-blocker', { status: 'done' });
    expect(ready()).toEqual(['f-parent', 'f-child', 'f-grandkid']);
  });

  it('a closed parent passes no blocker down to its open children', () => {
    item('f-blocker');
    item('f-parent');
    item('f-child');
    store.addDependency({ projectCwd: ALPHA, fromFeature: 'f-parent', toFeature: 'f-blocker', type: 'blocks' });
    store.addDependency({ projectCwd: ALPHA, fromFeature: 'f-child', toFeature: 'f-parent', type: 'parent-child' });
    expect(ready()).toEqual(['f-blocker']);
    store.updateItem(ALPHA, 'f-parent', { status: 'cancelled' });
    expect(ready()).toEqual(['f-blocker', 'f-child']);
  });

  it('parent-child alone does not block: an unblocked parent leaves its children ready', () => {
    item('f-parent');
    item('f-child');
    store.addDependency({ projectCwd: ALPHA, fromFeature: 'f-child', toFeature: 'f-parent', type: 'parent-child' });
    expect(ready()).toEqual(['f-parent', 'f-child']);
  });

  it('discovered-from never blocks', () => {
    item('f-origin');
    item('f-found');
    store.addDependency({ projectCwd: ALPHA, fromFeature: 'f-found', toFeature: 'f-origin', type: 'discovered-from' });
    expect(ready()).toEqual(['f-origin', 'f-found']);
    expect(store.claimItem(ALPHA, 'f-found', run('r1'), T0).ok).toBe(true);
  });

  it('refuses self-edges, unknown items and blocking cycles', () => {
    item('f-aaaaaa');
    item('f-bbbbbb');
    item('f-cccccc');
    const add = (from: string, to: string, type: 'blocks' | 'parent-child' | 'discovered-from') =>
      store.addDependency({ projectCwd: ALPHA, fromFeature: from, toFeature: to, type });
    expect(() => add('f-aaaaaa', 'f-aaaaaa', 'blocks')).toThrow(/itself/);
    expect(() => add('f-aaaaaa', 'f-zzzzzz', 'blocks')).toThrow(/not a factory item/);
    add('f-bbbbbb', 'f-aaaaaa', 'blocks');
    add('f-cccccc', 'f-bbbbbb', 'parent-child');
    expect(() => add('f-aaaaaa', 'f-cccccc', 'blocks')).toThrow(/cycle/);
    // Provenance can point anywhere.
    expect(add('f-aaaaaa', 'f-cccccc', 'discovered-from').type).toBe('discovered-from');
  });

  it('removes one edge, or every type between a pair', () => {
    item('f-aaaaaa');
    item('f-bbbbbb');
    store.addDependency({ projectCwd: ALPHA, fromFeature: 'f-bbbbbb', toFeature: 'f-aaaaaa', type: 'blocks' });
    store.addDependency({ projectCwd: ALPHA, fromFeature: 'f-bbbbbb', toFeature: 'f-aaaaaa', type: 'discovered-from' });
    expect(store.removeDependency(ALPHA, 'f-bbbbbb', 'f-aaaaaa', 'blocks')).toBe(1);
    expect(ready()).toEqual(['f-aaaaaa', 'f-bbbbbb']);
    expect(store.removeDependency(ALPHA, 'f-bbbbbb', 'f-aaaaaa')).toBe(1);
    expect(store.listDependencies(ALPHA)).toEqual([]);
  });
});

describe('inferred dependencies', () => {
  it('vanish when their blocker is done; declared ones stay', () => {
    item('f-blocker');
    item('f-hinted');
    item('f-declared');
    store.addDependency({
      projectCwd: ALPHA, fromFeature: 'f-hinted', toFeature: 'f-blocker', type: 'blocks', inferred: true,
    });
    store.addDependency({ projectCwd: ALPHA, fromFeature: 'f-declared', toFeature: 'f-blocker', type: 'blocks' });
    expect(store.listDependencies(ALPHA, 'f-hinted')[0].inferred).toBe(true);

    store.updateItem(ALPHA, 'f-blocker', { status: 'done' });
    expect(store.listDependencies(ALPHA).map((d) => d.fromFeature)).toEqual(['f-declared']);
  });

  it('are swept by dropResolvedInferredDeps when the blocker closed outside updateItem', () => {
    item('f-blocker');
    item('f-hinted');
    getDatabase().prepare(`UPDATE factory_items SET status = 'done' WHERE feature_id = 'f-blocker'`).run();
    store.addDependency({
      projectCwd: ALPHA, fromFeature: 'f-hinted', toFeature: 'f-blocker', type: 'blocks', inferred: true,
    });
    expect(store.dropResolvedInferredDeps(BETA)).toBe(0);
    expect(store.dropResolvedInferredDeps(ALPHA)).toBe(1);
    expect(store.listDependencies(ALPHA)).toEqual([]);
  });

  it('a declared edge re-added over an inferred one is kept past done', () => {
    item('f-blocker');
    item('f-waiter');
    const edge = { projectCwd: ALPHA, fromFeature: 'f-waiter', toFeature: 'f-blocker', type: 'blocks' as const };
    store.addDependency({ ...edge, inferred: true });
    expect(store.addDependency(edge).inferred).toBe(false);
    // And an inferred re-add does not downgrade it.
    expect(store.addDependency({ ...edge, inferred: true }).inferred).toBe(false);
    store.updateItem(ALPHA, 'f-blocker', { status: 'done' });
    expect(store.listDependencies(ALPHA)).toHaveLength(1);
  });
});

describe('claims', () => {
  it('two concurrent claims: exactly one wins, the other learns who holds it', async () => {
    item('f-aaaaaa');
    const results = await Promise.all(
      ['r1', 'r2'].map(async (owner) => store.claimItem(ALPHA, 'f-aaaaaa', run(owner), T0))
    );
    const winners = results.filter((r) => r.ok);
    const losers = results.filter((r) => !r.ok);
    expect(winners).toHaveLength(1);
    expect(losers).toEqual([{ ok: false, reason: 'held', holder: { owner: 'r1', kind: 'run' } }]);
    expect(store.getItem(ALPHA, 'f-aaaaaa')).toMatchObject({ status: 'in_progress', claimOwner: 'r1' });
  });

  it('many claimers on one item: one winner, every other claim refused', () => {
    item('f-aaaaaa');
    const results = Array.from({ length: 10 }, (_, n) => store.claimItem(ALPHA, 'f-aaaaaa', run(`r${n}`), T0));
    expect(results.filter((r) => r.ok)).toHaveLength(1);
  });

  it('re-claiming your own claim is idempotent', () => {
    item('f-aaaaaa');
    const first = store.claimItem(ALPHA, 'f-aaaaaa', run('r1'), T0);
    const again = store.claimItem(ALPHA, 'f-aaaaaa', run('r1'), T0);
    expect(first.ok && again.ok).toBe(true);
    if (!again.ok) return;
    expect(again.item).toMatchObject({ claimOwner: 'r1', claimKind: 'run', status: 'in_progress' });
    // The same owner name under the other kind is somebody else.
    expect(store.claimItem(ALPHA, 'f-aaaaaa', { owner: 'r1', kind: 'session' }, T0)).toMatchObject({
      ok: false,
      reason: 'held',
    });
  });

  it('refuses missing, blocked and non-open items', () => {
    item('f-blocker');
    item('f-waiter');
    item('f-parked');
    store.addDependency({ projectCwd: ALPHA, fromFeature: 'f-waiter', toFeature: 'f-blocker', type: 'blocks' });
    store.updateItem(ALPHA, 'f-parked', { status: 'parked' });
    expect(store.claimItem(ALPHA, 'f-nothing', run('r1'), T0)).toEqual({ ok: false, reason: 'missing' });
    expect(store.claimItem(ALPHA, 'f-waiter', run('r1'), T0)).toEqual({ ok: false, reason: 'blocked' });
    expect(store.claimItem(ALPHA, 'f-parked', run('r1'), T0)).toEqual({ ok: false, reason: 'not-open' });
  });

  it('a status change clears the claim; release gives it back keeping the step', () => {
    item('f-aaaaaa');
    store.updateItem(ALPHA, 'f-aaaaaa', { step: 'verify' });
    store.claimItem(ALPHA, 'f-aaaaaa', run('r1'), T0);
    expect(store.releaseClaim(ALPHA, 'f-aaaaaa', run('r2'), T0)).toBe(false);
    // Same owner name, other kind: not the holder, as for a claim.
    expect(store.releaseClaim(ALPHA, 'f-aaaaaa', { owner: 'r1', kind: 'session' }, T0)).toBe(false);
    expect(store.releaseClaim(ALPHA, 'f-aaaaaa', run('r1'), T0)).toBe(true);
    expect(store.getItem(ALPHA, 'f-aaaaaa')).toMatchObject({ status: 'open', step: 'verify', claimOwner: null });

    store.claimItem(ALPHA, 'f-aaaaaa', run('r1'), T0);
    store.updateItem(ALPHA, 'f-aaaaaa', { status: 'parked' });
    expect(store.getItem(ALPHA, 'f-aaaaaa')).toMatchObject({ claimOwner: null, leaseExpiresAt: null });
  });
});

describe('update validation', () => {
  it('refuses in_progress and unknown statuses: only a claim makes an item in progress', () => {
    item('f-aaaaaa');
    // As a route forwarding a request body would pass it, past the type.
    const patch = { status: 'in_progress' } as unknown as Parameters<typeof store.updateItem>[2];
    expect(() => store.updateItem(ALPHA, 'f-aaaaaa', patch)).toThrow(/claim/);
    const bogus = { status: 'merged' } as unknown as Parameters<typeof store.updateItem>[2];
    expect(() => store.updateItem(ALPHA, 'f-aaaaaa', bogus)).toThrow(store.FactoryStoreError);
    expect(store.getItem(ALPHA, 'f-aaaaaa')?.status).toBe('open');
    expect(ready()).toEqual(['f-aaaaaa']);
  });

  it('ignores keys that are not item fields instead of building bad SQL', () => {
    item('f-aaaaaa');
    const patch = { step: 'verify', constructor: 'x', claimOwner: 'r9' } as unknown as Parameters<
      typeof store.updateItem
    >[2];
    expect(store.updateItem(ALPHA, 'f-aaaaaa', patch)).toMatchObject({ step: 'verify', claimOwner: null });
  });

  it('refuses a priority that would mis-sort the ready queue', () => {
    expect(() => item('f-aaaaaa', { priority: Number.NaN })).toThrow(/priority/);
    expect(() => item('f-bbbbbb', { priority: 0 })).toThrow(/priority/);
    item('f-cccccc');
    expect(() => store.updateItem(ALPHA, 'f-cccccc', { priority: 1.5 })).toThrow(/priority/);
    expect(store.updateItem(ALPHA, 'f-cccccc', { priority: 1 })?.priority).toBe(1);
  });
});

describe('leases', () => {
  it('renew every minute and expire five minutes after the last heartbeat', () => {
    expect(LEASE_RENEW_MS).toBe(60_000);
    expect(LEASE_EXPIRY_MS).toBe(5 * 60_000);
  });

  it('a heartbeat renews the lease; a non-holder\'s heartbeat is refused', () => {
    item('f-aaaaaa');
    const claim = store.claimItem(ALPHA, 'f-aaaaaa', run('r1'), T0);
    expect(claim.ok && claim.item.leaseExpiresAt).toBe(new Date(T0 + LEASE_EXPIRY_MS).toISOString());

    const later = T0 + LEASE_RENEW_MS;
    expect(store.heartbeat(ALPHA, 'f-aaaaaa', 'r1', later)).toBe(true);
    expect(store.getItem(ALPHA, 'f-aaaaaa')).toMatchObject({
      heartbeatAt: new Date(later).toISOString(),
      leaseExpiresAt: new Date(later + LEASE_EXPIRY_MS).toISOString(),
    });
    expect(store.heartbeat(ALPHA, 'f-aaaaaa', 'r2', later)).toBe(false);
  });

  it('heartbeats keep a run past its original expiry', () => {
    item('f-aaaaaa');
    store.claimItem(ALPHA, 'f-aaaaaa', run('r1'), T0);
    for (let t = T0 + LEASE_RENEW_MS; t <= T0 + 10 * LEASE_RENEW_MS; t += LEASE_RENEW_MS) {
      expect(store.heartbeat(ALPHA, 'f-aaaaaa', 'r1', t)).toBe(true);
      expect(store.reclaimExpiredLeases(t)).toEqual([]);
    }
    expect(store.getItem(ALPHA, 'f-aaaaaa')?.claimOwner).toBe('r1');
  });

  it('an expired lease is reclaimed to ready, keeping its step, and the old run loses it', () => {
    item('f-aaaaaa');
    store.updateItem(ALPHA, 'f-aaaaaa', { step: 'implement' });
    store.claimItem(ALPHA, 'f-aaaaaa', run('r1'), T0);

    expect(store.reclaimExpiredLeases(T0 + LEASE_EXPIRY_MS - 1)).toEqual([]);
    expect(ready()).toEqual([]);

    const reclaimed = store.reclaimExpiredLeases(T0 + LEASE_EXPIRY_MS);
    expect(reclaimed.map((i) => i.featureId)).toEqual(['f-aaaaaa']);
    expect(reclaimed[0]).toMatchObject({ status: 'open', step: 'implement', claimOwner: null, leaseExpiresAt: null });
    expect(ready()).toEqual(['f-aaaaaa']);

    // The dead run's late heartbeat is refused, and a new run can take over.
    expect(store.heartbeat(ALPHA, 'f-aaaaaa', 'r1', T0 + LEASE_EXPIRY_MS + 1)).toBe(false);
    expect(store.claimItem(ALPHA, 'f-aaaaaa', run('r2'), T0 + LEASE_EXPIRY_MS + 1).ok).toBe(true);
  });

  it('a heartbeat landing after expiry but before the reclaim keeps the claim', () => {
    item('f-aaaaaa');
    store.claimItem(ALPHA, 'f-aaaaaa', run('r1'), T0);
    const late = T0 + LEASE_EXPIRY_MS + 1000;
    expect(store.heartbeat(ALPHA, 'f-aaaaaa', 'r1', late)).toBe(true);
    expect(store.reclaimExpiredLeases(late)).toEqual([]);
    expect(store.getItem(ALPHA, 'f-aaaaaa')?.claimOwner).toBe('r1');
  });

  it('the reclaim sweep reads the lease index, not the whole table', () => {
    const plan = getDatabase()
      .prepare(
        `EXPLAIN QUERY PLAN SELECT project_key, feature_id FROM factory_items
          WHERE claim_owner IS NOT NULL AND claim_kind = 'run' AND status = 'in_progress'
            AND lease_expires_at <= ?`
      )
      .all('x') as { detail: string }[];
    expect(plan.map((row) => row.detail).join(' ')).toMatch(/idx_factory_items_lease/);
  });

  it('a session claim has no lease and is never reclaimed', () => {
    item('f-aaaaaa');
    const claim = store.claimItem(ALPHA, 'f-aaaaaa', { owner: 'session-1', kind: 'session' }, T0);
    expect(claim.ok && claim.item.leaseExpiresAt).toBeNull();
    expect(store.reclaimExpiredLeases(T0 + 24 * 60 * 60_000)).toEqual([]);
    expect(store.heartbeat(ALPHA, 'f-aaaaaa', 'session-1', T0)).toBe(false);
    expect(store.getItem(ALPHA, 'f-aaaaaa')?.claimOwner).toBe('session-1');
  });
});
