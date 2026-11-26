import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import Fastify, { type FastifyInstance } from 'fastify';

/**
 * The factory's write-side routes (project/code-factory.md, f-wlr5dc and
 * f-h1nykc): add, send, status, answer and triage, for the board under
 * /api/factory/* and for sessions under /api/agent/factory/* (loopback plus
 * the caller's session token; a cwd naming another project is 403). The
 * intake model, the track branch and the worktree commit are fakes; the plan
 * is a real PROJECT.md in a temp folder (writes that need git are covered by
 * factory-intake.test.ts).
 */

const dataDir = mkdtempSync(join(tmpdir(), 'cr-factory-routes-data-'));
const configPath = join(dataDir, 'config.json');
writeFileSync(configPath, JSON.stringify({ persistence: { dataDir } }));
process.env.CLAUDE_REMOTE_CONFIG = configPath;

const { loadConfig } = await import('../src/server/config.js');
const { initDatabase, closeDatabase, getDatabase } = await import('../src/server/db/schema.js');
const store = await import('../src/server/factory/store.js');
const intakeStore = await import('../src/server/factory/intake-store.js');
const { registerFactoryRoutes } = await import('../src/server/factory/factory-routes.js');
const { saveRunState, ensureRunState, getRunState } = await import('../src/server/factory/run-state.js');
const { insertMerge } = await import('../src/server/factory/merge-queue-store.js');
const { isInside } = await import('../src/server/utils/paths.js');
type FactoryRouteDeps = import('../src/server/factory/factory-routes.js').FactoryRouteDeps;
type SessionMetadata = import('../src/server/sessions/types.js').SessionMetadata;

const DOC = `## Track: Alpha
- [x] \`f-aaaaaa\` Done already
- [ ] \`f-bbbbbb\` P1 Build it → project/alpha.md
- [ ] \`f-cccccc\` Test it

## Track: Empty
- [x] \`f-dddddd\` All done
`;

let project: string;
let other: string;
let app: FastifyInstance;
let asked: string[];
let reply: string;
let branched: string[];
let dirty: string[] | null;

const TOKENS: Record<string, string> = { 'tok-main': 'sess-main', 'tok-wt': 'sess-wt', 'tok-lost': 'sess-lost' };

function deps(): FactoryRouteDeps {
  const wt = join(project, '.wt-alpha');
  return {
    intake: { ask: async (_cwd, prompt) => (asked.push(prompt), reply) },
    send: {
      ensureTrackBranch: async (_p, track) => {
        branched.push(track);
        return { branch: 'track/alpha-1234', worktreePath: wt } as never;
      },
      commitPlanning: async () => dirty,
    },
    findProject: (cwd) => (cwd === project ? { cwd: project } : null),
    projectForCwd: (cwd) => (isInside(project, cwd) ? { cwd: project } : isInside(other, cwd) ? { cwd: other } : null),
    sessionForToken: (token) => TOKENS[token] ?? null,
    getSession: (id) =>
      ({ 'sess-main': { id, cwd: project }, 'sess-wt': { id, cwd: wt } } as Record<string, SessionMetadata>)[id] ?? null,
    trackOfFolder: (cwd) => (cwd === wt ? 'Alpha' : null),
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
  getDatabase().exec(
    'DELETE FROM factory_merges; DELETE FROM factory_runs; DELETE FROM factory_intake; DELETE FROM factory_deps; DELETE FROM factory_items'
  );
  project = mkdtempSync(join(tmpdir(), 'cr-factory-routes-proj-'));
  other = mkdtempSync(join(tmpdir(), 'cr-factory-routes-other-'));
  writeFileSync(join(project, 'PROJECT.md'), DOC);
  asked = [];
  reply = JSON.stringify({ features: [{ title: 'Loose thing', requirements: ['one'], mockupFirst: true }] });
  branched = [];
  dirty = null;
  app = Fastify();
  registerFactoryRoutes(app, deps());
  await app.ready();
});

afterEach(async () => {
  await app.close();
  rmSync(project, { recursive: true, force: true });
  rmSync(other, { recursive: true, force: true });
});

const post = (url: string, payload: unknown, headers: Record<string, string> = {}, remoteAddress?: string) =>
  app.inject({ method: 'POST', url, payload: payload as object, headers, ...(remoteAddress ? { remoteAddress } : {}) });
const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

describe('/api/factory/send (▶ and the board)', () => {
  it("queues the track's open features as one track unit with Settings defaults", async () => {
    const res = await post('/api/factory/send', { cwd: project, track: 'Alpha' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.queued).toEqual(['f-bbbbbb', 'f-cccccc']);
    expect(body.plan).toMatchObject({ track: 'Alpha', branch: 'track/alpha-1234', review: 'track', reviewOverridden: false });
    expect(branched).toEqual(['Alpha']);
    const items = store.listItems({ projectCwd: project });
    expect(items.map((i) => [i.featureId, i.workflow, i.trackName, i.priority, i.reviewGranularity, i.modelTier])).toEqual([
      ['f-bbbbbb', 'track', 'Alpha', 1, null, null],
      ['f-cccccc', 'track', 'Alpha', 2, null, null],
    ]);

    // Sent again while its unit is in the factory: refused.
    expect((await post('/api/factory/send', { cwd: project, track: 'Alpha' })).statusCode).toBe(409);
  });

  it('sends a track again once its earlier unit closed, with its progress started over', async () => {
    await post('/api/factory/send', { cwd: project, track: 'Alpha' });
    // The earlier unit merged: handed off, its items closed.
    ensureRunState(project, 'track:Alpha');
    saveRunState(project, 'track:Alpha', { handedOffAt: new Date().toISOString() });
    store.updateItem(project, 'f-bbbbbb', { status: 'done' });
    store.updateItem(project, 'f-cccccc', { status: 'cancelled' });

    const res = await post('/api/factory/send', { cwd: project, track: 'Alpha' });
    expect(res.statusCode).toBe(200);
    expect(res.json().queued).toEqual(['f-bbbbbb', 'f-cccccc']);
    expect(getRunState(project, 'track:Alpha')).toBeNull();
    expect(store.readyItems(project).map((i) => i.featureId)).toEqual(['f-bbbbbb', 'f-cccccc']);
  });

  it('refuses what it cannot send', async () => {
    const cases: [unknown, number][] = [
      [{ track: 'Alpha' }, 400],
      [{ cwd: join(project, 'nope'), track: 'Alpha' }, 404],
      [{ cwd: project }, 400],
      [{ cwd: project, track: 'Nope' }, 404],
      [{ cwd: project, track: 'Empty' }, 400],
      [{ cwd: project, track: 'Inbox' }, 400],
      [{ cwd: project, track: 'Alpha', review: 'sometimes' }, 400],
      [{ cwd: project, track: 'Alpha', models: { 'f-bbbbbb': 'gpt-5' } }, 400],
      [{ cwd: project, track: 'Alpha', models: { 'f-aaaaaa': 'opus' } }, 400],
    ];
    for (const [payload, status] of cases) {
      const res = await post('/api/factory/send', payload);
      expect(res.statusCode, JSON.stringify(payload)).toBe(status);
    }
    expect(store.listItems({ projectCwd: project })).toEqual([]);
  });

  it('refuses a worktree with uncommitted code, before queueing anything', async () => {
    dirty = ['src/half-done.ts'];
    const res = await post('/api/factory/send', { cwd: project, track: 'Alpha' });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toContain('src/half-done.ts');
    expect(store.listItems({ projectCwd: project })).toEqual([]);
  });
});

describe('/api/factory/add', () => {
  it('files free-form text (git-less project: the working copy only) and answers features and order', async () => {
    const res = await post('/api/factory/add', { cwd: project, text: 'a loose thing, mockup first\n- one' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.features).toMatchObject([{ title: 'Loose thing', requirements: ['one'], mockupFirst: true }]);
    expect(body.order).toEqual([]);
    expect(store.getItem(project, body.features[0].featureId)?.trackName).toBe('Inbox');
    expect(asked).toHaveLength(1);
  });

  it('answers 400 for no text and 422 for text with no work', async () => {
    expect((await post('/api/factory/add', { cwd: project })).statusCode).toBe(400);
    reply = '{"features": []}';
    const res = await post('/api/factory/add', { cwd: project, text: 'hmm' });
    expect(res.statusCode).toBe(422);
    expect(store.listItems({ projectCwd: project })).toEqual([]);
  });
});

describe('/api/factory/status, answer and triage', () => {
  it('summarises items, what they wait for, parked units with their question, and merges', async () => {
    for (const id of ['f-bbbbbb', 'f-cccccc', 'f-eeeeee']) {
      store.createItem({ projectCwd: project, featureId: id, trackName: 'Inbox', workflow: 'item' });
      intakeStore.insertIntake({ projectCwd: project, featureId: id, source: 'intake' });
    }
    store.addDependency({ projectCwd: project, fromFeature: 'f-cccccc', toFeature: 'f-bbbbbb', type: 'blocks', inferred: true });
    store.updateItem(project, 'f-bbbbbb', { status: 'parked', step: 'shape' });
    ensureRunState(project, 'f-bbbbbb');
    saveRunState(project, 'f-bbbbbb', { parkReason: 'shape: question: Which?' });
    intakeStore.updateIntake(project, 'f-bbbbbb', { question: { question: 'Which?', options: ['a', 'b'], default: 'a' } });
    store.updateItem(project, 'f-eeeeee', { status: 'done' });
    insertMerge({ projectCwd: project, kind: 'item', branch: 'factory/x', worktreePath: 'C:\\wt', baseBranch: 'main', featureIds: ['f-x'] });

    const res = await app.inject({ method: 'GET', url: `/api/factory/status?cwd=${encodeURIComponent(project)}` });
    expect(res.statusCode).toBe(200);
    const s = res.json();
    expect(s.items.map((i: { featureId: string; title: string; waitsFor: string[] }) => [i.featureId, i.title, i.waitsFor])).toEqual([
      ['f-bbbbbb', 'Build it', []],
      ['f-cccccc', 'Test it', ['f-bbbbbb']],
    ]);
    expect(s.parked).toEqual([
      { unitId: 'f-bbbbbb', featureIds: ['f-bbbbbb'], step: 'shape', reason: 'shape: question: Which?', question: { question: 'Which?', options: ['a', 'b'], default: 'a' } },
    ]);
    expect(s.merges).toMatchObject([{ kind: 'item', branch: 'factory/x', status: 'queued' }]);
    expect(s.closed).toEqual({ done: 1, cancelled: 0 });

    expect((await app.inject({ method: 'GET', url: '/api/factory/status' })).statusCode).toBe(400);

    const answered = await post('/api/factory/items/f-bbbbbb/answer', { cwd: project, answer: 'b' });
    expect(answered.statusCode).toBe(200);
    expect(intakeStore.getIntake(project, 'f-bbbbbb')?.answer).toBe('b');
    expect(store.getItem(project, 'f-bbbbbb')?.status).toBe('open');
    expect((await post('/api/factory/items/f-bbbbbb/answer', { cwd: project, answer: 'b' })).statusCode).toBe(409);
    expect((await post('/api/factory/items/f-bbbbbb/answer', { cwd: project })).statusCode).toBe(400);
    expect((await post('/api/factory/items/f-zzzzzz/answer', { cwd: project, answer: 'x' })).statusCode).toBe(404);
  });

  it('settles triage items and refuses the rest', async () => {
    store.createItem({ projectCwd: project, featureId: 'f-bbbbbb', trackName: 'Inbox', workflow: 'item', status: 'triage' });
    expect((await post('/api/factory/triage/f-bbbbbb', { cwd: project, action: 'later' })).statusCode).toBe(400);
    const res = await post('/api/factory/triage/f-bbbbbb', { cwd: project, action: 'accept' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ featureId: 'f-bbbbbb', action: 'accept', item: { status: 'open' } });
    expect((await post('/api/factory/triage/f-bbbbbb', { cwd: project, action: 'accept' })).statusCode).toBe(409);
    expect((await post('/api/factory/triage/f-zzzzzz', { cwd: project, action: 'accept' })).statusCode).toBe(404);
  });
});

describe('/api/agent/factory/* (sessions)', () => {
  it('refuses a request off loopback, without a token, or with an unknown one', async () => {
    const off = await post('/api/agent/factory/send', { track: 'Alpha' }, bearer('tok-main'), '100.64.0.9');
    expect(off.statusCode).toBe(403);
    expect((await post('/api/agent/factory/send', { track: 'Alpha' })).statusCode).toBe(401);
    expect((await post('/api/agent/factory/send', { track: 'Alpha' }, bearer('tok-nope'))).statusCode).toBe(401);
    expect((await post('/api/agent/factory/send', { track: 'Alpha' }, bearer('tok-lost'))).statusCode).toBe(401);
    expect((await app.inject({ method: 'GET', url: '/api/agent/factory/status' })).statusCode).toBe(401);
    expect(store.listItems({ projectCwd: project })).toEqual([]);
  });

  it("works on the caller's project only: a cwd naming another is 403", async () => {
    const res = await post('/api/agent/factory/add', { cwd: other, text: 'x' }, bearer('tok-main'));
    expect(res.statusCode).toBe(403);
    expect(asked).toEqual([]);
    const status = await app.inject({ method: 'GET', url: `/api/agent/factory/status?cwd=${encodeURIComponent(other)}`, headers: bearer('tok-main') });
    expect(status.statusCode).toBe(403);
  });

  it("sends the caller's own track when none is named, with its overrides", async () => {
    const res = await post('/api/agent/factory/send', { review: 'feature', models: { 'f-cccccc': 'opus' } }, bearer('tok-wt'));
    expect(res.statusCode).toBe(200);
    expect(res.json().plan).toMatchObject({ track: 'Alpha', review: 'feature', reviewOverridden: true });
    expect(store.getItem(project, 'f-cccccc')).toMatchObject({ modelTier: 'opus', reviewGranularity: 'feature' });
    // From the main checkout there is no track to default to.
    expect((await post('/api/agent/factory/send', {}, bearer('tok-main'))).statusCode).toBe(400);
  });

  it('adds work, discovered work into triage, and reads status, answers and triage', async () => {
    store.createItem({ projectCwd: project, featureId: 'f-bbbbbb', trackName: 'Alpha', workflow: 'item' });
    const added = await post('/api/agent/factory/add', { text: 'found a bug', discoveredFrom: ['f-bbbbbb'] }, bearer('tok-main'));
    expect(added.statusCode).toBe(200);
    const id = added.json().features[0].featureId;
    expect(store.getItem(project, id)?.status).toBe('triage');
    expect((await post('/api/agent/factory/add', { text: 'x', discoveredFrom: ['nope'] }, bearer('tok-main'))).statusCode).toBe(400);

    const status = await app.inject({ method: 'GET', url: '/api/agent/factory/status', headers: bearer('tok-main') });
    expect(status.statusCode).toBe(200);
    expect(status.json().items.map((i: { featureId: string }) => i.featureId)).toEqual(['f-bbbbbb', id]);

    const triaged = await post(`/api/agent/factory/triage/${id}`, { action: 'accept' }, bearer('tok-main'));
    expect(triaged.statusCode).toBe(200);
    expect(store.getItem(project, id)?.status).toBe('open');

    const answer = await post('/api/agent/factory/items/f-bbbbbb/answer', { answer: 'x' }, bearer('tok-main'));
    expect(answer.statusCode).toBe(409);
  });
});
