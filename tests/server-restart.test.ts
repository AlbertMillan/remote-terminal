import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import Fastify from 'fastify';
import { execFileSync } from 'child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  BOOT_ID,
  createBuildStateChecker,
  readBuildStamp,
  registerServerRestartRoutes,
  restartAvailability,
  restartHint,
  type ServerRestartDeps,
} from '../src/server/server-restart.js';
import { chipView, waitForNewBoot, type BuildStatus, type ServerStatus } from '../src/client/server-restart.js';

/**
 * Restart from the UI kills every terminal, so the route must refuse anything
 * but the page this server served, must not restart when the requested build
 * fails, and must launch exactly once.
 */

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'cr-restart-'));
  writeFileSync(join(root, 'restart-server.vbs'), "' test");
  // Only setTimeout: Fastify parses request bodies on setImmediate.
  vi.useFakeTimers({ toFake: ['setTimeout'] });
});

afterEach(() => {
  vi.useRealTimers();
  rmSync(root, { recursive: true, force: true });
});

function deps(overrides: Partial<ServerRestartDeps> = {}): ServerRestartDeps & {
  launch: ReturnType<typeof vi.fn>;
  build: ReturnType<typeof vi.fn>;
} {
  return {
    projectRoot: root,
    port: 4220,
    entryScript: join(root, 'dist', 'server', 'index.js'),
    platform: 'win32',
    build: vi.fn(async () => ({ ran: true, ok: true, detail: 'build passed' })),
    launch: vi.fn(),
    verify: vi.fn(async () => ({ userId: 'me' })),
    ...overrides,
  } as never;
}

async function appWith(d: ServerRestartDeps) {
  const app = Fastify();
  registerServerRestartRoutes(app, d);
  await app.ready();
  return app;
}

const SAME_ORIGIN = { origin: 'http://localhost:4220', host: 'localhost:4220' };

describe('restartAvailability', () => {
  it('needs Windows, the launcher, and a server running from dist/', () => {
    expect(restartAvailability(deps()).canRestart).toBe(true);
    expect(restartAvailability(deps({ platform: 'linux' })).canRestart).toBe(false);
    // A second instance (isolated QA boot): the script would stop and replace the live one.
    expect(restartAvailability(deps({ port: 4399 })).reason).toMatch(/4399/);
    expect(restartAvailability(deps({ entryScript: join(root, 'src', 'server', 'index.ts') })).canRestart).toBe(false);
    rmSync(join(root, 'restart-server.vbs'));
    expect(restartAvailability(deps()).reason).toMatch(/restart-server\.vbs/);
  });
});

describe('POST /api/server/restart', () => {
  it('reports the boot id and availability', async () => {
    const app = await appWith(deps());
    const res = await app.inject({ method: 'GET', url: '/api/server/status' });
    expect(res.json()).toMatchObject({ bootId: BOOT_ID, canRestart: true, reason: null });
    // An unstamped dist/ (built before stamps existed) shows nothing.
    expect(res.json().build).toMatchObject({ state: 'unknown', running: null, onDisk: null });
  });

  it('reports the build state of a stamped dist/ the server runs', async () => {
    const d = deps();
    stamp(root, 'a'.repeat(40), '2026-10-03T00:00:00.000Z');
    const app = await appWith(d);
    const res = await app.inject({ method: 'GET', url: '/api/server/status' });
    // The running stamp was read at registration; the temp root is no git repo.
    expect(res.json().build).toMatchObject({
      state: 'unknown',
      running: { sha: 'a'.repeat(40) },
      reason: expect.stringMatching(/git could not compare/),
    });
  });

  it('refuses a cross-origin request and an unverified caller', async () => {
    const d = deps();
    const app = await appWith(d);
    const cross = await app.inject({
      method: 'POST', url: '/api/server/restart',
      headers: { origin: 'https://evil.example', host: 'localhost:4220' },
    });
    expect(cross.statusCode).toBe(403);

    const unverified = await appWith(deps({ verify: async () => null }));
    const res = await unverified.inject({ method: 'POST', url: '/api/server/restart', headers: SAME_ORIGIN });
    expect(res.statusCode).toBe(403);
    vi.runAllTimers();
    expect(d.launch).not.toHaveBeenCalled();
  });

  it('restarts without building by default, and only once', async () => {
    const d = deps();
    const app = await appWith(d);
    const res = await app.inject({ method: 'POST', url: '/api/server/restart', headers: SAME_ORIGIN });
    expect(res.statusCode).toBe(202);
    expect(res.json()).toMatchObject({ restarting: true, built: false, bootId: BOOT_ID });
    expect(d.build).not.toHaveBeenCalled();
    vi.runAllTimers();
    expect(d.launch).toHaveBeenCalledWith(join(root, 'restart-server.vbs'));

    const again = await app.inject({ method: 'POST', url: '/api/server/restart', headers: SAME_ORIGIN });
    expect(again.statusCode).toBe(409);
    vi.runAllTimers();
    expect(d.launch).toHaveBeenCalledTimes(1);
  });

  it('builds first and restarts only when the build passes', async () => {
    const failing = deps({ build: vi.fn(async () => ({ ran: true, ok: false, detail: 'build failed: TS2304' })) });
    const app = await appWith(failing);
    const res = await app.inject({
      method: 'POST', url: '/api/server/restart', headers: SAME_ORIGIN, payload: { build: true },
    });
    expect(res.statusCode).toBe(500);
    expect(res.json().detail).toMatch(/TS2304/);
    vi.runAllTimers();
    expect(failing.launch).not.toHaveBeenCalled();

    // The server stayed up, so a retry after fixing the build goes through.
    failing.build.mockResolvedValueOnce({ ran: true, ok: true, detail: 'build passed' });
    const retry = await app.inject({
      method: 'POST', url: '/api/server/restart', headers: SAME_ORIGIN, payload: { build: true },
    });
    expect(retry.statusCode).toBe(202);
    expect(retry.json().built).toBe(true);
    vi.runAllTimers();
    expect(failing.launch).toHaveBeenCalledTimes(1);
  });

  it('refuses in dev mode, where the script would not stop the server', async () => {
    const d = deps({ entryScript: join(root, 'node_modules', 'tsx', 'cli.mjs') });
    const app = await appWith(d);
    const res = await app.inject({ method: 'POST', url: '/api/server/restart', headers: SAME_ORIGIN });
    expect(res.statusCode).toBe(409);
  });
});

describe('waitForNewBoot', () => {
  const noSleep = async () => {};

  it('waits past the old server still answering and the gap while it is down', async () => {
    const replies = [{ bootId: 'old' }, null, null, { bootId: 'new' }];
    const poll = vi.fn(async () => (replies.shift() as never) ?? null);
    expect(await waitForNewBoot('old', poll, { intervalMs: 1, limitMs: 100, sleep: noSleep })).toBe(true);
    expect(poll).toHaveBeenCalledTimes(4);
  });

  it('gives up when the server never comes back', async () => {
    const poll = vi.fn(async () => null);
    expect(await waitForNewBoot('old', poll, { intervalMs: 10, limitMs: 50, sleep: noSleep })).toBe(false);
  });
});

/** Writes dist/build-info.json as scripts/write-build-info.mjs does. */
function stamp(projectRoot: string, sha: string, builtAt: string): void {
  mkdirSync(join(projectRoot, 'dist'), { recursive: true });
  writeFileSync(join(projectRoot, 'dist', 'build-info.json'), JSON.stringify({ sha, builtAt }));
}

describe('build state (server behind its build)', () => {
  // A real repository: "a build input changed in a commit" is a property of git.
  let repo: string;
  const git = (...args: string[]): string => execFileSync('git', args, { cwd: repo, encoding: 'utf-8' }).trim();
  const commit = (rel: string, content: string): string => {
    mkdirSync(join(repo, rel, '..'), { recursive: true });
    writeFileSync(join(repo, rel), content);
    git('add', '--', rel);
    git('commit', '-q', '-m', `edit ${rel}`);
    return git('rev-parse', 'HEAD');
  };

  beforeEach(() => {
    vi.useRealTimers();
    repo = mkdtempSync(join(tmpdir(), 'cr-build-state-'));
    git('init', '-q', '-b', 'main');
    git('config', 'user.email', 'test@example.com');
    git('config', 'user.name', 'Test');
    git('config', 'commit.gpgsign', 'false');
    writeFileSync(join(repo, '.gitignore'), 'dist/\n');
    git('add', '.gitignore');
    commit('src/server/index.ts', 'export {};\n');
  });

  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
  });

  const built = (builtAt = '2026-10-03T10:00:00.000Z') => {
    const s = { sha: git('rev-parse', 'HEAD'), builtAt };
    stamp(repo, s.sha, s.builtAt);
    return s;
  };

  it('is current when the server runs the build on disk and no input changed', async () => {
    const running = built();
    expect((await createBuildStateChecker(repo, running).check()).state).toBe('current');
  });

  it('asks for a restart when dist/ holds a newer build than the running one', async () => {
    const running = built('2026-10-03T09:00:00.000Z');
    built('2026-10-03T10:00:00.000Z'); // rebuilt since, same commit
    const status = await createBuildStateChecker(repo, running).check();
    expect(status.state).toBe('restart');
    expect(status.reason).toMatch(/dist\/ holds/);
  });

  it('asks for a rebuild after a commit to src/', async () => {
    const running = built();
    commit('src/server/app.ts', 'export const x = 1;\n');
    const status = await createBuildStateChecker(repo, running).check();
    expect(status.state).toBe('rebuild');
    expect(status.reason).toContain('src/server/app.ts');
  });

  it('stays current after a docs-only commit', async () => {
    const running = built();
    commit('PROJECT.md', '## Track: X\n');
    commit('project/spec.md', '# Spec\n');
    commit('docs/notes.md', 'notes\n');
    expect((await createBuildStateChecker(repo, running).check()).state).toBe('current');
  });

  it('ignores uncommitted edits: they say nothing about what landed', async () => {
    const running = built();
    writeFileSync(join(repo, 'src', 'server', 'index.ts'), 'export const dirty = 1;\n');
    expect((await createBuildStateChecker(repo, running).check()).state).toBe('current');
  });

  it('counts every build input, not only src/', async () => {
    for (const rel of ['package.json', 'package-lock.json', 'tsconfig.client.json', 'scripts/copy-client-assets.mjs']) {
      const running = built();
      commit(rel, `{"edit":"${rel}"}\n`);
      expect((await createBuildStateChecker(repo, running).check()).state, rel).toBe('rebuild');
    }
  });

  it('is unknown with no stamp on disk, or none for the running build', async () => {
    const running = built();
    rmSync(join(repo, 'dist'), { recursive: true, force: true });
    expect((await createBuildStateChecker(repo, running).check()).state).toBe('unknown');
    built();
    const devMode = await createBuildStateChecker(repo, null, { unknownReason: 'dev mode' }).check();
    expect(devMode).toMatchObject({ state: 'unknown', reason: 'dev mode' });
  });

  it('asks for a rebuild, not a restart, when both are true', async () => {
    const running = built('2026-10-03T09:00:00.000Z');
    built('2026-10-03T10:00:00.000Z');
    commit('src/client/terminal.ts', 'export {};\n');
    expect((await createBuildStateChecker(repo, running).check()).state).toBe('rebuild');
  });

  it('reuses the git answer for 30s, and re-checks once invalidated', async () => {
    let now = 1_000_000;
    const running = built();
    const checker = createBuildStateChecker(repo, running, { now: () => now });
    expect((await checker.check()).state).toBe('current');
    commit('src/server/app.ts', 'export const y = 2;\n');
    expect((await checker.check()).state).toBe('current'); // cached
    checker.invalidate();
    expect((await checker.check()).state).toBe('rebuild');
    // The cache also expires on its own.
    const fresh = createBuildStateChecker(repo, built(), { now: () => now });
    expect((await fresh.check()).state).toBe('current');
    commit('src/server/app.ts', 'export const z = 3;\n');
    now += 31_000;
    expect((await fresh.check()).state).toBe('rebuild');
  });

  it('reads a stamp only with a sha: a build outside git stamps a null one', () => {
    stamp(repo, null as never, '2026-10-03T10:00:00.000Z');
    expect(readBuildStamp(repo)).toBeNull();
  });
});

describe('the build chip', () => {
  const status = (state: BuildStatus['state'], canRestart = true): ServerStatus => ({
    bootId: 'b',
    canRestart,
    reason: canRestart ? null : 'Not running from dist/.',
    build: { state, running: null, onDisk: null, reason: 'why' },
  });

  it('shows only for restart and rebuild', () => {
    expect(chipView(status('current'))).toBeNull();
    expect(chipView(status('unknown'))).toBeNull();
    expect(chipView(null)).toBeNull();
    expect(chipView({ bootId: 'b', canRestart: true, reason: null })).toBeNull(); // an older server
    expect(chipView(status('restart'))?.text).toBe('Restart to load the new build');
    expect(chipView(status('rebuild'))?.text).toBe('Build & restart to load new commits');
  });

  it('gives the reason and the manual step when this server cannot restart itself', () => {
    const view = chipView(status('rebuild', false));
    expect(view?.title).toContain('Not running from dist/.');
    expect(view?.title).toMatch(/By hand: run npm run build/);
    expect(chipView(status('restart'))?.title).toMatch(/Settings → Server → Restart/);
  });
});

describe('the restart hint after a Land', () => {
  it('names the action the landed build needs', () => {
    expect(restartHint('restart')).toBe(' — restart to load it');
    expect(restartHint('rebuild')).toBe(' — Build & restart to load it');
    expect(restartHint('current')).toBe('');
    expect(restartHint(undefined)).toBe('');
  });
});
