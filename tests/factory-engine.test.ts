import { describe, it, expect, beforeEach, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { writeFileSync } from 'fs';
import { join } from 'path';
import { makeTmpDataDir } from './helpers/tmp-data-dir.js';

/**
 * The factory engine (project/code-factory.md, f-uwj3b0): the runner and the
 * dispatcher over a real item store, with every outside effect (claude, git,
 * the ledger, plan usage, the merge sink) behind fake EngineDeps. No claude is
 * ever spawned.
 */

const dataDir = makeTmpDataDir('factory-engine');
const configPath = join(dataDir, 'config.json');
// Review by "me": these tests are about the engine; the reviewer agent is factory-review.test.ts.
writeFileSync(configPath, JSON.stringify({ persistence: { dataDir }, factory: { review: { mode: 'me' } } }));
process.env.CLAUDE_REMOTE_CONFIG = configPath;

const { loadConfig } = await import('../src/server/config.js');
const { initDatabase, closeDatabase, getDatabase } = await import('../src/server/db/schema.js');
const store = await import('../src/server/factory/store.js');
const { LEASE_EXPIRY_MS, LEASE_RENEW_MS } = await import('../src/server/factory/types.js');
const { RunAbortedError } = await import('../src/server/agent/claude-run.js');
const { runUnit } = await import('../src/server/factory/runner.js');
const { Dispatcher, releaseParked, DEFER_MS } = await import('../src/server/factory/dispatcher.js');
const { ProjectBusyError } = await import('../src/server/projects/project-lock.js');
const runState = await import('../src/server/factory/run-state.js');
const { DEFAULT_FACTORY_LIMITS } = await import('../src/server/factory/limits.js');
type EngineDeps = import('../src/server/factory/deps.js').EngineDeps;
type MergeEntry = import('../src/server/factory/merge-sink.js').MergeEntry;
type RunOptions = import('../src/server/agent/claude-run.js').RunOptions;

const ALPHA = 'C:\\projects\\alpha';
const BETA = 'C:\\projects\\beta';
const GAMMA = 'C:\\projects\\gamma';
const T0 = Date.parse('2026-11-26T10:00:00.000Z');

beforeAll(() => {
  loadConfig();
  initDatabase();
});
afterAll(() => closeDatabase());

let clock = T0;
beforeEach(() => {
  clock = T0;
  getDatabase().exec('DELETE FROM factory_runs; DELETE FROM factory_deps; DELETE FROM factory_items');
});
afterEach(() => {
  vi.useRealTimers();
});

interface Run {
  cwd: string;
  prompt: string;
  globs: string[];
  opts: RunOptions;
}

/**
 * Fake deps. `reply(step, n)` answers the nth agent run of a step; `hold` makes
 * every agent run wait until aborted (a long-running unit holding its seat).
 */
function fake(opts: { reply?: (step: string, n: number) => string; hold?: boolean; verify?: (n: number) => boolean } = {}) {
  const runs: Run[] = [];
  const enqueued: MergeEntry[] = [];
  const events: unknown[] = [];
  const commits: string[] = [];
  const ticks: string[] = [];
  let verifyRuns = 0;
  const state = {
    tokens: 0,
    lastSession: null as string | null,
    planUsage: null as EngineDeps['planUsage'] extends (c: string) => infer R ? R : never,
    dirty: [] as string[],
  };
  let sessions = 0;
  const deps: EngineDeps = {
    runClaude: vi.fn(async (cwd: string, prompt: string, globs: string[], o: RunOptions = {}) => {
      runs.push({ cwd, prompt, globs, opts: o });
      const step = o.tag?.stage ?? '?';
      const n = runs.filter((r) => r.opts.tag?.stage === step).length;
      if (opts.hold) {
        await new Promise((_, reject) => {
          if (o.signal?.aborted) reject(new RunAbortedError());
          o.signal?.addEventListener('abort', () => reject(new RunAbortedError()), { once: true });
        });
      }
      const result = opts.reply?.(step, n) ?? (step === 'self-review' ? '{"verdict": "pass", "findings": []}' : `${step} done`);
      return { isError: false, result, permissionDenials: 0, sessionId: o.resumeSessionId ?? `sess-${++sessions}` };
    }) as unknown as EngineDeps['runClaude'],
    prepareWorktree: async (unit) => ({ path: `C:\\wt\\${unit.unitId}`, branch: `factory/${unit.unitId}`, baseBranch: 'main' }),
    dirtyFiles: async () => state.dirty,
    commit: async (_path, message) => {
      commits.push(message);
      return true;
    },
    headCommit: async () => `sha${commits.length}`,
    features: (_cwd, ids) => ids.map((id) => ({ id, title: `Title ${id}`, spec: `project/${id}.md` })),
    verifyCommands: () => ['npm test'],
    runCommand: async () => {
      verifyRuns++;
      const ok = opts.verify ? opts.verify(verifyRuns) : true;
      return { ok, output: ok ? '' : 'FAIL tests/x.test.ts' };
    },
    tickFeature: async (_cwd, _wt, id) => {
      ticks.push(id);
    },
    tokensUsed: () => state.tokens,
    lastSessionOf: () => state.lastSession,
    writeSummary: () => 'summary.md',
    planUsage: () => state.planUsage,
    mergeSink: () => ({ enqueue: (e) => enqueued.push(e) }),
    notify: (e) => events.push(e),
    stepTimeoutMs: () => 60_000,
    now: () => clock,
  };
  return { deps, runs, enqueued, events, commits, ticks, state, verifyRuns: () => verifyRuns };
}

const stepsRun = (runs: Run[]) => runs.map((r) => r.opts.tag?.stage);

function loose(featureId: string, cwd = ALPHA, priority?: number) {
  clock += 1000;
  return store.createItem({ projectCwd: cwd, featureId, trackName: 'Inbox', workflow: 'item', priority }, clock);
}

function trackItem(featureId: string, trackName = 'Factory', cwd = ALPHA) {
  clock += 1000;
  return store.createItem({ projectCwd: cwd, featureId, trackName, workflow: 'track' }, clock);
}

const OWNER = { owner: 'run:test', kind: 'run' as const };

function claimed(featureId: string, cwd = ALPHA) {
  expect(store.claimItem(cwd, featureId, OWNER, clock).ok).toBe(true);
  return {
    ref: { projectCwd: cwd, unitId: featureId, trackName: 'Inbox', isTrack: false, featureIds: [featureId] },
    workflow: 'item',
    owner: OWNER.owner,
    modelTier: null,
  };
}

const signal = () => new AbortController().signal;

describe('runner: one loose item', () => {
  it('runs to review, parks for the user, then hands off to the merge sink once approved', async () => {
    loose('f-aaa111');
    const f = fake();
    const end = await runUnit(claimed('f-aaa111'), f.deps, { signal: signal() });

    expect(end).toEqual({ kind: 'parked', reason: expect.stringMatching(/^review/) });
    // shape is a stub (no run); verify runs commands, not claude.
    expect(stepsRun(f.runs)).toEqual(['implement', 'self-review', 'summary']);
    const item = store.getItem(ALPHA, 'f-aaa111');
    expect(item).toMatchObject({ status: 'parked', step: 'review', claimOwner: null });
    expect(f.commits[0]).toBe('Title f-aaa111\n\nFeature: f-aaa111');

    // implement and summary share the working conversation; self-review does not.
    const [impl, review, summary] = f.runs;
    expect(impl.opts.resumeSessionId).toBeUndefined();
    expect(review.opts.resumeSessionId).toBeUndefined();
    expect(review.globs).toEqual([]);
    expect(summary.opts.resumeSessionId).toBe('sess-1');
    expect(impl.opts.tag).toMatchObject({ projectCwd: ALPHA, kind: 'factory', stage: 'implement' });
    expect(impl.opts.laneKey).toBe(ALPHA);

    releaseParked(ALPHA, 'f-aaa111', { outcome: 'approved' }, f.deps);
    expect(store.getItem(ALPHA, 'f-aaa111')?.status).toBe('open');

    const d = new Dispatcher(f.deps);
    await d.tick();
    await d.idle();
    expect(f.enqueued).toEqual([
      {
        projectCwd: ALPHA,
        kind: 'item',
        branch: 'factory/f-aaa111',
        worktreePath: 'C:\\wt\\f-aaa111',
        baseBranch: 'main',
        featureIds: ['f-aaa111'],
      },
    ]);
    // Left open at step merge with no claim: the queue, not the engine, closes it.
    expect(store.getItem(ALPHA, 'f-aaa111')).toMatchObject({ status: 'open', step: 'merge', claimOwner: null });
    // ...and dispatch does not pick it up again.
    expect(await d.tick()).toEqual([]);
    expect(f.enqueued).toHaveLength(1);
  });

  it('parks at merge, not handed off, when the sink refuses the entry', async () => {
    loose('f-aaa111');
    const f = fake();
    runState.ensureRunState(ALPHA, 'f-aaa111');
    const progress = runState.getRunState(ALPHA, 'f-aaa111')!.progress;
    for (const s of ['shape', 'implement', 'verify', 'self-review', 'summary', 'review']) progress.outcomes[s] = 'done';
    progress.skipped = ['fix'];
    runState.saveRunState(ALPHA, 'f-aaa111', { progress });
    f.deps.mergeSink = () => ({
      enqueue: () => {
        throw new Error('queue full');
      },
    });
    const end = await runUnit(claimed('f-aaa111'), f.deps, { signal: signal() });
    expect(end).toEqual({ kind: 'parked', reason: 'merge failed: queue full' });
    expect(runState.getRunState(ALPHA, 'f-aaa111')?.handedOffAt).toBeNull();
  });

  it('feeds a failing check into fix and re-verifies', async () => {
    loose('f-aaa111');
    const f = fake({ verify: (n) => n > 1 });
    await runUnit(claimed('f-aaa111'), f.deps, { signal: signal() });
    expect(stepsRun(f.runs)).toEqual(['implement', 'self-review', 'fix', 'self-review', 'summary']);
    const fix = f.runs[2];
    expect(fix.prompt).toContain('FAIL tests/x.test.ts');
    expect(fix.opts.resumeSessionId).toBe('sess-1');
    expect(f.verifyRuns()).toBe(2);
  });

  it('parks after two fix loops that do not settle the review', async () => {
    loose('f-aaa111');
    const f = fake({
      reply: (step) => (step === 'self-review' ? '{"verdict": "changes", "findings": ["missing test"]}' : 'ok'),
    });
    const end = await runUnit(claimed('f-aaa111'), f.deps, { signal: signal() });
    expect(end).toMatchObject({ kind: 'parked', reason: expect.stringMatching(/fix ran 2 times/) });
    expect(stepsRun(f.runs).filter((s) => s === 'fix')).toHaveLength(2);
    expect(f.runs.find((r) => r.opts.tag?.stage === 'fix')?.prompt).toContain('missing test');
    expect(store.getItem(ALPHA, 'f-aaa111')).toMatchObject({ status: 'parked', step: 'fix' });

    // Released, the loop gets its runs back rather than re-parking at once.
    releaseParked(ALPHA, 'f-aaa111', {}, f.deps);
    expect(runState.getRunState(ALPHA, 'f-aaa111')?.progress.loops.fix).toBe(0);
  });

  it('skips the steps a unit leaves out', async () => {
    loose('f-aaa111');
    runState.ensureRunState(ALPHA, 'f-aaa111', ['self-review']);
    const f = fake();
    await runUnit(claimed('f-aaa111'), f.deps, { signal: signal() });
    expect(stepsRun(f.runs)).toEqual(['implement', 'summary']);
  });

  it('parks on a failed step, naming it', async () => {
    loose('f-aaa111');
    const f = fake();
    f.deps.prepareWorktree = async () => {
      throw new Error('Track "X" has no branch yet');
    };
    const end = await runUnit(claimed('f-aaa111'), f.deps, { signal: signal() });
    expect(end).toEqual({ kind: 'parked', reason: 'setup failed: Track "X" has no branch yet' });
  });
});

describe('runner: a track as one agent', () => {
  it('works the features in order in one conversation, one commit and one tick each', async () => {
    for (const id of ['f-ttt001', 'f-ttt002', 'f-ttt003']) trackItem(id);
    const f = fake();
    const d = new Dispatcher(f.deps);
    const started = await d.tick();
    await d.idle();

    // One seat for the whole track.
    expect(started).toHaveLength(1);
    expect(stepsRun(f.runs).slice(0, 3)).toEqual(['features', 'features', 'features']);
    expect(f.runs[0].opts.resumeSessionId).toBeUndefined();
    expect(f.runs[1].opts.resumeSessionId).toBe('sess-1');
    expect(f.runs[2].opts.resumeSessionId).toBe('sess-1');
    expect(f.runs[1].prompt).toMatch(/^f-ttt002 is next/);
    expect(f.ticks).toEqual(['f-ttt001', 'f-ttt002', 'f-ttt003']);
    expect(f.commits.slice(0, 3)).toEqual([
      'Title f-ttt001\n\nFeature: f-ttt001',
      'Title f-ttt002\n\nFeature: f-ttt002',
      'Title f-ttt003\n\nFeature: f-ttt003',
    ]);
    for (const id of ['f-ttt001', 'f-ttt002', 'f-ttt003']) {
      expect(store.getItem(ALPHA, id)).toMatchObject({ status: 'parked', step: 'review' });
    }

    releaseParked(ALPHA, 'f-ttt002', { outcome: 'approved' }, f.deps);
    await d.tick();
    await d.idle();
    expect(f.enqueued).toEqual([
      expect.objectContaining({ kind: 'track', trackName: 'Factory', featureIds: ['f-ttt001', 'f-ttt002', 'f-ttt003'] }),
    ]);
  });
});

describe('runner: a track in a shared worktree', () => {
  it('refuses a fresh track whose worktree already has uncommitted changes', async () => {
    trackItem('f-ttt001');
    const f = fake();
    f.state.dirty = ['src/a.ts', 'notes.md'];
    const d = new Dispatcher(f.deps);
    await d.tick();
    await d.idle();
    expect(f.runs).toHaveLength(0);
    expect(f.commits).toHaveLength(0);
    expect(store.getItem(ALPHA, 'f-ttt001')?.status).toBe('parked');
    expect(runState.getRunState(ALPHA, 'track:Factory')?.parkReason).toMatch(/uncommitted changes \(src\/a\.ts, notes\.md\)/);
  });

  it('does not refuse a resumed track: the dirt is its own unfinished step', async () => {
    trackItem('f-ttt001');
    runState.ensureRunState(ALPHA, 'track:Factory');
    const progress = runState.getRunState(ALPHA, 'track:Factory')!.progress;
    progress.current = 'features';
    runState.saveRunState(ALPHA, 'track:Factory', { progress });
    const f = fake();
    f.state.dirty = ['src/a.ts'];
    const d = new Dispatcher(f.deps);
    await d.tick();
    await d.idle();
    expect(stepsRun(f.runs)[0]).toBe('features');
  });

  it('steps aside on a busy project lock, then ticks and commits without re-running the agent', async () => {
    for (const id of ['f-ttt001', 'f-ttt002']) trackItem(id);
    const f = fake();
    let busy = true;
    const tick = f.deps.tickFeature;
    f.deps.tickFeature = async (cwd, wt, id) => {
      if (id === 'f-ttt002' && busy) {
        busy = false;
        throw new ProjectBusyError('This project is busy (Land). Try again when that finishes.');
      }
      return tick(cwd, wt, id);
    };
    const d = new Dispatcher(f.deps);
    await d.tick();
    await d.idle();

    // Gave its claims back, nothing parked, the built feature remembered.
    for (const id of ['f-ttt001', 'f-ttt002']) {
      expect(store.getItem(ALPHA, id)).toMatchObject({ status: 'open', claimOwner: null });
    }
    const progress = runState.getRunState(ALPHA, 'track:Factory')!.progress;
    expect(progress.featuresDone).toEqual(['f-ttt001']);
    expect(progress.featuresBuilt).toEqual(['f-ttt002']);
    expect(progress.current).toBeNull();
    expect(stepsRun(f.runs)).toEqual(['features', 'features']);

    // Cooling down: not claimed straight back into the busy lock.
    expect(await d.tick()).toEqual([]);
    clock += DEFER_MS + 1;
    expect(await d.tick()).toHaveLength(1);
    await d.idle();

    // f-ttt002's agent did not run again; only its tick and commit happened.
    expect(stepsRun(f.runs).filter((s) => s === 'features')).toHaveLength(2);
    expect(f.ticks).toEqual(['f-ttt001', 'f-ttt002']);
    expect(f.commits.filter((c) => c.endsWith('Feature: f-ttt002'))).toHaveLength(1);
    expect(runState.getRunState(ALPHA, 'track:Factory')!.progress.featuresDone).toEqual(['f-ttt001', 'f-ttt002']);
  });
});

describe('resume after a reclaim', () => {
  it('continues the interrupted step in its session and never redoes finished ones', async () => {
    loose('f-aaa111');
    // A run that died inside implement: claimed, progress recorded, then silence.
    expect(store.claimItem(ALPHA, 'f-aaa111', { owner: 'run:dead', kind: 'run' }, clock).ok).toBe(true);
    runState.ensureRunState(ALPHA, 'f-aaa111');
    const progress = runState.getRunState(ALPHA, 'f-aaa111')!.progress;
    progress.outcomes.shape = 'done';
    progress.current = 'implement';
    runState.saveRunState(ALPHA, 'f-aaa111', { progress, lastCommit: 'sha0' });

    const f = fake();
    // Its session was recorded in agent_runs before the spawn, though it never finished.
    f.state.lastSession = 'sess-dead';
    const d = new Dispatcher(f.deps);

    // Lease still live: nothing to claim.
    expect(await d.tick()).toEqual([]);

    clock += LEASE_EXPIRY_MS + 1;
    expect(await d.tick()).toHaveLength(1);
    await d.idle();

    expect(stepsRun(f.runs)[0]).toBe('implement');
    expect(f.runs[0].opts.resumeSessionId).toBe('sess-dead');
    expect(f.runs[0].prompt).toMatch(/^Your previous attempt at this step was interrupted/);
    // Only the interrupted step is told so.
    expect(f.runs.slice(1).every((r) => !r.prompt.includes('was interrupted'))).toBe(true);
    expect(store.getItem(ALPHA, 'f-aaa111')).toMatchObject({ status: 'parked', step: 'review' });
  });

  it('falls back to a fresh run when the session cannot be resumed', async () => {
    loose('f-aaa111');
    const f = fake();
    f.state.lastSession = 'sess-gone';
    const real = f.deps.runClaude;
    f.deps.runClaude = (async (cwd: string, prompt: string, globs: string[], o: RunOptions = {}) => {
      if (o.resumeSessionId === 'sess-gone') throw new Error('No conversation found');
      return real(cwd, prompt, globs, o);
    }) as EngineDeps['runClaude'];
    await runUnit(claimed('f-aaa111'), f.deps, { signal: signal() });
    expect(f.runs[0].opts.resumeSessionId).toBeUndefined();
    expect(f.runs[0].opts.tag?.stage).toBe('implement');
  });

  it('stops without touching the unit once its heartbeat is refused', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    loose('f-aaa111');
    const f = fake({ hold: true });
    const running = runUnit(claimed('f-aaa111'), f.deps, { signal: signal() });
    await vi.waitFor(() => expect(f.runs).toHaveLength(1));

    // Reclaimed and taken by someone else while the run was busy.
    clock += LEASE_EXPIRY_MS + 1;
    store.reclaimExpiredLeases(clock);
    expect(store.claimItem(ALPHA, 'f-aaa111', { owner: 'run:other', kind: 'run' }, clock).ok).toBe(true);
    vi.advanceTimersByTime(LEASE_RENEW_MS);

    expect(await running).toEqual({ kind: 'lost' });
    expect(store.getItem(ALPHA, 'f-aaa111')).toMatchObject({ status: 'in_progress', claimOwner: 'run:other' });
  });

  it('gives back the claims it still holds when one of a track’s features is taken from it', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    for (const id of ['f-ttt001', 'f-ttt002']) trackItem(id);
    const f = fake({ hold: true });
    const d = new Dispatcher(f.deps);
    await d.tick();
    await vi.waitFor(() => expect(f.runs).toHaveLength(1));

    // The user cancels one feature mid-run: its claim is gone, the heartbeat refused.
    store.updateItem(ALPHA, 'f-ttt002', { status: 'cancelled' });
    vi.advanceTimersByTime(LEASE_RENEW_MS);
    await d.idle();

    // The other feature does not keep a seat until its lease expires.
    expect(store.getItem(ALPHA, 'f-ttt001')).toMatchObject({ status: 'open', claimOwner: null });
    expect(store.listItems({ status: ['in_progress'] })).toHaveLength(0);
  });
});

describe('runaway guard', () => {
  it('parks a unit past its token budget between steps, and notifies', async () => {
    loose('f-aaa111');
    const f = fake();
    f.state.tokens = DEFAULT_FACTORY_LIMITS.runawayTokens + 1;
    const end = await runUnit(claimed('f-aaa111'), f.deps, { signal: signal() });
    expect(end).toMatchObject({ kind: 'parked', reason: expect.stringMatching(/^runaway/) });
    expect(f.runs).toHaveLength(0);
    expect(f.events).toContainEqual(expect.objectContaining({ kind: 'runaway', unitId: 'f-aaa111' }));
    expect(store.getItem(ALPHA, 'f-aaa111')?.status).toBe('parked');

    // Released, it gets a fresh allowance from what it has spent so far.
    releaseParked(ALPHA, 'f-aaa111', {}, f.deps);
    expect(runState.getRunState(ALPHA, 'f-aaa111')?.progress.tokenBase).toBe(f.state.tokens);
    const again = await runUnit(claimed('f-aaa111'), f.deps, { signal: signal() });
    expect(again).toMatchObject({ kind: 'parked', reason: expect.stringMatching(/^review/) });
  });

  it('stops a run mid-step once a heartbeat finds it over budget', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    loose('f-aaa111');
    const f = fake({ hold: true });
    const running = runUnit(claimed('f-aaa111'), f.deps, { signal: signal() });
    await vi.waitFor(() => expect(f.runs).toHaveLength(1));
    f.state.tokens = DEFAULT_FACTORY_LIMITS.runawayTokens + 1;
    vi.advanceTimersByTime(LEASE_RENEW_MS);
    expect(await running).toMatchObject({ kind: 'parked', reason: expect.stringMatching(/^runaway/) });
    expect(store.getItem(ALPHA, 'f-aaa111')).toMatchObject({ status: 'parked', step: 'implement' });
  });
});

describe('dispatcher limits', () => {
  it('fills 3 seats across projects and no more', async () => {
    for (const [id, cwd] of [
      ['f-a00001', ALPHA],
      ['f-b00001', BETA],
      ['f-c00001', GAMMA],
      ['f-c00002', GAMMA],
    ] as const) {
      loose(id, cwd);
    }
    const f = fake({ hold: true });
    const d = new Dispatcher(f.deps);
    expect(await d.tick()).toHaveLength(3);
    expect(await d.tick()).toHaveLength(0);
    expect(store.listItems({ status: ['in_progress'] })).toHaveLength(3);
    await d.stop();
    // Stopped runs give their claims back, to resume on the next start.
    expect(store.listItems({ status: ['in_progress'] })).toHaveLength(0);
  });

  it('runs at most 2 units of one project at a time', async () => {
    for (const id of ['f-a00001', 'f-a00002', 'f-a00003']) loose(id);
    loose('f-b00001', BETA);
    const f = fake({ hold: true });
    const d = new Dispatcher(f.deps);
    await d.tick();
    const running = store.listItems({ status: ['in_progress'] });
    expect(running.filter((i) => i.projectCwd === ALPHA)).toHaveLength(2);
    expect(running.filter((i) => i.projectCwd === BETA)).toHaveLength(1);
    await d.stop();
  });

  it('counts a dead run still holding its lease as a seat until it expires', async () => {
    loose('f-a00001');
    loose('f-a00002');
    loose('f-a00003');
    expect(store.claimItem(ALPHA, 'f-a00001', { owner: 'run:dead', kind: 'run' }, clock).ok).toBe(true);
    const f = fake({ hold: true });
    const d = new Dispatcher(f.deps);
    expect(await d.tick()).toHaveLength(1);
    await d.stop();
  });

  it('at start, releases run claims a previous server process left, never its own', async () => {
    loose('f-a00001');
    loose('f-a00002', BETA);
    expect(store.claimItem(ALPHA, 'f-a00001', { owner: 'run:old-boot:1', kind: 'run' }, clock).ok).toBe(true);
    const f = fake({ hold: true });
    const d = new Dispatcher(f.deps);
    await d.tick(); // claims f-a00002 under this boot
    expect(d.recoverOrphans()).toEqual(['f-a00001']);
    expect(store.getItem(ALPHA, 'f-a00001')).toMatchObject({ status: 'open', claimOwner: null });
    expect(store.getItem(BETA, 'f-a00002')?.status).toBe('in_progress');
    // ...and the freed unit is claimed at once, without waiting out the old lease.
    expect(await d.tick()).toHaveLength(1);
    await d.stop();
  });

  it('pauses dispatch while 3 units wait for the user', async () => {
    for (const id of ['f-p00001', 'f-p00002', 'f-p00003']) {
      loose(id);
      store.updateItem(ALPHA, id, { status: 'parked' });
    }
    loose('f-a00001', BETA);
    const f = fake({ hold: true });
    const d = new Dispatcher(f.deps);
    expect(await d.tick()).toEqual([]);
    expect(d.status().paused).toBe('3 waiting for you');

    releaseParked(ALPHA, 'f-p00001', {}, f.deps);
    store.updateItem(ALPHA, 'f-p00001', { status: 'cancelled' });
    expect(await d.tick()).toHaveLength(1);
    await d.stop();
  });

  it('counts a parked track once, however many features it has', async () => {
    for (const id of ['f-t00001', 'f-t00002', 'f-t00003']) {
      trackItem(id);
      store.updateItem(ALPHA, id, { status: 'parked' });
    }
    loose('f-a00001', BETA);
    const f = fake({ hold: true });
    const d = new Dispatcher(f.deps);
    expect(await d.tick()).toHaveLength(1);
    await d.stop();
  });

  it('starts nothing new past the plan-usage cap, but lets running units finish', async () => {
    loose('f-a00001');
    loose('f-a00002', BETA);
    const f = fake();
    const future = clock / 1000 + 3600;
    const reading = (pct: number) => ({ usedPercentage: pct, resetsAt: future, observedAt: '', loginUuid: 'u' });

    // A unit already running when the cap is reached.
    const d = new Dispatcher(f.deps, { ...DEFAULT_FACTORY_LIMITS, seatsPerProject: 1, seats: 1 });
    expect(await d.tick()).toHaveLength(1);
    f.state.planUsage = { fiveHour: reading(85), sevenDay: reading(10) };
    await d.idle();
    expect(store.getItem(ALPHA, 'f-a00001')?.step).toBe('review'); // finished its steps

    expect(await d.tick()).toEqual([]);
    expect(d.status().capped[BETA]).toMatch(/5-hour usage at 85%/);

    f.state.planUsage = { fiveHour: reading(10), sevenDay: reading(92) };
    expect(await d.tick()).toEqual([]);
    expect(d.status().capped[BETA]).toMatch(/weekly/);

    f.state.planUsage = { fiveHour: reading(10), sevenDay: reading(10) };
    expect(await d.tick()).toHaveLength(1);
    await d.idle();
  });

  it('takes the most urgent ready item first', async () => {
    loose('f-low001', ALPHA, 3);
    loose('f-hi0001', ALPHA, 1);
    const f = fake({ hold: true });
    const d = new Dispatcher(f.deps, { ...DEFAULT_FACTORY_LIMITS, seats: 1 });
    await d.tick();
    expect(store.getItem(ALPHA, 'f-hi0001')?.status).toBe('in_progress');
    expect(store.getItem(ALPHA, 'f-low001')?.status).toBe('open');
    await d.stop();
  });
});
