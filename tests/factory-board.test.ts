import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import Fastify from 'fastify';
import { makeTmpDataDir } from './helpers/tmp-data-dir.js';

/**
 * The factory board's read model and routes (project/code-factory.md, f-5clssc):
 * every column, stalls, tokens from the ledger, the merge list, the morning
 * report, the change events behind the pushed feed, and the board's actions.
 * Over a real item store; nothing is ever spawned.
 */

const dataDir = makeTmpDataDir('factory-board');
const configPath = join(dataDir, 'config.json');
writeFileSync(configPath, JSON.stringify({ persistence: { dataDir }, factory: { review: { mode: 'me' } } }));
process.env.CLAUDE_REMOTE_CONFIG = configPath;

const { loadConfig } = await import('../src/server/config.js');
const { initDatabase, closeDatabase, getDatabase } = await import('../src/server/db/schema.js');
const store = await import('../src/server/factory/store.js');
const runState = await import('../src/server/factory/run-state.js');
const mergeStore = await import('../src/server/factory/merge-queue-store.js');
const board = await import('../src/server/factory/board.js');
const { factoryEvents } = await import('../src/server/factory/events.js');
const { unitJobId } = await import('../src/server/factory/deps.js');
const { emptyProgress } = await import('../src/server/factory/templates.js');
const { registerFactoryBoardRoutes, summaryPathAllowed } = await import('../src/server/factory/board-routes.js');

const PROJECT = join(dataDir, 'alpha');
mkdirSync(PROJECT, { recursive: true });
writeFileSync(
  join(PROJECT, 'PROJECT.md'),
  `## Track: Inbox
- [ ] \`f-aaaaaa\` Fork keeps the window title
- [ ] \`f-bbbbbb\` Android push retries on 503
- [ ] \`f-cccccc\` Board remembers collapsed tracks

## Track: History search
- [ ] \`f-h1aaaa\` Index transcripts
- [ ] \`f-h2bbbb\` Search API
`
);

// Midday local time, so "today" and "yesterday" are unambiguous in every time zone.
const T0 = new Date(2026, 10, 26, 12, 0, 0).getTime();
const MIN = 60_000;

beforeAll(() => {
  loadConfig();
  initDatabase();
});
afterAll(() => closeDatabase());

beforeEach(() => {
  getDatabase().exec(
    'DELETE FROM factory_runs; DELETE FROM factory_deps; DELETE FROM factory_items; DELETE FROM factory_merges; DELETE FROM usage_messages'
  );
  board.clearPlanTitles();
});

function item(featureId: string, over: Partial<{ workflow: string; trackName: string; step: string | null }> = {}, at = T0) {
  return store.createItem(
    {
      projectCwd: PROJECT,
      featureId,
      trackName: over.trackName ?? 'Inbox',
      workflow: over.workflow ?? 'item',
      step: over.step ?? null,
    },
    at
  );
}

/** A unit's run state with the given progress fields. */
function progress(unitId: string, patch: Partial<ReturnType<typeof emptyProgress>>, extra: Parameters<typeof runState.saveRunState>[2] = {}) {
  runState.ensureRunState(PROJECT, unitId, [], T0);
  runState.saveRunState(PROJECT, unitId, { progress: { ...emptyProgress(), ...patch }, ...extra }, T0);
}

const shaped = { outcomes: { shape: 'done' } };

function usage(jobId: string, tokens: number, ts = new Date(T0).toISOString()) {
  getDatabase()
    .prepare(
      `INSERT INTO usage_messages (message_id, session_id, project_cwd, job_id, model, ts, input_tokens, output_tokens, cache_read_tokens)
       VALUES (?, 's', ?, ?, 'claude', ?, ?, 0, 999999)`
    )
    .run(`m-${Math.random()}`, PROJECT, jobId, ts, tokens);
}

const build = (opts: Parameters<typeof board.buildFactoryBoard>[0] = {}) => board.buildFactoryBoard({ now: T0, ...opts });
const unitOf = (b: ReturnType<typeof build>, unitId: string) => b.units.find((u) => u.unitId === unitId);

describe('board columns', () => {
  it('puts an unshaped loose item in intake, with its title from the plan', () => {
    item('f-aaaaaa');
    const u = unitOf(build(), 'f-aaaaaa');
    expect(u).toMatchObject({ column: 'intake', status: 'open', title: 'Fork keeps the window title', needsYou: false, isTrack: false });
    expect(u?.projectName).toBe('alpha');
  });

  it('puts an agent-filed triage item in intake as needing you', () => {
    item('f-aaaaaa', { step: 'triage' });
    expect(unitOf(build(), 'f-aaaaaa')).toMatchObject({ column: 'intake', triage: true, needsYou: true });
  });

  it('puts a shaping question in intake, with its options and default for the drawer', () => {
    item('f-aaaaaa');
    store.updateItem(PROJECT, 'f-aaaaaa', { status: 'parked', step: 'shape' }, T0);
    progress(
      'f-aaaaaa',
      { parked: 'shape', notes: { questions: JSON.stringify([{ question: 'Keep the old title?', options: ['yes', 'no'], default: 'yes' }]) } },
      { parkReason: 'shape: a question for you' }
    );
    const u = unitOf(build(), 'f-aaaaaa');
    expect(u).toMatchObject({ column: 'intake', needsYou: true, reason: 'shape: a question for you' });
    expect(u?.detail.questions).toEqual([{ id: 'q1', question: 'Keep the old title?', options: ['yes', 'no'], default: 'yes' }]);
  });

  it('puts a shaped, unclaimed item in ready, naming what it waits for', () => {
    item('f-aaaaaa');
    item('f-bbbbbb');
    progress('f-aaaaaa', shaped);
    store.addDependency({ projectCwd: PROJECT, fromFeature: 'f-aaaaaa', toFeature: 'f-bbbbbb', type: 'blocks', inferred: true }, T0);
    const u = unitOf(build(), 'f-aaaaaa');
    expect(u).toMatchObject({ column: 'ready', waitsFor: ['f-bbbbbb'], reason: 'waits for f-bbbbbb' });
  });

  it('puts a claimed item in running and the review step in review, the agent reviewing', () => {
    item('f-aaaaaa');
    item('f-bbbbbb');
    store.claimItem(PROJECT, 'f-aaaaaa', { owner: 'run:1', kind: 'run' }, T0);
    store.claimItem(PROJECT, 'f-bbbbbb', { owner: 'run:2', kind: 'run' }, T0);
    progress('f-aaaaaa', { ...shaped, current: 'implement' });
    progress('f-bbbbbb', { ...shaped, current: 'review' });
    const b = build();
    expect(unitOf(b, 'f-aaaaaa')).toMatchObject({ column: 'running', step: 'implement', status: 'in_progress' });
    expect(unitOf(b, 'f-bbbbbb')).toMatchObject({ column: 'review', reviewer: 'agent', needsYou: false });
    expect(b.counts).toMatchObject({ running: 1, reviewing: 1, needsYou: 0 });
  });

  it('puts an escalated review in review as yours, with the verdict', () => {
    item('f-aaaaaa');
    store.updateItem(PROJECT, 'f-aaaaaa', { status: 'parked', step: 'review' }, T0);
    progress(
      'f-aaaaaa',
      { ...shaped, parked: 'review', notes: { review: 'Reviewer: approve', summary: join(dataDir, 'factory', 'x', 'summary.md') } },
      { parkReason: 'review: escalated: touches auth/access-gate.ts\n\nReviewer: approve' }
    );
    const u = unitOf(build(), 'f-aaaaaa');
    expect(u).toMatchObject({
      column: 'review',
      reviewer: 'you',
      escalated: true,
      needsYou: true,
      reason: 'review: escalated: touches auth/access-gate.ts',
    });
    expect(u?.detail).toMatchObject({ verdict: 'Reviewer: approve', hasSummary: true });
  });

  it('puts a handed-off unit in merging with its queue entry', () => {
    item('f-aaaaaa');
    store.claimItem(PROJECT, 'f-aaaaaa', { owner: 'run:1', kind: 'run' }, T0);
    progress('f-aaaaaa', shaped, { branch: 'factory/fork-f-aaaaaa', handedOffAt: new Date(T0).toISOString() });
    const m = mergeStore.insertMerge(
      { projectCwd: PROJECT, kind: 'item', branch: 'factory/fork-f-aaaaaa', worktreePath: PROJECT, baseBranch: 'main', featureIds: ['f-aaaaaa'] },
      T0
    );
    mergeStore.updateMerge(m.id, { status: 'running', detail: 'Resolving conflicts in session-manager.ts' }, T0);
    const b = build();
    expect(unitOf(b, 'f-aaaaaa')).toMatchObject({
      column: 'merging',
      mergeId: m.id,
      mergeStatus: 'running',
      reason: 'Resolving conflicts in session-manager.ts',
    });
    expect(b.merges).toHaveLength(1);
    expect(b.merges[0]).toMatchObject({ id: m.id, title: 'Fork keeps the window title', status: 'running', kind: 'item' });
    expect(b.counts.merging).toBe(1);
  });

  it('shows a session Land in the merge list, and a parked conflict with its paths', () => {
    const m = mergeStore.insertMerge(
      { projectCwd: PROJECT, kind: 'session-land', branch: 'track/x', worktreePath: PROJECT, baseBranch: 'main', featureIds: [], trackName: 'History search' },
      T0
    );
    mergeStore.updateMerge(
      m.id,
      {
        status: 'parked',
        detail: 'The resolver could not settle it',
        conflict: { paths: ['src/a.ts'], ours: { branch: 'main' } as never, theirs: { branch: 'track/x' } as never },
      },
      T0
    );
    const [entry] = build().merges;
    expect(entry).toMatchObject({ kind: 'session-land', title: 'History search', status: 'parked', conflictPaths: ['src/a.ts'] });
  });

  it("lists done items finished today, and not yesterday's", () => {
    item('f-aaaaaa');
    item('f-bbbbbb');
    store.updateItem(PROJECT, 'f-aaaaaa', { status: 'done' }, T0 - 60 * MIN);
    store.updateItem(PROJECT, 'f-bbbbbb', { status: 'done' }, T0 - 24 * 60 * MIN);
    const b = build();
    expect(unitOf(b, 'f-aaaaaa')?.column).toBe('done');
    expect(unitOf(b, 'f-bbbbbb')).toBeUndefined();
    expect(b.counts.done).toBe(1);
  });

  it('shows a track as one unit with per-feature progress', () => {
    item('f-h1aaaa', { workflow: 'track', trackName: 'History search' });
    item('f-h2bbbb', { workflow: 'track', trackName: 'History search' });
    store.claimItem(PROJECT, 'f-h1aaaa', { owner: 'run:t', kind: 'run' }, T0);
    store.claimItem(PROJECT, 'f-h2bbbb', { owner: 'run:t', kind: 'run' }, T0);
    progress('track:History search', { current: 'features', featuresDone: ['f-h1aaaa'] });
    const b = build();
    expect(b.units).toHaveLength(1);
    expect(b.units[0]).toMatchObject({ unitId: 'track:History search', isTrack: true, title: 'History search', column: 'running' });
    expect(b.units[0].features).toEqual([
      { id: 'f-h1aaaa', title: 'Index transcripts', state: 'done' },
      { id: 'f-h2bbbb', title: 'Search API', state: 'now' },
    ]);
  });

  it('filters to one project', () => {
    item('f-aaaaaa');
    expect(build({ projectCwd: PROJECT }).units).toHaveLength(1);
    expect(build({ projectCwd: join(dataDir, 'other') }).units).toHaveLength(0);
  });

  it('sorts what needs you first', () => {
    item('f-aaaaaa');
    item('f-bbbbbb');
    store.updateItem(PROJECT, 'f-bbbbbb', { status: 'parked' }, T0);
    expect(build().units.map((u) => u.unitId)).toEqual(['f-bbbbbb', 'f-aaaaaa']);
  });
});

describe('stalls', () => {
  it('flags a claimed run with no heartbeat for over two minutes', () => {
    item('f-aaaaaa');
    store.claimItem(PROJECT, 'f-aaaaaa', { owner: 'run:1', kind: 'run' }, T0 - 10 * MIN);
    progress('f-aaaaaa', { ...shaped, current: 'implement' });
    expect(unitOf(build(), 'f-aaaaaa')?.stalled).toBe('no heartbeat for 10m');
    store.heartbeat(PROJECT, 'f-aaaaaa', 'run:1', T0 - MIN);
    expect(unitOf(build(), 'f-aaaaaa')?.stalled).toBeNull();
  });

  it('flags a ready item unclaimed for 30 minutes while a seat is free, and not when the seats are full', () => {
    item('f-aaaaaa', {}, T0 - 31 * MIN);
    progress('f-aaaaaa', shaped);
    expect(unitOf(build(), 'f-aaaaaa')?.stalled).toBe('ready and unclaimed for 31m with a seat free');

    for (const [id, owner] of [['f-bbbbbb', 'run:1'], ['f-cccccc', 'run:2']] as const) {
      item(id);
      store.claimItem(PROJECT, id, { owner, kind: 'run' }, T0);
    }
    // Two seats held in this project: its per-project limit, so no seat is free for it.
    expect(unitOf(build(), 'f-aaaaaa')?.stalled).toBeNull();
  });

  it('does not flag a ready item that waits for a blocker', () => {
    item('f-aaaaaa', {}, T0 - 60 * MIN);
    item('f-bbbbbb', {}, T0 - 60 * MIN);
    progress('f-aaaaaa', shaped);
    store.addDependency({ projectCwd: PROJECT, fromFeature: 'f-aaaaaa', toFeature: 'f-bbbbbb', type: 'blocks' }, T0 - 60 * MIN);
    expect(unitOf(build(), 'f-aaaaaa')?.stalled).toBeNull();
  });
});

describe('tokens', () => {
  it("counts a unit's ledger tokens, cache reads excluded, and today's total", () => {
    item('f-aaaaaa');
    usage(unitJobId(PROJECT, 'f-aaaaaa'), 1200);
    usage(unitJobId(PROJECT, 'f-aaaaaa'), 800, new Date(T0 - 48 * 60 * MIN).toISOString());
    usage('mq-1', 300);
    usage('job-unrelated', 5000);
    const b = build();
    expect(unitOf(b, 'f-aaaaaa')?.tokens).toBe(2000);
    expect(b.tokensToday).toBe(1500);
    // One project's total goes by its units' job ids, not by the folder the run used.
    usage(unitJobId(join(dataDir, 'other'), 'f-zzzzzz'), 7000);
    expect(build({ projectCwd: PROJECT }).tokensToday).toBe(1200);
  });
});

describe('the pushed summary', () => {
  it('carries the cards without the drawer detail', () => {
    item('f-aaaaaa');
    const s = board.buildFactorySummary({ now: T0 });
    expect(s.units).toHaveLength(1);
    expect('detail' in s.units[0]).toBe(false);
    expect(s.dispatch).toEqual({ started: false, paused: null, capped: {}, seats: 3, running: 0 });
  });

  it('reads the plan once, not per build, while every title is known', () => {
    item('f-aaaaaa');
    board.buildFactorySummary({ now: T0 });
    const plan = join(PROJECT, 'PROJECT.md');
    const original = readFileSync(plan, 'utf-8');
    writeFileSync(plan, original.replace('Fork keeps the window title', 'Renamed'));
    try {
      expect(board.buildFactorySummary({ now: T0 + MIN }).units[0].title).toBe('Fork keeps the window title');
      expect(board.buildFactorySummary({ now: T0 + 6 * MIN }).units[0].title).toBe('Renamed');
    } finally {
      writeFileSync(plan, original);
    }
  });

  it('fires a change event on each factory write', () => {
    const seen = vi.fn();
    const off = factoryEvents.onChange(seen);
    try {
      item('f-aaaaaa');
      store.claimItem(PROJECT, 'f-aaaaaa', { owner: 'run:1', kind: 'run' }, T0);
      store.heartbeat(PROJECT, 'f-aaaaaa', 'run:1', T0);
      runState.ensureRunState(PROJECT, 'f-aaaaaa', [], T0);
      runState.saveRunState(PROJECT, 'f-aaaaaa', { lastCommit: 'abc' }, T0);
      const m = mergeStore.insertMerge(
        { projectCwd: PROJECT, kind: 'item', branch: 'b', worktreePath: PROJECT, baseBranch: 'main', featureIds: ['f-aaaaaa'] },
        T0
      );
      mergeStore.updateMerge(m.id, { status: 'merged' }, T0);
      expect(seen).toHaveBeenCalledTimes(7);
      // A claim that loses changes nothing, and says nothing.
      store.claimItem(PROJECT, 'f-aaaaaa', { owner: 'run:2', kind: 'run' }, T0);
      expect(seen).toHaveBeenCalledTimes(7);
    } finally {
      off();
    }
  });
});

describe('the morning report', () => {
  it('lists what landed since, the stalls now and tokens per unit, most first', () => {
    item('f-aaaaaa');
    item('f-bbbbbb', {}, T0 - 40 * MIN);
    progress('f-bbbbbb', shaped);
    const m = mergeStore.insertMerge(
      { projectCwd: PROJECT, kind: 'item', branch: 'b', worktreePath: PROJECT, baseBranch: 'main', featureIds: ['f-aaaaaa'] },
      T0 - 120 * MIN
    );
    mergeStore.updateMerge(m.id, { status: 'merged', mergeSha: 'abc123' }, T0 - 60 * MIN);
    store.updateItem(PROJECT, 'f-aaaaaa', { status: 'done' }, T0 - 60 * MIN);
    usage(unitJobId(PROJECT, 'f-aaaaaa'), 900, new Date(T0 - 90 * MIN).toISOString());
    usage(unitJobId(PROJECT, 'f-bbbbbb'), 100, new Date(T0 - 10 * MIN).toISOString());
    usage(unitJobId(PROJECT, 'f-bbbbbb'), 5000, new Date(T0 - 600 * MIN).toISOString());

    const report = board.buildFactoryReport(new Date(T0 - 180 * MIN).toISOString(), { now: T0 });
    expect(report.landed.map((l) => [l.title, l.mergeSha])).toEqual([['Fork keeps the window title', 'abc123']]);
    expect(report.stalls.map((s) => s.unitId)).toEqual(['f-bbbbbb']);
    expect(report.tokens).toEqual([
      { projectName: 'alpha', title: 'Fork keeps the window title', tokens: 900 },
      { projectName: 'alpha', title: 'Android push retries on 503', tokens: 100 },
    ]);
    expect(report.totalTokens).toBe(1000);
  });
});

describe('routes', () => {
  async function app() {
    const a = Fastify();
    registerFactoryBoardRoutes(a);
    await a.ready();
    return a;
  }

  function parkAtReview(featureId: string) {
    item(featureId);
    store.updateItem(PROJECT, featureId, { status: 'parked', step: 'review' }, T0);
    progress(featureId, { ...shaped, outcomes: { shape: 'done', implement: 'done', verify: 'pass', 'self-review': 'pass', summary: 'done' }, parked: 'review' }, {
      parkReason: 'review: escalated: auth',
    });
  }

  it('serves the board, filtered by cwd', async () => {
    item('f-aaaaaa');
    const res = await (await app()).inject({ method: 'GET', url: `/api/factory/board?cwd=${encodeURIComponent(PROJECT)}` });
    expect(res.statusCode).toBe(200);
    expect(res.json().units[0]).toMatchObject({ unitId: 'f-aaaaaa', detail: { questions: [] } });
  });

  it('approves a parked review: the outcome is recorded and the item is open again', async () => {
    parkAtReview('f-aaaaaa');
    const res = await (await app()).inject({
      method: 'POST',
      url: '/api/factory/items/f-aaaaaa/release',
      payload: { cwd: PROJECT, outcome: 'approved' },
    });
    expect(res.statusCode).toBe(200);
    expect(store.getItem(PROJECT, 'f-aaaaaa')?.status).toBe('open');
    const state = runState.getRunState(PROJECT, 'f-aaaaaa');
    expect(state?.progress.outcomes.review).toBe('approved');
    expect(state?.parkReason).toBeNull();
    // Released and waiting to be claimed: ready, not "reviewer agent checking".
    expect(build().units[0]).toMatchObject({ column: 'ready', needsYou: false, reviewer: null });
  });

  it('requests changes with your note as the findings', async () => {
    parkAtReview('f-aaaaaa');
    const a = await app();
    const missing = await a.inject({ method: 'POST', url: '/api/factory/items/f-aaaaaa/release', payload: { cwd: PROJECT, outcome: 'changes' } });
    expect(missing.statusCode).toBe(400);
    const res = await a.inject({
      method: 'POST',
      url: '/api/factory/items/f-aaaaaa/release',
      payload: { cwd: PROJECT, outcome: 'changes', note: 'Allow tag wildcards' },
    });
    expect(res.statusCode).toBe(200);
    const state = runState.getRunState(PROJECT, 'f-aaaaaa');
    expect(state?.progress.outcomes.review).toBe('changes');
    expect(state?.progress.notes.review).toBe('You asked for changes:\nAllow tag wildcards');
  });

  it('refuses to release an item that is not parked, or an unknown outcome', async () => {
    item('f-aaaaaa');
    const a = await app();
    const notParked = await a.inject({ method: 'POST', url: '/api/factory/items/f-aaaaaa/release', payload: { cwd: PROJECT } });
    expect(notParked.statusCode).toBe(409);
    const bad = await a.inject({ method: 'POST', url: '/api/factory/items/f-aaaaaa/release', payload: { cwd: PROJECT, outcome: 'merge-now' } });
    expect(bad.statusCode).toBe(400);
    const unknown = await a.inject({ method: 'POST', url: '/api/factory/items/f-zzzzzz/release', payload: { cwd: PROJECT } });
    expect(unknown.statusCode).toBe(404);
  });

  it('refuses an outcome for a park that is not a review, and leaves it parked', async () => {
    item('f-aaaaaa');
    store.updateItem(PROJECT, 'f-aaaaaa', { status: 'parked', step: 'implement' }, T0);
    progress('f-aaaaaa', { ...shaped, parked: 'implement' }, { parkReason: 'runaway: 3,100,000 tokens' });
    const a = await app();
    const res = await a.inject({ method: 'POST', url: '/api/factory/items/f-aaaaaa/release', payload: { cwd: PROJECT, outcome: 'approved' } });
    expect(res.statusCode).toBe(409);
    expect(store.getItem(PROJECT, 'f-aaaaaa')?.status).toBe('parked');
    expect(runState.getRunState(PROJECT, 'f-aaaaaa')?.progress.outcomes.implement).toBeUndefined();
    const plain = await a.inject({ method: 'POST', url: '/api/factory/items/f-aaaaaa/release', payload: { cwd: PROJECT } });
    expect(plain.statusCode).toBe(200);
  });

  it('refuses to release a unit the merge queue parked, and a refused note is not kept', async () => {
    parkAtReview('f-aaaaaa');
    runState.saveRunState(PROJECT, 'f-aaaaaa', { handedOffAt: new Date(T0).toISOString() }, T0);
    const res = await (await app()).inject({
      method: 'POST',
      url: '/api/factory/items/f-aaaaaa/release',
      payload: { cwd: PROJECT, outcome: 'changes', note: 'x' },
    });
    expect(res.statusCode).toBe(409);
    expect(runState.getRunState(PROJECT, 'f-aaaaaa')?.progress.notes.review).toBeUndefined();
  });

  it('refuses to retry a merge entry that is not parked', async () => {
    const m = mergeStore.insertMerge(
      { projectCwd: PROJECT, kind: 'item', branch: 'b', worktreePath: PROJECT, baseBranch: 'main', featureIds: [] },
      T0
    );
    const res = await (await app()).inject({ method: 'POST', url: `/api/factory/merges/${m.id}/retry` });
    expect(res.statusCode).toBe(409);
  });

  it('serves a summary page only from inside the data folder', async () => {
    const dir = join(dataDir, 'factory', 'abc', 'f-aaaaaa');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'summary.md'), '# Summary\n- changed a thing');
    item('f-aaaaaa');
    progress('f-aaaaaa', { notes: { summary: join(dir, 'summary.md') } });
    item('f-bbbbbb');
    progress('f-bbbbbb', { notes: { summary: join(PROJECT, 'PROJECT.md') } });
    const a = await app();
    const ok = await a.inject({ method: 'GET', url: `/api/factory/summary?cwd=${encodeURIComponent(PROJECT)}&unit=f-aaaaaa` });
    expect(ok.json()).toEqual({ markdown: '# Summary\n- changed a thing' });
    const outside = await a.inject({ method: 'GET', url: `/api/factory/summary?cwd=${encodeURIComponent(PROJECT)}&unit=f-bbbbbb` });
    expect(outside.statusCode).toBe(404);
  });

  it('checks summary paths lexically, UNC refused', () => {
    expect(summaryPathAllowed('\\\\evil\\share\\factory\\x.md', dataDir)).toBe(false);
    expect(summaryPathAllowed(join(dataDir, 'factory', '..', 'config.json'), dataDir)).toBe(false);
    expect(summaryPathAllowed(join(dataDir, 'factory', 'a', 'summary.md'), dataDir)).toBe(true);
  });

  it('serves the report and refuses a missing since', async () => {
    const a = await app();
    expect((await a.inject({ method: 'GET', url: '/api/factory/report' })).statusCode).toBe(400);
    const res = await a.inject({ method: 'GET', url: `/api/factory/report?since=${new Date(T0).toISOString()}` });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ landed: [], stalls: [], tokens: [], totalTokens: 0 });
  });
});
