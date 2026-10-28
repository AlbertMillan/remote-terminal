import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import Fastify from 'fastify';

// Builds a Fastify app and loads the route modules cold (see project-favorites.test.ts).
vi.setConfig({ testTimeout: 30_000 });

/**
 * A project's default account lives in the hand-editable projects.json, set from
 * the project header. Like a favourite, setting it must touch only that entry and
 * never rewrite a file it can't parse; the header also needs to tell its own
 * setting from one inherited from a containing entry.
 */

const dataDir = mkdtempSync(join(tmpdir(), 'cr-project-account-'));
const configPath = join(dataDir, 'config.json');
// No `accounts`: the defaults, personal and work.
writeFileSync(configPath, JSON.stringify({ persistence: { dataDir } }));
process.env.CLAUDE_REMOTE_CONFIG = configPath;

const ALPHA = 'C:\\Projects\\alpha';
const ALPHA_SUB = 'C:\\Projects\\alpha\\packages\\web';
const BETA = 'C:\\Projects\\beta';

const board = vi.hoisted(() => ({ cwds: [] as string[] }));
vi.mock('../src/server/projects/workspace.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/server/projects/workspace.js')>();
  return { ...actual, listBoardCwds: () => board.cwds };
});

const { loadConfig } = await import('../src/server/config.js');
loadConfig();
const { setProjectAccount, getRegistryPath, RegistryUnreadableError } = await import(
  '../src/server/projects/registry.js'
);
const { projectAccountEntry, projectDefaultAccount } = await import('../src/server/accounts.js');
const { registerProjectRoutes } = await import('../src/server/projects/routes.js');
const { defaultAccountLabel } = await import('../src/client/new-session-modal.js');

const registryPath = getRegistryPath();
const readRaw = (): Record<string, unknown> => JSON.parse(readFileSync(registryPath, 'utf-8'));

beforeEach(() => {
  rmSync(registryPath, { force: true });
  board.cwds = [ALPHA, BETA];
});

afterAll(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

describe('setProjectAccount', () => {
  it('adds an entry for a project that has none', () => {
    setProjectAccount(ALPHA, 'work');
    expect(readRaw().projects).toEqual([{ cwd: ALPHA, account: 'work' }]);
    expect(projectDefaultAccount(ALPHA)).toBe('work');
  });

  it("sets and clears only the account on an existing entry, matched by pathKey", () => {
    const hand = {
      projects: [{ cwd: ALPHA, name: 'Alpha', note: 'kept' }],
      favorites: [BETA],
      myOwnKey: { anything: 1 },
    };
    writeFileSync(registryPath, JSON.stringify(hand));
    setProjectAccount('c:/projects/ALPHA', 'work');
    expect(readRaw()).toEqual({ ...hand, projects: [{ cwd: ALPHA, name: 'Alpha', note: 'kept', account: 'work' }] });
    // Clearing keeps the entry: it may be a hand-written registration.
    setProjectAccount(ALPHA, null);
    expect(readRaw()).toEqual(hand);
  });

  it('writes nothing when clearing a project with no entry', () => {
    setProjectAccount(ALPHA, null);
    expect(existsSync(registryPath)).toBe(false);
  });

  it('refuses to rewrite a file it cannot parse', () => {
    writeFileSync(registryPath, '{ nope');
    expect(() => setProjectAccount(ALPHA, 'work')).toThrow(RegistryUnreadableError);
    expect(readFileSync(registryPath, 'utf-8')).toBe('{ nope');
  });
});

describe('projectAccountEntry', () => {
  it("names the entry the answer came from, so a parent's reads as inherited", () => {
    writeFileSync(registryPath, JSON.stringify({ projects: [{ cwd: ALPHA, account: 'work' }] }));
    expect(projectAccountEntry(ALPHA)).toEqual({ cwd: ALPHA, account: 'work' });
    expect(projectAccountEntry(ALPHA_SUB)).toEqual({ cwd: ALPHA, account: 'work' });
    expect(projectAccountEntry(BETA)).toBeNull();
  });

  it('prefers the most specific entry, and reads a given list over the file', () => {
    const projects = [
      { cwd: ALPHA, account: 'work' },
      { cwd: ALPHA_SUB, account: 'personal' },
    ];
    expect(projectAccountEntry(ALPHA_SUB, projects)).toEqual({ cwd: ALPHA_SUB, account: 'personal' });
    expect(projectAccountEntry('C:\\Projects\\alpha\\other', projects)?.account).toBe('work');
  });

  it('ignores an account that is not configured', () => {
    expect(projectAccountEntry(ALPHA, [{ cwd: ALPHA, account: 'gone' }])).toBeNull();
  });
});

describe('POST /api/projects/account', () => {
  async function post(body: unknown) {
    const app = Fastify({ logger: false });
    registerProjectRoutes(app);
    const res = await app.inject({ method: 'POST', url: '/api/projects/account', payload: body as object });
    await app.close();
    return res;
  }

  it('sets and clears a project on the board, under the board spelling', async () => {
    const set = await post({ cwd: 'c:\\projects\\alpha', account: 'work' });
    expect(set.statusCode).toBe(200);
    expect(set.json()).toEqual({ cwd: ALPHA, account: 'work' });
    expect(readRaw().projects).toEqual([{ cwd: ALPHA, account: 'work' }]);

    const cleared = await post({ cwd: ALPHA, account: null });
    expect(cleared.statusCode).toBe(200);
    expect(readRaw().projects).toEqual([{ cwd: ALPHA }]);
  });

  it('refuses an account that is not configured, or a missing one', async () => {
    expect((await post({ cwd: ALPHA, account: 'nope' })).statusCode).toBe(400);
    expect((await post({ cwd: ALPHA })).statusCode).toBe(400);
    expect(existsSync(registryPath)).toBe(false);
  });

  it('refuses a directory that is not on the board', async () => {
    expect((await post({ cwd: 'C:\\Windows', account: 'work' })).statusCode).toBe(404);
    expect(existsSync(registryPath)).toBe(false);
  });

  it('answers 409 and keeps the file when projects.json is malformed', async () => {
    writeFileSync(registryPath, '{ nope');
    const res = await post({ cwd: ALPHA, account: 'work' });
    expect(res.statusCode).toBe(409);
    expect(readFileSync(registryPath, 'utf-8')).toBe('{ nope');
  });
});

describe('New Session Default label', () => {
  it("says whether the default comes from the project", () => {
    expect(defaultAccountLabel({ account: 'work', source: 'project' })).toBe('Default (work, from project)');
    expect(defaultAccountLabel({ account: 'personal', source: 'default' })).toBe('Default (personal)');
  });
});
