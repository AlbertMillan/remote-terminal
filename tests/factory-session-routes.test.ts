import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import Fastify, { type FastifyInstance } from 'fastify';

/**
 * Take over / Return to factory / Done over HTTP (factory/session-routes.ts,
 * f-c4urw6): the board's routes behind the access gate, and `cr factory
 * take|return|done` on loopback with the caller's token. A started session
 * cannot take over (it would start a session); return and done release only a
 * claim the caller, or a session it started, holds. Shells and git are fakes.
 */

const dataDir = mkdtempSync(join(tmpdir(), 'cr-factory-sroutes-data-'));
const configPath = join(dataDir, 'config.json');
writeFileSync(configPath, JSON.stringify({ persistence: { dataDir } }));
process.env.CLAUDE_REMOTE_CONFIG = configPath;

const { loadConfig } = await import('../src/server/config.js');
const { initDatabase, closeDatabase, getDatabase } = await import('../src/server/db/schema.js');
const store = await import('../src/server/factory/store.js');
const runState = await import('../src/server/factory/run-state.js');
const { sessionOwner } = await import('../src/server/factory/session-claims.js');
const { registerFactorySessionRoutes } = await import('../src/server/factory/session-routes.js');
const { isInside } = await import('../src/server/utils/paths.js');
type SessionRouteDeps = import('../src/server/factory/session-routes.js').SessionRouteDeps;
type TakeoverDeps = import('../src/server/factory/takeover.js').TakeoverDeps;
type SessionMetadata = import('../src/server/sessions/types.js').SessionMetadata;

let project: string;
let wt: string;
let app: FastifyInstance;
let opened: string[];

const TOKENS: Record<string, string> = { 'tok-main': 'sess-main', 'tok-child': 'sess-child', 'tok-other': 'sess-other' };

function takeoverDeps(): TakeoverDeps {
  let n = 0;
  return {
    projectAccount: () => 'personal',
    preflight: () => ({ ok: true }) as ReturnType<TakeoverDeps['preflight']>,
    openShell: async ({ name }) => {
      const id = `shell-${++n}-${Math.random().toString(36).slice(2, 6)}`;
      opened.push(id);
      return { id, name, type: () => {} };
    },
    deleteSession: async () => true,
    stopUnit: async () => false,
    tick: () => {},
    transcriptExists: () => true,
    lastSessionOf: () => 'factory-sess',
    tokensUsed: () => 0,
    features: (_cwd, ids) => ids.map((id) => ({ id, title: id, spec: null })),
    trackWorktree: () => ({ path: wt, branch: 'track/search', baseBranch: 'main' }),
    headCommit: async () => 'sha1',
    commitAll: async () => false,
    writePromptFile: (id) => join(dataDir, 'prompts', id, 'prompt.md'),
    claudeSessionOf: () => null,
    sessionName: () => null,
    isSessionRunning: () => false,
    stopSession: async () => {},
    announce: () => {},
    now: () => Date.now(),
  };
}

function deps(): SessionRouteDeps {
  const sessions: Record<string, Partial<SessionMetadata>> = {
    'sess-main': { id: 'sess-main', cwd: project, spawnedBy: null, ownerId: null },
    'sess-child': { id: 'sess-child', cwd: wt, spawnedBy: 'sess-main' },
    'sess-other': { id: 'sess-other', cwd: project, spawnedBy: null },
  };
  return {
    takeover: takeoverDeps,
    findProject: (cwd) => (cwd === project ? { cwd: project } : null),
    projectForCwd: (cwd) => (isInside(project, cwd) ? { cwd: project } : null),
    sessionForToken: (token) => TOKENS[token] ?? null,
    getSession: (id) => (sessions[id] as SessionMetadata) ?? null,
    trackOfFolder: (cwd) => (cwd === wt ? 'Search' : null),
    childrenOf: (id) => (id === 'sess-main' ? ['sess-child'] : []),
  };
}

beforeAll(() => {
  loadConfig();
  initDatabase();
});
afterAll(() => {
  closeDatabase();
  rmSync(dataDir, { recursive: true, force: true });
});

beforeEach(async () => {
  getDatabase().exec('DELETE FROM factory_session_claims; DELETE FROM factory_runs; DELETE FROM factory_items');
  project = mkdtempSync(join(tmpdir(), 'cr-factory-sroutes-proj-'));
  wt = join(project, '.wt-search');
  mkdirSync(wt);
  opened = [];
  app = Fastify();
  registerFactorySessionRoutes(app, deps());
  await app.ready();
  store.createItem({ projectCwd: project, featureId: 'f-aaa111', trackName: 'Search', workflow: 'track' });
  store.createItem({ projectCwd: project, featureId: 'f-aaa222', trackName: 'Search', workflow: 'track' });
  store.createItem({ projectCwd: project, featureId: 'f-bbb111', trackName: 'Inbox', workflow: 'item' });
  runState.ensureRunState(project, 'f-bbb111');
  runState.saveRunState(project, 'f-bbb111', { worktreePath: wt });
});

afterEach(async () => {
  await app.close();
  rmSync(project, { recursive: true, force: true });
});

const post = (url: string, payload: unknown, headers: Record<string, string> = {}, remoteAddress?: string) =>
  app.inject({ method: 'POST', url, payload: payload as object, headers, ...(remoteAddress ? { remoteAddress } : {}) });
const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

describe('the board', () => {
  it('takes a unit over, then returns it', async () => {
    const take = await post('/api/factory/items/f-bbb111/take', { cwd: project });
    expect(take.statusCode).toBe(200);
    const sessionId = take.json().sessionId as string;
    expect(store.getItem(project, 'f-bbb111')?.claimOwner).toBe(sessionOwner(sessionId));

    const back = await post('/api/factory/items/f-bbb111/return', { cwd: project });
    expect(back.statusCode).toBe(200);
    expect(store.getItem(project, 'f-bbb111')).toMatchObject({ status: 'open', claimOwner: null });
  });

  it('refuses an unknown project, a bad id, and a return of an unclaimed unit', async () => {
    expect((await post('/api/factory/items/f-bbb111/take', { cwd: 'C:\\nowhere' })).statusCode).toBe(404);
    expect((await post('/api/factory/items/nope/take', { cwd: project })).statusCode).toBe(400);
    expect((await post('/api/factory/items/f-bbb111/done', { cwd: project })).statusCode).toBe(409);
  });
});

describe('sessions (cr factory take|return|done)', () => {
  it('take resolves a track name to its unit, and opens a new session', async () => {
    const res = await post('/api/agent/factory/take', { target: 'Search' }, bearer('tok-main'));
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ unitId: 'track:Search', featureIds: ['f-aaa111', 'f-aaa222'] });
    expect(opened).toHaveLength(1);
  });

  it('a started session cannot take over, and nothing is claimed', async () => {
    const res = await post('/api/agent/factory/take', { target: 'f-bbb111' }, bearer('tok-child'));
    expect(res.statusCode).toBe(403);
    expect(opened).toEqual([]);
    expect(store.getItem(project, 'f-bbb111')?.claimOwner).toBeNull();
  });

  it('only on loopback, with a token', async () => {
    expect((await post('/api/agent/factory/take', { target: 'f-bbb111' }, bearer('tok-main'), '100.64.0.9')).statusCode).toBe(403);
    expect((await post('/api/agent/factory/take', { target: 'f-bbb111' })).statusCode).toBe(401);
  });

  it('return and done release what the caller, or a session it started, holds; no one else', async () => {
    store.claimForSession(project, ['f-aaa111', 'f-aaa222'], sessionOwner('sess-child'), Date.now());
    // An unrelated session: nothing of its own, and not the holder's parent.
    expect((await post('/api/agent/factory/return', {}, bearer('tok-other'))).statusCode).toBe(409);
    expect((await post('/api/agent/factory/return', { target: 'Search' }, bearer('tok-other'))).statusCode).toBe(403);
    // The parent may hand back its child's work.
    const done = await post('/api/agent/factory/done', { target: 'f-aaa222' }, bearer('tok-main'));
    expect(done.statusCode).toBe(200);
    expect(done.json()).toMatchObject({ sessionId: 'sess-child', featureIds: ['f-aaa111', 'f-aaa222'] });
    expect(store.getItem(project, 'f-aaa111')).toMatchObject({ status: 'open', claimOwner: null });
    const progress = runState.getRunState(project, 'track:Search')?.progress;
    expect(progress?.outcomes.features).toBe('done');
  });

  it('the holder returns its own without naming it', async () => {
    store.claimForSession(project, ['f-bbb111'], sessionOwner('sess-child'), Date.now());
    const res = await post('/api/agent/factory/return', {}, bearer('tok-child'));
    expect(res.statusCode).toBe(200);
    expect(res.json().featureIds).toEqual(['f-bbb111']);
  });
});

