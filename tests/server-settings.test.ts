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
    expect(res.json()).toEqual({ maxSessions: 12, range: { min: 1, max: 100 }, counted: 4 });
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
    expect(loadConfig().sessions).toEqual({ maxSessions: 30, idleTimeoutMinutes: 0 });
  });
});
