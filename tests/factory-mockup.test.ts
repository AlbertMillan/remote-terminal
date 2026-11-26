import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import Fastify, { type FastifyInstance } from 'fastify';
import { makeTmpDataDir } from './helpers/tmp-data-dir.js';

/**
 * The mockup-first step (project/code-factory.md, f-ib2d86): the template's
 * when-condition (flagged vs not), a run that writes only to the item's
 * mockup folder, the park, a comment that resumes the mockup session and
 * parks again up to its cap, Approve → implement with the mockup as its
 * reference (summary page and reviewer too), the serving route's lexical
 * containment and CSP behind the access gate, and Add work's flag end to
 * end. No claude is ever spawned: runClaude is a fake that writes the page
 * the agent would.
 */

const dataDir = makeTmpDataDir('factory-mockup');
const configPath = join(dataDir, 'config.json');
writeFileSync(configPath, JSON.stringify({ persistence: { dataDir }, factory: { review: { mode: 'agent' } } }));
process.env.CLAUDE_REMOTE_CONFIG = configPath;

const { loadConfig } = await import('../src/server/config.js');
const { initDatabase, closeDatabase, getDatabase } = await import('../src/server/db/schema.js');
const store = await import('../src/server/factory/store.js');
const intakeStore = await import('../src/server/factory/intake-store.js');
const templates = await import('../src/server/factory/templates.js');
const { stepHandler } = await import('../src/server/factory/steps.js');
const { runUnit } = await import('../src/server/factory/runner.js');
const runState = await import('../src/server/factory/run-state.js');
const files = await import('../src/server/factory/mockup-files.js');
const { mockupStep, MOCKUP_READY, MOCKUP_ESCALATED } = await import('../src/server/factory/mockup-step.js');
const { registerMockupRoutes, mockupCsp } = await import('../src/server/factory/mockup-routes.js');
const { registerFactoryBoardRoutes } = await import('../src/server/factory/board-routes.js');
const { registerFactoryRoutes } = await import('../src/server/factory/factory-routes.js');
const { registerAccessGate } = await import('../src/server/auth/access-gate.js');
const { addDirArgs } = await import('../src/server/agent/claude-run.js');
const { projectHash } = await import('../src/server/factory/deps.js');
const review = await import('../src/server/factory/review-step.js');
type EngineDeps = import('../src/server/factory/deps.js').EngineDeps;
type StepContext = import('../src/server/factory/steps.js').StepContext;
type RunOptions = import('../src/server/agent/claude-run.js').RunOptions;
type Progress = import('../src/server/factory/templates.js').Progress;
type FactoryRouteDeps = import('../src/server/factory/factory-routes.js').FactoryRouteDeps;

const CWD = 'C:\\projects\\mock';
const ID = 'f-mock01';
const HASH = projectHash(CWD);
/** Set once the config is loaded: the folder follows its data dir. */
let DIR: string;
const OWNER = { owner: 'run:test', kind: 'run' as const };

let worktree: string;

beforeAll(() => {
  loadConfig();
  initDatabase();
  DIR = files.mockupDirFor(CWD, ID);
});
afterAll(() => closeDatabase());

beforeEach(() => {
  getDatabase().exec('DELETE FROM factory_runs; DELETE FROM factory_intake; DELETE FROM factory_deps; DELETE FROM factory_items');
  rmSync(join(dataDir, 'factory'), { recursive: true, force: true });
  worktree = mkdtempSync(join(tmpdir(), 'cr-mockup-wt-'));
  review.setReviewProbe({ changedFiles: async () => [{ path: 'src/a.ts', lines: 10 }], fileAt: async () => null, readText: () => null });
});
afterEach(() => rmSync(worktree, { recursive: true, force: true }));

interface Call {
  cwd: string;
  prompt: string;
  globs: string[];
  opts: RunOptions;
}

const SPEC = JSON.stringify({
  spec: { goal: 'A dark-mode toggle', acceptance: ['toggles'], files: ['src/client/settings.ts'], assumptions: [] },
  tier: 'sonnet',
  discovered: [],
});
const APPROVE = JSON.stringify({
  verdict: 'approve',
  findings: [],
  escalation: { sensitivePaths: false, newDependencies: [], assumptions: [] },
});

/**
 * A runClaude that answers by stage. The mockup stage writes the page into
 * its `--add-dir` folder, as the agent would; `page: false` writes nothing.
 */
function claude(opts: { page?: boolean; failResume?: boolean } = {}) {
  const calls: Call[] = [];
  let n = 0;
  const run = vi.fn(async (cwd: string, prompt: string, globs: string[], o: RunOptions = {}) => {
    calls.push({ cwd, prompt, globs, opts: o });
    const stage = o.tag?.stage;
    if (stage === 'mockup') {
      if (o.resumeSessionId && opts.failResume) throw new Error('No conversation found');
      if (opts.page !== false) {
        const dir = o.addDirs?.[0] as string;
        writeFileSync(join(dir, files.MOCKUP_PAGE), `<html><body>mockup ${calls.length}</body></html>`);
      }
      return { isError: false, result: "## What you'd do\n- Open Settings", permissionDenials: 0, sessionId: o.resumeSessionId ?? `mock-${++n}` };
    }
    const result = stage === 'shape' ? SPEC : stage === 'self-review' ? '{"verdict": "pass", "findings": []}' : stage === 'review' ? APPROVE : `${stage} done`;
    return { isError: false, result, permissionDenials: 0, sessionId: o.resumeSessionId ?? `sess-${++n}` };
  });
  return { run: run as unknown as EngineDeps['runClaude'], calls };
}

function engineDeps(run: EngineDeps['runClaude']): EngineDeps {
  return {
    runClaude: run,
    prepareWorktree: async () => ({ path: worktree, branch: `factory/${ID}`, baseBranch: 'main' }),
    dirtyFiles: async () => [],
    commit: async () => true,
    headCommit: async () => 'sha1',
    features: (_cwd, ids) => ids.map((id) => ({ id, title: 'Dark mode toggle', spec: null })),
    verifyCommands: () => [],
    runCommand: async () => ({ ok: true, output: '' }),
    tickFeature: async () => undefined,
    tokensUsed: () => 0,
    lastSessionOf: () => null,
    writeSummary: (_cwd, unitId) => {
      const path = join(dataDir, 'factory', HASH, unitId, 'summary.md');
      mkdirSync(join(path, '..'), { recursive: true });
      writeFileSync(path, '# Summary');
      return path;
    },
    planUsage: () => null,
    mergeSink: () => ({ enqueue: () => undefined }),
    notify: () => undefined,
    stepTimeoutMs: () => 60_000,
    now: () => Date.now(),
  };
}

function item(mockupFirst: boolean) {
  store.createItem({ projectCwd: CWD, featureId: ID, trackName: 'Inbox', workflow: 'item' });
  intakeStore.insertIntake({ projectCwd: CWD, featureId: ID, source: 'intake', mockupFirst });
}

async function run(deps: EngineDeps) {
  expect(store.claimItem(CWD, ID, OWNER).ok).toBe(true);
  return runUnit(
    { ref: { projectCwd: CWD, unitId: ID, trackName: 'Inbox', isTrack: false, featureIds: [ID] }, workflow: 'item', owner: OWNER.owner, modelTier: null },
    deps,
    { signal: new AbortController().signal }
  );
}

function ctx(runClaude: EngineDeps['runClaude'], progress: Progress = templates.emptyProgress()): StepContext {
  return {
    unit: { projectCwd: CWD, unitId: ID, trackName: 'Inbox', isTrack: false, featureIds: [ID] },
    features: [{ id: ID, title: 'Dark mode toggle', spec: null }],
    worktree: { path: worktree, branch: `factory/${ID}`, baseBranch: 'main' },
    progress,
    step: { id: 'mockup', handler: 'mockup', needs: ['shape'] },
    signal: new AbortController().signal,
    deps: { runClaude, stepTimeoutMs: () => 60_000 } as unknown as EngineDeps,
    agent: vi.fn(),
    commit: vi.fn(),
    saveProgress: vi.fn(),
  };
}

const stages = (calls: Call[]) => calls.map((c) => c.opts.tag?.stage);
const progressOf = () => runState.getRunState(CWD, ID)!.progress;

describe('the when-condition', () => {
  it('runs mockup after shape only when shaping reported the flag; implement waits on it either way', () => {
    const t = templates.ITEM_TEMPLATE;
    const flagged = templates.emptyProgress();
    templates.recordOutcome(t, flagged, 'shape', templates.MOCKUP_OUTCOME);
    expect(templates.nextStep(t, flagged)).toMatchObject({ kind: 'run', step: { id: 'mockup' } });

    const plain = templates.emptyProgress();
    templates.recordOutcome(t, plain, 'shape', templates.DONE);
    expect(templates.nextStep(t, plain)).toMatchObject({ kind: 'run', step: { id: 'implement' } });
    expect(plain.skipped).toContain('mockup');

    templates.recordOutcome(t, flagged, 'mockup', 'approved');
    expect(templates.nextStep(t, flagged)).toMatchObject({ kind: 'run', step: { id: 'implement' } });
  });

  it("shape reports the flag from intake's row, for a planned spec as for a shaped one", async () => {
    const shape = stepHandler('shape')!;
    item(true);
    const { run: r } = claude();
    const c = { ...ctx(r), step: { id: 'shape', handler: 'shape', needs: [] } };
    expect(await shape(c)).toMatchObject({ outcome: templates.MOCKUP_OUTCOME });
    // A line that links a spec skips shaping, and still gets its mockup.
    expect(await shape({ ...c, features: [{ id: ID, title: 'x', spec: 'project/x.md' }] })).toMatchObject({ outcome: templates.MOCKUP_OUTCOME });

    getDatabase().exec('DELETE FROM factory_intake; DELETE FROM factory_items');
    item(false);
    expect(await shape({ ...c, features: [{ id: ID, title: 'x', spec: 'project/x.md' }] })).toEqual({ outcome: templates.DONE });
  });

  it('tells shaping the mockup is its own step, so the spec never plans a mockup file into the repo', async () => {
    item(true);
    const { run: r, calls } = claude();
    await stepHandler('shape')!({ ...ctx(r), step: { id: 'shape', handler: 'shape', needs: [] } });
    expect(calls[0].prompt).toContain('Do not plan a mockup file or page in the spec');
  });

  it('an unflagged item runs straight from shape to implement, no mockup run', async () => {
    item(false);
    const { run: r, calls } = claude();
    await run(engineDeps(r));
    expect(stages(calls)).not.toContain('mockup');
    expect(stages(calls).slice(0, 2)).toEqual(['shape', 'implement']);
  });
});

describe('the mockup step', () => {
  it('writes only into the item’s mockup folder under the data dir, and parks for approval', async () => {
    item(true);
    const { run: r, calls } = claude();
    const c = ctx(r);
    expect(await mockupStep(c)).toEqual({ park: MOCKUP_READY });

    const call = calls[0];
    // Runs in the worktree, which is read-only (no allowed globs: runClaude reverts every edit there) …
    expect(call.cwd).toBe(worktree);
    expect(call.globs).toEqual([]);
    // … with only the mockup folder added, and nothing to run.
    expect(call.opts.addDirs).toEqual([DIR]);
    expect(resolve(DIR).startsWith(resolve(dataDir, 'factory', HASH, ID))).toBe(true);
    expect(call.opts.allowedTools).not.toContain('Bash');
    expect(call.opts.tag).toMatchObject({ kind: 'factory', stage: 'mockup', projectCwd: CWD });
    expect(call.prompt).toContain('REPLICA OF THE REAL PAGE');
    expect(call.prompt).toContain(join(DIR, files.MOCKUP_PAGE));

    // The step's own write (the walkthrough) is in the folder; the worktree has nothing.
    expect(readFileSync(join(DIR, files.MOCKUP_WALKTHROUGH), 'utf-8')).toContain("What you'd do");
    expect(readdirSync(worktree)).toEqual([]);
    expect(files.readMockupState(c.progress)).toEqual({ session: 'mock-1', revisions: 0, comment: null, ready: true });
  });

  it('parks without a page when the run wrote none, and a stale page never passes for a new one', async () => {
    item(true);
    mkdirSync(DIR, { recursive: true });
    writeFileSync(join(DIR, files.MOCKUP_PAGE), 'from a failed attempt');
    const { run: r } = claude({ page: false });
    const c = ctx(r);
    const result = await mockupStep(c);
    expect(result).toMatchObject({ park: expect.stringContaining('wrote no index.html') });
    expect(files.readMockupState(c.progress).ready).toBe(false);
    expect(existsSync(join(DIR, files.MOCKUP_PAGE))).toBe(false);
  });

  it('a comment whose run wrote no page spends no revision and is kept for the next try', async () => {
    item(true);
    const ok = claude();
    const c = ctx(ok.run);
    await mockupStep(c);
    files.writeMockupState(c.progress, { ...files.readMockupState(c.progress), comment: 'darker' });
    const failing = claude({ page: false });
    c.deps = { ...c.deps, runClaude: failing.run };
    // The resume ran but wrote nothing: the earlier page was not deleted, so remove it as a failed revision would leave none.
    rmSync(join(DIR, files.MOCKUP_PAGE));
    await mockupStep(c);
    expect(files.readMockupState(c.progress)).toMatchObject({ revisions: 0, comment: 'darker', ready: false });
  });

  it('a release without a comment parks again without paying for another run', async () => {
    item(true);
    const { run: r, calls } = claude();
    const c = ctx(r);
    await mockupStep(c);
    expect(await mockupStep(c)).toEqual({ park: MOCKUP_READY });
    expect(calls).toHaveLength(1);
  });

  it('a comment resumes the same mockup session, counts a revision and parks again; past the cap it escalates', async () => {
    item(true);
    const { run: r, calls } = claude();
    const c = ctx(r);
    await mockupStep(c);
    for (let i = 1; i <= files.MOCKUP_REVISIONS_MAX; i++) {
      files.writeMockupState(c.progress, { ...files.readMockupState(c.progress), comment: `change ${i}` });
      const result = await mockupStep(c);
      const last = calls[calls.length - 1];
      expect(last.opts.resumeSessionId).toBe('mock-1');
      expect(last.prompt).toContain(`change ${i}`);
      expect(files.readMockupState(c.progress)).toMatchObject({ revisions: i, comment: null, ready: true });
      if (i < files.MOCKUP_REVISIONS_MAX) expect(result).toEqual({ park: `${MOCKUP_READY} (revision ${i})` });
      else expect(result).toMatchObject({ park: expect.stringContaining(MOCKUP_ESCALATED) });
    }
    // A comment slipped past the cap runs nothing and stays escalated.
    files.writeMockupState(c.progress, { ...files.readMockupState(c.progress), comment: 'one more' });
    const before = calls.length;
    expect(await mockupStep(c)).toMatchObject({ park: expect.stringContaining(MOCKUP_ESCALATED) });
    expect(calls).toHaveLength(before);
  });

  it('a lost mockup session rebuilds from the full prompt, which carries the comment', async () => {
    item(true);
    const { run: r, calls } = claude({ failResume: true });
    const c = ctx(r);
    await mockupStep(c);
    files.writeMockupState(c.progress, { ...files.readMockupState(c.progress), comment: 'bigger buttons' });
    expect(await mockupStep(c)).toEqual({ park: `${MOCKUP_READY} (revision 1)` });
    const last = calls[calls.length - 1];
    expect(last.opts.resumeSessionId).toBeUndefined();
    expect(last.prompt).toContain('REPLICA OF THE REAL PAGE');
    expect(last.prompt).toContain('bigger buttons');
  });
});

describe('--add-dir', () => {
  it('quotes a plain absolute folder and refuses anything a shell could act on', () => {
    expect(addDirArgs(['C:\\Users\\me\\.claude-remote\\factory\\ab\\f-1\\mockup\\'])).toEqual([
      '--add-dir',
      '"C:\\Users\\me\\.claude-remote\\factory\\ab\\f-1\\mockup"',
    ]);
    expect(addDirArgs(undefined)).toEqual([]);
    for (const bad of ['relative\\dir', '\\\\host\\share', '//host/share', 'C:\\a"&calc', 'C:\\100%', '/tmp/$(x)', 'C:\\a\nb']) {
      expect(() => addDirArgs([bad]), bad).toThrow(/Refusing --add-dir/);
    }
  });
});

// ---------------------------------------------------------------------------
// Routes

describe('the serving route', () => {
  let app: FastifyInstance;
  let reads: string[];
  const host = 'localhost:4220';

  beforeEach(async () => {
    reads = [];
    app = Fastify();
    registerMockupRoutes(app, {
      readFile: async (path) => {
        reads.push(path);
        return readFileSync(path);
      },
      dataDir: () => dataDir,
    });
    await app.ready();
    mkdirSync(DIR, { recursive: true });
    writeFileSync(join(DIR, files.MOCKUP_PAGE), '<html>ok</html>');
  });
  afterEach(() => app.close());

  const get = (url: string) => app.inject({ method: 'GET', url, headers: { host } });

  it('serves the page with a sandboxing CSP that lets nothing reach the network', async () => {
    const res = await get(`/api/factory/mockup/${HASH}/${ID}/index.html`);
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe('<html>ok</html>');
    expect(res.headers['content-type']).toContain('text/html');
    const csp = String(res.headers['content-security-policy']);
    expect(csp).toBe(mockupCsp(host, HASH, ID));
    expect(csp).toContain('sandbox allow-scripts');
    expect(csp).not.toContain('allow-same-origin');
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("connect-src 'none'");
    expect(csp).toContain("form-action 'none'");
    expect(csp).toContain(`script-src ${host}/api/factory/mockup/${HASH}/${ID}/ 'unsafe-inline'`);
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(reads).toEqual([join(DIR, files.MOCKUP_PAGE)]);
  });

  it('refuses ../, absolute, drive, UNC, backslash and encoded paths before any filesystem call', async () => {
    const bad = [
      `/api/factory/mockup/${HASH}/${ID}/../../../config.json`,
      `/api/factory/mockup/${HASH}/${ID}/..%2F..%2F..%2Fconfig.json`,
      `/api/factory/mockup/${HASH}/${ID}/%2e%2e/%2e%2e/config.json`,
      `/api/factory/mockup/${HASH}/${ID}/%252e%252e/config.json`,
      `/api/factory/mockup/${HASH}/${ID}/..%5c..%5cconfig.json`,
      `/api/factory/mockup/${HASH}/${ID}/C:/Windows/win.ini`,
      `/api/factory/mockup/${HASH}/${ID}/%2F%2Fevil-host/share/x.html`,
      `/api/factory/mockup/${HASH}/${ID}/%5C%5Cevil-host%5Cshare%5Cx.html`,
      `/api/factory/mockup/${HASH}/${ID}//etc/passwd`,
      `/api/factory/mockup/${HASH}/${ID}/.hidden.html`,
      `/api/factory/mockup/${HASH}/${ID}/index.html:secret`,
      `/api/factory/mockup/${HASH}/${ID}/`,
      `/api/factory/mockup/zzzz/${ID}/index.html`,
      `/api/factory/mockup/${HASH}/..%2F..%2Fx/index.html`,
      `/api/factory/mockup/${HASH}/f-UPPER/index.html`,
    ];
    for (const url of bad) {
      const res = await get(url);
      expect(res.statusCode, url).toBeGreaterThanOrEqual(400);
    }
    expect(reads).toEqual([]);
  });

  it('checks lexically: no absolute, drive, UNC or dot segment survives', () => {
    for (const p of ['\\\\host\\share\\x', '//host/share/x', 'C:\\x', 'C:/x', '/etc/passwd', '..', 'a/../../b', 'a/./b', 'a\\b', '%2e%2e', 'a:b', '']) {
      expect(files.mockupFilePath(dataDir, HASH, ID, p), p).toBeNull();
    }
    expect(files.mockupFilePath(dataDir, HASH, ID, 'img/logo.png')).toBe(join(DIR, 'img', 'logo.png'));
  });

  it('sits behind the access gate: a caller with no identity gets nothing, and no file is read', async () => {
    const gated = Fastify();
    registerAccessGate(gated, { hosts: () => [], verify: async () => null });
    registerMockupRoutes(gated, { readFile: async (p) => (reads.push(p), Buffer.from('x')), dataDir: () => dataDir });
    await gated.ready();
    const res = await gated.inject({ method: 'GET', url: `/api/factory/mockup/${HASH}/${ID}/index.html`, headers: { host }, remoteAddress: '100.64.0.9' });
    expect(res.statusCode).toBe(403);
    expect(reads).toEqual([]);
    await gated.close();
  });
});

describe('approve and comment, end to end through the runner', () => {
  let app: FastifyInstance;
  beforeEach(async () => {
    app = Fastify();
    registerFactoryBoardRoutes(app);
    await app.ready();
  });
  afterEach(() => app.close());
  const post = (url: string, payload: object) => app.inject({ method: 'POST', url, payload });

  it('parks at mockup, revises on a comment, and once approved implement follows the mockup', async () => {
    item(true);
    const { run: r, calls } = claude();
    const deps = engineDeps(r);

    expect(await run(deps)).toEqual({ kind: 'parked', reason: MOCKUP_READY });
    expect(store.getItem(CWD, ID)).toMatchObject({ status: 'parked', step: 'mockup' });
    expect(stages(calls)).toEqual(['shape', 'mockup']);

    // What the drawer reads.
    const info = await app.inject({ method: 'GET', url: `/api/factory/mockup?cwd=${encodeURIComponent(CWD)}&unit=${ID}` });
    expect(info.json()).toMatchObject({
      url: `/api/factory/mockup/${HASH}/${ID}/index.html`,
      walkthrough: expect.stringContaining("What you'd do"),
      revisions: 0,
      maxRevisions: files.MOCKUP_REVISIONS_MAX,
      waiting: true,
      approved: false,
    });

    // "changes" is the review's verb, not the mockup's.
    expect((await post(`/api/factory/items/${ID}/release`, { cwd: CWD, outcome: 'changes', note: 'x' })).statusCode).toBe(409);

    // Comment: back to the same session, parked again.
    const comment = await post(`/api/factory/items/${ID}/mockup/comment`, { cwd: CWD, text: 'Put the toggle at the top' });
    expect(comment.json()).toMatchObject({ ok: true, revision: 1 });
    expect(store.getItem(CWD, ID)?.status).toBe('open');
    expect(await run(deps)).toEqual({ kind: 'parked', reason: `${MOCKUP_READY} (revision 1)` });
    const revise = calls[calls.length - 1];
    expect(revise.opts.tag?.stage).toBe('mockup');
    expect(revise.opts.resumeSessionId).toBe('mock-2');
    expect(revise.prompt).toContain('Put the toggle at the top');

    // Approve: implement starts with the mockup as its brief; the summary and the reviewer get it too.
    expect((await post(`/api/factory/items/${ID}/release`, { cwd: CWD, outcome: 'approved' })).json()).toEqual({ ok: true });
    expect(progressOf().outcomes.mockup).toBe('approved');
    const end = await run(deps);
    expect(end).toEqual({ kind: 'handed-off' });
    const page = join(DIR, files.MOCKUP_PAGE);
    const prompt = (stage: string) => calls.find((c) => c.opts.tag?.stage === stage)?.prompt ?? '';
    expect(prompt('implement')).toContain(`Approved mockup: ${page}`);
    expect(prompt('implement')).toContain('follow its layout');
    expect(prompt('summary')).toContain(`Approved mockup: ${page}`);
    expect(prompt('review')).toContain(`Approved mockup: ${page}`);
    // The worktree got nothing from the mockup step.
    expect(readdirSync(worktree)).toEqual([]);
  });

  it('refuses a comment that is not for a parked mockup, and one past the cap', async () => {
    item(true);
    const { run: r } = claude();
    const deps = engineDeps(r);
    expect((await post(`/api/factory/items/${ID}/mockup/comment`, { cwd: CWD, text: 'x' })).statusCode).toBe(409);
    await run(deps);
    expect((await post(`/api/factory/items/${ID}/mockup/comment`, { cwd: CWD, text: '  ' })).statusCode).toBe(400);

    const state = runState.getRunState(CWD, ID)!;
    files.writeMockupState(state.progress, { ...files.readMockupState(state.progress), revisions: files.MOCKUP_REVISIONS_MAX });
    runState.saveRunState(CWD, ID, { progress: state.progress });
    const capped = await post(`/api/factory/items/${ID}/mockup/comment`, { cwd: CWD, text: 'again' });
    expect(capped.statusCode).toBe(409);
    expect(capped.json().error).toContain('revised 3 times');
    // Refused before any write: nothing waits for the step, the item stays parked.
    expect(files.readMockupState(progressOf()).comment).toBeNull();
    expect(store.getItem(CWD, ID)?.status).toBe('parked');
    // Approve still works at the cap.
    expect((await post(`/api/factory/items/${ID}/release`, { cwd: CWD, outcome: 'approved' })).statusCode).toBe(200);
  });

  it('refuses to approve a mockup the run never wrote', async () => {
    item(true);
    const { run: r } = claude({ page: false });
    await run(engineDeps(r));
    expect(store.getItem(CWD, ID)).toMatchObject({ status: 'parked', step: 'mockup' });
    const res = await post(`/api/factory/items/${ID}/release`, { cwd: CWD, outcome: 'approved' });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toContain('no mockup to approve');
  });
});

describe("Add work's flag, end to end", () => {
  let project: string;
  let app: FastifyInstance;
  let reply: string;

  beforeEach(async () => {
    project = mkdtempSync(join(tmpdir(), 'cr-mockup-proj-'));
    writeFileSync(join(project, 'PROJECT.md'), '## Track: Inbox\n');
    reply = JSON.stringify({ features: [{ title: 'Dark mode toggle', requirements: [], mockupFirst: false }] });
    const deps = {
      intake: { ask: async () => reply },
      send: { ensureTrackBranch: async () => ({}) as never, commitPlanning: async () => null },
      findProject: (cwd: string) => (cwd === project ? { cwd: project } : null),
      projectForCwd: () => null,
      sessionForToken: () => null,
      getSession: () => null,
      trackOfFolder: () => null,
    } as unknown as FactoryRouteDeps;
    app = Fastify();
    registerFactoryRoutes(app, deps);
    await app.ready();
  });
  afterEach(async () => {
    await app.close();
    rmSync(project, { recursive: true, force: true });
  });

  it('the checkbox reaches the intake row, and shaping then sends the item to its mockup', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/factory/add', payload: { cwd: project, text: 'dark mode', mockupFirst: true } });
    expect(res.statusCode).toBe(200);
    const [filed] = res.json().features;
    expect(filed.mockupFirst).toBe(true);
    expect(intakeStore.getIntake(project, filed.featureId)?.mockupFirst).toBe(true);

    const { run: r } = claude();
    const c = { ...ctx(r), unit: { projectCwd: project, unitId: filed.featureId, trackName: 'Inbox', isTrack: false, featureIds: [filed.featureId] } };
    const shaped = await stepHandler('shape')!({ ...c, features: [{ id: filed.featureId, title: 'x', spec: 'project/x.md' }], step: { id: 'shape', handler: 'shape', needs: [] } });
    expect(shaped).toEqual({ outcome: templates.MOCKUP_OUTCOME });
  });

  it('without the option the text decides, and a non-boolean option is refused before intake runs', async () => {
    const plain = await app.inject({ method: 'POST', url: '/api/factory/add', payload: { cwd: project, text: 'dark mode' } });
    expect(plain.json().features[0].mockupFirst).toBe(false);
    const bad = await app.inject({ method: 'POST', url: '/api/factory/add', payload: { cwd: project, text: 'dark mode', mockupFirst: 'yes' } });
    expect(bad.statusCode).toBe(400);
  });
});
