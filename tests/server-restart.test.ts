import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import Fastify from 'fastify';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  BOOT_ID,
  registerServerRestartRoutes,
  restartAvailability,
  type ServerRestartDeps,
} from '../src/server/server-restart.js';
import { waitForNewBoot } from '../src/client/server-restart.js';

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
    expect(res.json()).toEqual({ bootId: BOOT_ID, canRestart: true, reason: null });
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
