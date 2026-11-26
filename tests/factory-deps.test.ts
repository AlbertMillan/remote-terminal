import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { writeFileSync } from 'fs';
import { join } from 'path';
import { makeTmpDataDir } from './helpers/tmp-data-dir.js';

/**
 * The factory's real EngineDeps (factory/deps.ts, f-uwj3b0): the pieces the
 * engine tests replace with fakes. Worktree creation and dependency installs
 * are mocked; the ledger and the project lock are real.
 */

const { installDependencies, needsInstall } = vi.hoisted(() => ({
  installDependencies: vi.fn(),
  needsInstall: vi.fn(),
}));
vi.mock('../src/server/projects/project-deps.js', () => ({ installDependencies, needsInstall }));
vi.mock('../src/server/jobs/worktree.js', async (importActual) => ({
  ...(await importActual<typeof import('../src/server/jobs/worktree.js')>()),
  createWorktree: vi.fn(async (_cwd: string, _id: string, _title: string, target: { path: string; branch: string }) => ({
    path: target.path,
    branch: target.branch,
    baseBranch: 'main',
    initialisedRepo: false,
  })),
}));

const dataDir = makeTmpDataDir('factory-deps');
const configPath = join(dataDir, 'config.json');
writeFileSync(configPath, JSON.stringify({ persistence: { dataDir } }));
process.env.CLAUDE_REMOTE_CONFIG = configPath;

const { loadConfig } = await import('../src/server/config.js');
const { initDatabase, closeDatabase, getDatabase } = await import('../src/server/db/schema.js');
const { defaultEngineDeps, unitTokens } = await import('../src/server/factory/deps.js');
const { ProjectBusyError, withProjectLock } = await import('../src/server/projects/project-lock.js');

const PROJECT = 'C:\\projects\\alpha';

beforeAll(() => {
  loadConfig();
  initDatabase();
});
afterAll(() => closeDatabase());
beforeEach(() => {
  installDependencies.mockReset();
  needsInstall.mockReset();
  getDatabase().exec('DELETE FROM usage_messages');
});

const unit = {
  projectCwd: PROJECT,
  unitId: 'f-aaa111',
  trackName: 'Inbox',
  isTrack: false,
  featureIds: ['f-aaa111'],
};

describe('prepareWorktree', () => {
  it('installs a new worktree’s dependencies from its lockfile, with the run’s signal', async () => {
    needsInstall.mockReturnValue(true);
    installDependencies.mockResolvedValue({ ran: true, ok: true, detail: 'npm ci' });
    const signal = new AbortController().signal;
    const wt = await defaultEngineDeps().prepareWorktree(unit, 'Do the thing', signal);
    expect(wt.branch).toBe('factory/do-the-thing-f-aaa111');
    expect(installDependencies).toHaveBeenCalledWith(wt.path, signal);
  });

  it('fails the run when the install fails, rather than verifying against no node_modules', async () => {
    needsInstall.mockReturnValue(true);
    installDependencies.mockResolvedValue({ ran: true, ok: false, detail: 'ERESOLVE' });
    await expect(defaultEngineDeps().prepareWorktree(unit, 'x', new AbortController().signal)).rejects.toThrow(
      /Installing dependencies failed: ERESOLVE/
    );
  });

  it('does not reinstall a worktree that already has its dependencies', async () => {
    needsInstall.mockReturnValue(false);
    await defaultEngineDeps().prepareWorktree(unit, 'x', new AbortController().signal);
    expect(installDependencies).not.toHaveBeenCalled();
  });
});

describe('tickFeature', () => {
  it('never waits on the project lock: a held lock throws ProjectBusyError at once', async () => {
    let release!: () => void;
    const held = withProjectLock(PROJECT, 'Land', () => new Promise<void>((r) => (release = r)));
    const started = Date.now();
    await expect(defaultEngineDeps().tickFeature(PROJECT, join(dataDir, 'wt'), 'f-aaa111')).rejects.toBeInstanceOf(
      ProjectBusyError
    );
    expect(Date.now() - started).toBeLessThan(1000);
    release();
    await held;
  });
});

describe('unitTokens (the runaway guard’s count)', () => {
  it('counts input, output and cache writes, never cache reads', () => {
    const insert = getDatabase().prepare(
      `INSERT INTO usage_messages (message_id, session_id, project_cwd, job_id, model, ts, input_tokens,
         output_tokens, cache_read_tokens, cache_write_5m_tokens, cache_write_1h_tokens)
       VALUES (?, 's', ?, ?, 'claude-opus-5-5', '2026-11-26T10:00:00Z', ?, ?, ?, ?, ?)`
    );
    insert.run('m1', PROJECT, 'factory:abc:f-aaa111', 100, 200, 5_000_000, 30, 40);
    insert.run('m2', PROJECT, 'factory:abc:f-aaa111', 1, 2, 9_000_000, 3, 4);
    insert.run('m3', PROJECT, 'factory:abc:other', 1000, 1000, 0, 0, 0);
    expect(unitTokens('factory:abc:f-aaa111')).toBe(100 + 200 + 30 + 40 + 1 + 2 + 3 + 4);
    expect(unitTokens('factory:abc:none')).toBe(0);
  });
});
