import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { execFileSync } from 'child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

/**
 * Turning the factory on (factory-boot.ts): the merge sink goes to the real
 * queue and dispatch starts, except under vitest; a merged loose item's
 * worktree is torn down, a parked one's kept, a track's left to Land.
 */

const dataDir = mkdtempSync(join(tmpdir(), 'cr-factory-boot-data-'));
const configPath = join(dataDir, 'config.json');
writeFileSync(configPath, JSON.stringify({ persistence: { dataDir } }));
process.env.CLAUDE_REMOTE_CONFIG = configPath;

const { loadConfig } = await import('../src/server/config.js');
const { initDatabase, closeDatabase } = await import('../src/server/db/schema.js');
const boot = await import('../src/server/factory/factory-boot.js');
const { getMergeSink, setMergeSink, loggingMergeSink } = await import('../src/server/factory/merge-sink.js');
const { getDispatcher, stopFactory } = await import('../src/server/factory/dispatcher.js');
const { insertMerge, updateMerge } = await import('../src/server/factory/merge-queue-store.js');
type MergeEntry = import('../src/server/factory/merge-sink.js').MergeEntry;
type MergeOutcome = import('../src/server/factory/merge-queue.js').MergeOutcome;

beforeAll(() => {
  loadConfig();
  initDatabase();
});

afterAll(() => {
  closeDatabase();
  rmSync(dataDir, { recursive: true, force: true });
});

afterEach(async () => {
  await stopFactory();
  setMergeSink(loggingMergeSink);
});

const entry = (kind: MergeEntry['kind'] = 'item', worktreePath = 'C:\\wt\\f-aaaaaa', branch = 'factory/x-f-aaaaaa'): MergeEntry => ({
  projectCwd: 'C:\\projects\\alpha',
  kind,
  branch,
  worktreePath,
  baseBranch: 'main',
  featureIds: ['f-aaaaaa'],
});

function fakeSink(status: MergeOutcome['status']) {
  const enqueued: MergeEntry[] = [];
  const tornDown: MergeEntry[] = [];
  const deps = {
    enqueue: (e: MergeEntry) => {
      enqueued.push(e);
      const outcome = { id: 'mq-1', status, mergeSha: null, detail: '', conflict: null, error: null, land: null } as MergeOutcome;
      return { id: 'mq-1', position: 0, done: Promise.resolve(outcome) };
    },
    teardown: async (e: MergeEntry) => {
      tornDown.push(e);
      return { removed: true, branchDeleted: true, linksLeft: [] };
    },
  };
  return { deps, enqueued, tornDown };
}

describe('startFactoryAtBoot', () => {
  it('does nothing under vitest', () => {
    expect(boot.startFactoryAtBoot({ VITEST: 'true' })).toBe(false);
    expect(getMergeSink()).toBe(loggingMergeSink);
    expect(getDispatcher()).toBeNull();
  });

  it('installs the queue as the sink and starts dispatch, an isolated boot included', async () => {
    const f = fakeSink('merged');
    expect(boot.startFactoryAtBoot({ CLAUDE_REMOTE_CONFIG: configPath }, f.deps)).toBe(true);
    expect(getDispatcher()).not.toBeNull();
    getMergeSink().enqueue(entry());
    expect(f.enqueued).toEqual([entry()]);
  });
});

describe('the factory merge sink', () => {
  it("tears a merged item's worktree down, keeps a parked one's, and leaves a track's to Land", async () => {
    for (const [status, kind, expected] of [
      ['merged', 'item', 1],
      ['parked', 'item', 0],
      ['merged', 'track', 0],
    ] as const) {
      const f = fakeSink(status);
      boot.factoryMergeSink(f.deps).enqueue(entry(kind));
      await new Promise((r) => setTimeout(r, 10));
      expect(f.tornDown, `${status} ${kind}`).toHaveLength(expected);
    }
  });

  it('sweeps, at boot, merged items whose worktree is still there, and nothing else', async () => {
    const left = mkdtempSync(join(tmpdir(), 'cr-factory-boot-left-'));
    const parkedDir = mkdtempSync(join(tmpdir(), 'cr-factory-boot-parked-'));
    try {
      const merged = insertMerge(entry('item', left, 'factory/left'));
      updateMerge(merged.id, { status: 'merged' });
      const gone = insertMerge(entry('item', join(left, 'no-such-folder'), 'factory/gone'));
      updateMerge(gone.id, { status: 'merged' });
      const parked = insertMerge(entry('item', parkedDir, 'factory/parked'));
      updateMerge(parked.id, { status: 'parked' });
      const track = insertMerge(entry('track', parkedDir, 'track/t'));
      updateMerge(track.id, { status: 'merged' });

      const f = fakeSink('merged');
      expect(await boot.sweepMergedWorktrees(f.deps)).toEqual([left]);
      expect(f.tornDown.map((e) => e.branch)).toEqual(['factory/left']);
    } finally {
      rmSync(left, { recursive: true, force: true });
      rmSync(parkedDir, { recursive: true, force: true });
    }
  });

  it('removes the real worktree and its merged branch', async () => {
    const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf-8' }).trim();
    const repo = mkdtempSync(join(tmpdir(), 'cr-factory-boot-repo-'));
    const scratch = mkdtempSync(join(tmpdir(), 'cr-factory-boot-wt-'));
    try {
      git(repo, 'init', '-q', '-b', 'main');
      git(repo, 'config', 'user.email', 'test@example.com');
      git(repo, 'config', 'user.name', 'Test');
      writeFileSync(join(repo, 'a.txt'), 'a\n');
      git(repo, 'add', '.');
      git(repo, 'commit', '-q', '-m', 'init');
      const wt = join(scratch, 'factory-f-aaaaaa');
      git(repo, 'worktree', 'add', '-q', '-b', 'factory/x-f-aaaaaa', wt, 'main');

      const result = await boot.defaultSinkDeps.teardown({ ...entry('item', wt), projectCwd: repo });
      expect(result).toMatchObject({ removed: true, branchDeleted: true, linksLeft: [] });
      expect(existsSync(wt)).toBe(false);
      expect(git(repo, 'branch', '--list', 'factory/*')).toBe('');
    } finally {
      rmSync(repo, { recursive: true, force: true });
      rmSync(scratch, { recursive: true, force: true });
    }
  });
});
