import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import Fastify from 'fastify';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { getConfig, loadConfig } from '../src/server/config.js';
import { registerServerSettingsRoutes } from '../src/server/server-settings.js';

/** The route writes the user's config file and is reachable from the tailnet. */

const SAME_ORIGIN = { origin: 'http://localhost:4220', host: 'localhost:4220' };

let dir: string;
let configPath: string;
const previousEnv = process.env.CLAUDE_REMOTE_CONFIG;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cr-settings-'));
  configPath = join(dir, 'config.json');
  process.env.CLAUDE_REMOTE_CONFIG = configPath;
});

afterEach(() => {
  if (previousEnv === undefined) delete process.env.CLAUDE_REMOTE_CONFIG;
  else process.env.CLAUDE_REMOTE_CONFIG = previousEnv;
  rmSync(dir, { recursive: true, force: true });
});

async function appWith(verify: (ip: string) => Promise<unknown> = async () => ({ userId: 'me' })) {
  const app = Fastify();
  registerServerSettingsRoutes(app, { verify, countSessions: () => 4 });
  await app.ready();
  return app;
}

function put(app: Awaited<ReturnType<typeof appWith>>, maxSessions: unknown, headers: Record<string, string> = SAME_ORIGIN) {
  return app.inject({ method: 'PUT', url: '/api/server/settings', headers, payload: { maxSessions } });
}

describe('session limit setting', () => {
  it('reports the limit, its range and the sessions it counts', async () => {
    writeFileSync(configPath, JSON.stringify({ sessions: { maxSessions: 12 } }));
    loadConfig();
    const res = await (await appWith()).inject({ method: 'GET', url: '/api/server/settings' });
    expect(res.json()).toEqual({
      maxSessions: 12,
      range: { min: 1, max: 100 },
      counted: 4,
      maxPerParent: 5,
      maxPerParentRange: { min: 0, max: 20 },
      crossAccountMessaging: false,
    });
  });

  it('applies at once and survives a reload', async () => {
    loadConfig();
    const res = await put(await appWith(), 45);
    expect(res.statusCode).toBe(200);
    expect(res.json().maxSessions).toBe(45);
    expect(getConfig().sessions.maxSessions).toBe(45);
    expect(loadConfig().sessions.maxSessions).toBe(45);
  });

  it('adds only its own key: other settings stay as written and defaults are not frozen in', async () => {
    const written = {
      projectLog: { enabled: true },
      accounts: { personal: { configDir: '~/.claude-personal', accountUuid: 'x' } },
      sessions: { defaultShell: 'pwsh' },
    };
    writeFileSync(configPath, JSON.stringify(written));
    loadConfig();
    await put(await appWith(), 20);
    expect(JSON.parse(readFileSync(configPath, 'utf-8'))).toEqual({
      ...written,
      sessions: { defaultShell: 'pwsh', maxSessions: 20 },
    });
    expect(readdirSync(dir)).toEqual(['config.json']);
  });

  it('keeps an edit made to the file since it was loaded', async () => {
    loadConfig();
    writeFileSync(configPath, JSON.stringify({ server: { port: 5000 } }));
    await put(await appWith(), 20);
    expect(JSON.parse(readFileSync(configPath, 'utf-8')).server.port).toBe(5000);
  });

  it('refuses to overwrite a config file it cannot parse', async () => {
    loadConfig();
    const before = getConfig().sessions.maxSessions;
    writeFileSync(configPath, '{ not json');
    const res = await put(await appWith(), 20);
    expect(res.statusCode).toBe(500);
    // The parse error names the path and quotes the file: that stays in the log.
    expect(res.body).not.toContain(dir);
    expect(res.body).not.toContain('not json');
    expect(res.json().error).toMatch(/server log/);
    expect(readFileSync(configPath, 'utf-8')).toBe('{ not json');
    expect(getConfig().sessions.maxSessions).toBe(before);
  });

  it('replaces a sessions value that is not an object instead of spreading it', async () => {
    writeFileSync(configPath, JSON.stringify({ sessions: ['a', 'b'], server: { port: 5000 } }));
    loadConfig();
    await put(await appWith(), 20);
    expect(JSON.parse(readFileSync(configPath, 'utf-8'))).toEqual({ sessions: { maxSessions: 20 }, server: { port: 5000 } });
  });

  it.each([0, 101, 2.5, '30', null, undefined])('rejects %s', async (value) => {
    loadConfig();
    const res = await put(await appWith(), value);
    expect(res.statusCode).toBe(400);
    expect(existsSync(configPath)).toBe(false);
  });

  it('refuses another origin and an unverified caller', async () => {
    loadConfig();
    const crossSite = await put(await appWith(), 20, { origin: 'https://evil.example', host: 'localhost:4220' });
    expect(crossSite.statusCode).toBe(403);
    const unverified = await put(await appWith(vi.fn(async () => null)), 20);
    expect(unverified.statusCode).toBe(403);
    expect(existsSync(configPath)).toBe(false);
  });
});

describe('started-session limit setting', () => {
  function putBody(app: Awaited<ReturnType<typeof appWith>>, payload: Record<string, unknown>) {
    return app.inject({ method: 'PUT', url: '/api/server/settings', headers: SAME_ORIGIN, payload });
  }

  it('applies at once, survives a reload and writes only its own key', async () => {
    writeFileSync(configPath, JSON.stringify({ sessions: { maxSessions: 12 } }));
    loadConfig();
    const res = await putBody(await appWith(), { maxPerParent: 8 });
    expect(res.statusCode).toBe(200);
    expect(res.json().maxPerParent).toBe(8);
    expect(getConfig().agentSessions.maxPerParent).toBe(8);
    expect(JSON.parse(readFileSync(configPath, 'utf-8'))).toEqual({
      sessions: { maxSessions: 12 },
      agentSessions: { maxPerParent: 8 },
    });
    expect(loadConfig().agentSessions.maxPerParent).toBe(8);
  });

  it('accepts 0, which stops sessions from starting any', async () => {
    loadConfig();
    expect((await putBody(await appWith(), { maxPerParent: 0 })).statusCode).toBe(200);
    expect(getConfig().agentSessions.maxPerParent).toBe(0);
  });

  it('saves both limits in one request', async () => {
    loadConfig();
    const res = await putBody(await appWith(), { maxSessions: 40, maxPerParent: 3 });
    expect(res.statusCode).toBe(200);
    expect(getConfig().sessions.maxSessions).toBe(40);
    expect(getConfig().agentSessions.maxPerParent).toBe(3);
  });

  it.each([-1, 21, 1.5, '3', null])('rejects %s and writes neither limit', async (value) => {
    loadConfig();
    const res = await putBody(await appWith(), { maxSessions: 40, maxPerParent: value });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/started-session limit/);
    expect(existsSync(configPath)).toBe(false);
    expect(getConfig().sessions.maxSessions).toBe(30);
  });

  it('rejects a body with neither limit', async () => {
    loadConfig();
    expect((await putBody(await appWith(), {})).statusCode).toBe(400);
  });
});

describe('agentSessions.maxPerParent as loaded from config.json', () => {
  it.each(['abc', -1, 2.5, null, true])('falls back to the default for %s', (value) => {
    writeFileSync(configPath, JSON.stringify({ agentSessions: { maxPerParent: value } }));
    expect(loadConfig().agentSessions.maxPerParent).toBe(5);
  });

  it('keeps 0 and a hand-written limit past the Settings range', () => {
    writeFileSync(configPath, JSON.stringify({ agentSessions: { maxPerParent: 0 } }));
    expect(loadConfig().agentSessions.maxPerParent).toBe(0);
    writeFileSync(configPath, JSON.stringify({ agentSessions: { maxPerParent: 50 } }));
    expect(loadConfig().agentSessions.maxPerParent).toBe(50);
  });

  it('falls back to the defaults when agentSessions is not an object', () => {
    writeFileSync(configPath, JSON.stringify({ agentSessions: [1] }));
    expect(loadConfig().agentSessions).toEqual({ maxPerParent: 5 });
  });
});

describe('maxSessions as loaded from config.json', () => {
  it.each(['abc', 0, -3, 2.5, null, true])('falls back to the default for %s', (value) => {
    writeFileSync(configPath, JSON.stringify({ sessions: { maxSessions: value, defaultShell: 'pwsh' } }));
    const sessions = loadConfig().sessions;
    expect(sessions.maxSessions).toBe(30);
    expect(sessions.defaultShell).toBe('pwsh');
  });

  it('keeps a hand-written limit past the Settings range', () => {
    writeFileSync(configPath, JSON.stringify({ sessions: { maxSessions: 250 } }));
    expect(loadConfig().sessions.maxSessions).toBe(250);
  });

  it('falls back to the default session settings when sessions is not an object', () => {
    writeFileSync(configPath, JSON.stringify({ sessions: [1, 2] }));
    expect(loadConfig().sessions).toEqual({ maxSessions: 30, idleTimeoutMinutes: 0, defaultCwd: '~/NodeProjects' });
  });
});

describe('cross-account messaging setting', () => {
  const putBody = async (payload: Record<string, unknown>) =>
    (await appWith()).inject({ method: 'PUT', url: '/api/server/settings', headers: SAME_ORIGIN, payload });

  it('turns on and off at once, survives a reload and writes only its own key', async () => {
    writeFileSync(configPath, JSON.stringify({ sessions: { defaultShell: 'pwsh' } }));
    loadConfig();
    const on = await putBody({ crossAccountMessaging: true });
    expect(on.statusCode).toBe(200);
    expect(on.json().crossAccountMessaging).toBe(true);
    expect(getConfig().sessions.crossAccountMessaging).toBe(true);
    expect(JSON.parse(readFileSync(configPath, 'utf-8'))).toEqual({
      sessions: { defaultShell: 'pwsh', crossAccountMessaging: true },
    });
    expect(loadConfig().sessions.crossAccountMessaging).toBe(true);
    const off = await putBody({ crossAccountMessaging: false });
    expect(off.json().crossAccountMessaging).toBe(false);
    expect(getConfig().sessions.crossAccountMessaging).toBe(false);
  });

  it('saves with a limit in one request', async () => {
    loadConfig();
    const res = await putBody({ maxSessions: 25, crossAccountMessaging: true });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(readFileSync(configPath, 'utf-8')).sessions).toEqual({ maxSessions: 25, crossAccountMessaging: true });
  });

  it('refuses anything but true or false, writing nothing', async () => {
    loadConfig();
    for (const value of ['yes', 1, null]) {
      const res = await putBody({ crossAccountMessaging: value, maxSessions: 25 });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toMatch(/true or false/);
    }
    expect(existsSync(configPath)).toBe(false);
  });

  it('reports a hand-written non-boolean as off', async () => {
    writeFileSync(configPath, JSON.stringify({ sessions: { crossAccountMessaging: 'yes' } }));
    loadConfig();
    const res = await (await appWith()).inject({ method: 'GET', url: '/api/server/settings' });
    expect(res.json().crossAccountMessaging).toBe(false);
  });
});
