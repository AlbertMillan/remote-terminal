import { describe, it, expect, beforeEach, beforeAll, afterAll, vi } from 'vitest';
import { execFileSync } from 'child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { makeTmpDataDir } from './helpers/tmp-data-dir.js';

// One test drives real git (a worktree created and torn down); a loaded machine needs the room.
vi.setConfig({ testTimeout: 60_000 });

/**
 * Cancel a factory unit (factory/cancel.ts): a running unit's items are closed
 * first and its run aborted and awaited; a parked one is closed without a run;
 * a unit a terminal session holds is refused, naming the session; a loose item's
 * worktree and branch go under removeWorktree's rules while a track's stay; a
 * parked merge entry is dropped and a running one refuses. The PROJECT.md line
 * is never ticked (nothing here writes one).
 */

const dataDir = makeTmpDataDir('factory-cancel');
const configPath = join(dataDir, 'config.json');
writeFileSync(configPath, JSON.stringify({ persistence: { dataDir } }));
process.env.CLAUDE_REMOTE_CONFIG = configPath;

const { loadConfig } = await import('../src/server/config.js');
const { initDatabase, closeDatabase, getDatabase } = await import('../src/server/db/schema.js');
const store = await import('../src/server/factory/store.js');
const runState = await import('../src/server/factory/run-state.js');
const claims = await import('../src/server/factory/session-claims.js');
const mergeStore = await import('../src/server/factory/merge-queue-store.js');
const { RunAbortedError } = await import('../src/server/agent/claude-run.js');
const { Dispatcher } = await import('../src/server/factory/dispatcher.js');
const { DEFAULT_FACTORY_LIMITS } = await import('../src/server/factory/limits.js');
const { cancelUnit, cancelRefusal, defaultCancelDeps } = await import('../src/server/factory/cancel.js');
const { createWorktree, worktreePathFor } = await import('../src/server/worktrees/worktree.js');
type EngineDeps = import('../src/server/factory/deps.js').EngineDeps;
type RunOptions = import('../src/server/agent/claude-run.js').RunOptions;
type CancelDeps = import('../src/server/factory/cancel.js').CancelDeps;

const ALPHA = 'C:\\projects\\alpha';
const WT = join(dataDir, 'wt');
mkdirSync(WT, { recursive: true });

beforeAll(() => {
  loadConfig();
  initDatabase();
});
afterAll(() => closeDatabase());

beforeEach(() => {
  getDatabase().exec(
    'DELETE FROM factory_session_claims; DELETE FROM factory_runs; DELETE FROM factory_deps; DELETE FROM factory_items; DELETE FROM factory_merges; DELETE FROM agent_runs'
  );
});

/** Engine deps whose agent runs wait until aborted, recording the abort. */
function engine() {
  const runs: string[] = [];
  const unwound: string[] = [];
  const deps: EngineDeps = {
    runClaude: vi.fn(async (_cwd: string, _prompt: string, _globs: string[], o: RunOptions = {}) => {
      runs.push(o.tag?.stage ?? '?');
      await new Promise((_, reject) => {
        const abort = () => {
          // A dying `claude` takes a moment to let go of its files.
          setTimeout(() => {
            unwound.push(o.tag?.stage ?? '?');
            reject(new RunAbortedError());
          }, 20);
        };
        if (o.signal?.aborted) abort();
        o.signal?.addEventListener('abort', abort, { once: true });
      });
      return { isError: false, result: '', permissionDenials: 0, sessionId: 'sess-1' };
    }) as unknown as EngineDeps['runClaude'],
    prepareWorktree: async () => ({ path: WT, branch: 'factory/x', baseBranch: 'main' }),
    dirtyFiles: async () => [],
    commit: async () => true,
    headCommit: async () => 'sha1',
    features: (_cwd, ids) => ids.map((id) => ({ id, title: `Title ${id}`, spec: null })),
    verifyCommands: () => [],
    runCommand: async () => ({ ok: true, output: '' }),
    tickFeature: async () => {},
    tokensUsed: () => 0,
    lastSessionOf: () => null,
    writeSummary: () => join(dataDir, 'factory', 'summary.md'),
    planUsage: () => null,
    mergeSink: () => ({ enqueue: () => {} }),
    notify: () => {},
    stepTimeoutMs: () => 60_000,
    now: () => Date.now(),
  };
  return { deps, runs, unwound };
}

/** Cancel deps around a dispatcher, recording every teardown. */
function cancelDeps(dispatcher: InstanceType<typeof Dispatcher> | null) {
  const teardowns: { featureId: string; path: string; branch: string | null }[] = [];
  const order: string[] = [];
  const deps: CancelDeps = {
    stopUnit: async (key) => {
      order.push('stop');
      const stopped = dispatcher ? await dispatcher.stopUnit(key) : false;
      order.push('stopped');
      return stopped;
    },
    teardown: async (_cwd, featureId, { path, branch }) => {
      order.push('teardown');
      teardowns.push({ featureId, path, branch });
      return { removed: true, branchDeleted: branch !== null, linksLeft: [] };
    },
    sessionName: (id) => (id === 's-1' ? 'builder' : null),
    now: () => Date.now(),
  };
  return { deps, teardowns, order };
}

/** A loose item past shaping with a worktree recorded, as if it had run. */
function shapedLoose(featureId: string) {
  store.createItem({ projectCwd: ALPHA, featureId, trackName: 'Inbox', workflow: 'item', step: null });
  const state = runState.ensureRunState(ALPHA, featureId);
  state.progress.outcomes.shape = 'done';
  runState.saveRunState(ALPHA, featureId, { progress: state.progress, worktreePath: WT, branch: 'factory/x', baseBranch: 'main' });
}

const limits = { ...DEFAULT_FACTORY_LIMITS, pauseWhenParked: 99 };
const until = async (cond: () => boolean) => {
  for (let i = 0; i < 400 && !cond(); i++) await new Promise((r) => setTimeout(r, 5));
  expect(cond()).toBe(true);
};

describe('cancel a running unit', () => {
  it('closes its items first, then aborts and awaits the run, then tears its worktree down', async () => {
    shapedLoose('f-aaa111');
    const e = engine();
    const d = new Dispatcher(e.deps, limits);
    await d.tick();
    await until(() => e.runs.length === 1);
    expect(store.getItem(ALPHA, 'f-aaa111')?.claimKind).toBe('run');

    const c = cancelDeps(d);
    const result = await cancelUnit(ALPHA, 'f-aaa111', c.deps);

    expect(result).toMatchObject({ unitId: 'f-aaa111', featureIds: ['f-aaa111'], stoppedRun: true, worktreeRemoved: true, branchDeleted: true });
    // The run had unwound (its agent call rejected) before the worktree was touched.
    expect(e.unwound).toHaveLength(1);
    expect(c.order).toEqual(['stop', 'stopped', 'teardown']);
    expect(c.teardowns).toEqual([{ featureId: 'f-aaa111', path: WT, branch: 'factory/x' }]);
    const item = store.getItem(ALPHA, 'f-aaa111');
    expect(item?.status).toBe('cancelled');
    expect(item?.claimOwner).toBeNull();
    // The unwinding run's release is owner-checked: it never reopened the item.
    await d.idle();
    expect(store.getItem(ALPHA, 'f-aaa111')?.status).toBe('cancelled');
    expect(runState.getRunState(ALPHA, 'f-aaa111')).toBeNull();
    // Never claimed again.
    expect(await d.tick()).toEqual([]);
  });

  it('stops every feature of a running track, and keeps the track worktree', async () => {
    store.createItem({ projectCwd: ALPHA, featureId: 'f-ttt001', trackName: 'Search', workflow: 'track' });
    store.createItem({ projectCwd: ALPHA, featureId: 'f-ttt002', trackName: 'Search', workflow: 'track' });
    const e = engine();
    const d = new Dispatcher(e.deps, limits);
    await d.tick();
    await until(() => e.runs.length === 1);

    const c = cancelDeps(d);
    const result = await cancelUnit(ALPHA, 'f-ttt002', c.deps);

    expect(result).toMatchObject({ unitId: 'track:Search', stoppedRun: true, worktreeRemoved: false });
    expect(result.featureIds.sort()).toEqual(['f-ttt001', 'f-ttt002']);
    expect(c.teardowns).toEqual([]);
    expect(store.getItem(ALPHA, 'f-ttt001')?.status).toBe('cancelled');
    expect(store.getItem(ALPHA, 'f-ttt002')?.status).toBe('cancelled');
    expect(runState.getRunState(ALPHA, 'track:Search')?.parkReason).toBe('cancelled');
    await d.idle();
  });
});

describe('cancel a parked unit', () => {
  it('closes it without a run to stop', async () => {
    shapedLoose('f-bbb222');
    store.updateItem(ALPHA, 'f-bbb222', { status: 'parked', step: 'review' });
    const c = cancelDeps(null);

    const result = await cancelUnit(ALPHA, 'f-bbb222', c.deps);

    expect(result.stoppedRun).toBe(false);
    expect(store.getItem(ALPHA, 'f-bbb222')?.status).toBe('cancelled');
    expect(c.teardowns).toHaveLength(1);
  });

  it('drops a parked merge entry so Retry merge cannot land cancelled work', async () => {
    shapedLoose('f-ccc333');
    const merge = mergeStore.insertMerge({ projectCwd: ALPHA, kind: 'item', branch: 'factory/x', worktreePath: WT, baseBranch: 'main', featureIds: ['f-ccc333'] });
    mergeStore.updateMerge(merge.id, { status: 'parked', detail: 'conflict' });
    runState.saveRunState(ALPHA, 'f-ccc333', { handedOffAt: new Date().toISOString() });
    store.updateItem(ALPHA, 'f-ccc333', { status: 'parked', step: 'merge' });

    const result = await cancelUnit(ALPHA, 'f-ccc333', cancelDeps(null).deps);

    expect(result.mergeDropped).toBe(true);
    expect(mergeStore.getMerge(merge.id)).toBeNull();
  });

  it('refuses while its merge is running, changing nothing', async () => {
    shapedLoose('f-ddd444');
    const merge = mergeStore.insertMerge({ projectCwd: ALPHA, kind: 'item', branch: 'factory/x', worktreePath: WT, baseBranch: 'main', featureIds: ['f-ddd444'] });
    mergeStore.updateMerge(merge.id, { status: 'running' });
    runState.saveRunState(ALPHA, 'f-ddd444', { handedOffAt: new Date().toISOString() });

    await expect(cancelUnit(ALPHA, 'f-ddd444', cancelDeps(null).deps)).rejects.toMatchObject({ status: 409 });
    expect(store.getItem(ALPHA, 'f-ddd444')?.status).toBe('open');
  });
});

describe('a unit a terminal session holds', () => {
  it('is refused, naming the session, and nothing changes', async () => {
    shapedLoose('f-eee555');
    expect(store.claimForSession(ALPHA, ['f-eee555'], claims.sessionOwner('s-1')).ok).toBe(true);
    const c = cancelDeps(null);

    const refused = cancelRefusal(ALPHA, 'f-eee555', c.deps);
    expect(refused?.status).toBe(409);
    expect(refused?.message).toContain('"builder" (s-1)');
    await expect(cancelUnit(ALPHA, 'f-eee555', c.deps)).rejects.toThrow('"builder" (s-1)');
    expect(store.getItem(ALPHA, 'f-eee555')?.status).toBe('in_progress');
    expect(c.order).toEqual([]);
  });

  it('is unknown work once closed', async () => {
    shapedLoose('f-fff666');
    store.updateItem(ALPHA, 'f-fff666', { status: 'done' });
    await expect(cancelUnit(ALPHA, 'f-fff666', cancelDeps(null).deps)).rejects.toMatchObject({ status: 404 });
  });
});

describe('worktree teardown, for real', () => {
  it("removes a loose item's worktree and branch with removeWorktree's rules", async () => {
    const repo = mkdtempSync(join(tmpdir(), 'cr-cancel-repo-'));
    const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, encoding: 'utf-8' }).trim();
    try {
      git('init', '-q', '-b', 'main');
      git('config', 'user.email', 'test@example.com');
      git('config', 'user.name', 'Test');
      git('config', 'commit.gpgsign', 'false');
      writeFileSync(join(repo, 'a.txt'), 'a\n');
      git('add', '.');
      git('commit', '-q', '-m', 'init');
      const wt = await createWorktree(repo, 'f-ggg777', 'Real', { path: worktreePathFor('factory-f-ggg777'), branch: 'factory/real-f-ggg777' });
      writeFileSync(join(wt.path, 'wip.txt'), 'uncommitted\n');
      store.createItem({ projectCwd: repo, featureId: 'f-ggg777', trackName: 'Inbox', workflow: 'item', step: null });
      runState.ensureRunState(repo, 'f-ggg777');
      runState.saveRunState(repo, 'f-ggg777', { worktreePath: wt.path, branch: wt.branch, baseBranch: 'main' });
      store.updateItem(repo, 'f-ggg777', { status: 'parked', step: 'verify' });

      const result = await cancelUnit(repo, 'f-ggg777', { ...defaultCancelDeps, stopUnit: async () => false });

      expect(result).toMatchObject({ worktreeRemoved: true, branchDeleted: true, note: null });
      expect(existsSync(wt.path)).toBe(false);
      expect(git('branch', '--list', wt.branch)).toBe('');
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});
