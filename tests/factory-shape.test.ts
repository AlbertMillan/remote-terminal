import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { makeTmpDataDir } from './helpers/tmp-data-dir.js';

/**
 * The shaping pass (project/code-factory.md, f-wlr5dc): a spec and a tier,
 * a blocking question that parks the item and the answer that resumes the
 * session that asked, the overlap check's inferred edges, and the runner
 * filing discovered work and requeueing an item that now waits. No claude is
 * ever spawned: runClaude is a fake that answers in turn.
 */

const dataDir = makeTmpDataDir('factory-shape');
const configPath = join(dataDir, 'config.json');
writeFileSync(configPath, JSON.stringify({ persistence: { dataDir }, factory: { review: { mode: 'me' } } }));
process.env.CLAUDE_REMOTE_CONFIG = configPath;

const { loadConfig } = await import('../src/server/config.js');
const { initDatabase, closeDatabase, getDatabase } = await import('../src/server/db/schema.js');
const store = await import('../src/server/factory/store.js');
const intakeStore = await import('../src/server/factory/intake-store.js');
const shape = await import('../src/server/factory/shape-step.js');
const { emptyProgress } = await import('../src/server/factory/templates.js');
const { answerItem } = await import('../src/server/factory/factory-routes.js');
const { runUnit } = await import('../src/server/factory/runner.js');
type EngineDeps = import('../src/server/factory/deps.js').EngineDeps;
type StepContext = import('../src/server/factory/steps.js').StepContext;
type RunOptions = import('../src/server/agent/claude-run.js').RunOptions;
type DiscoveredWork = import('../src/server/factory/triage.js').DiscoveredWork;

const CWD = 'C:\\projects\\shape';
const ID = 'f-shape1';

beforeAll(() => {
  loadConfig();
  initDatabase();
});
afterAll(() => closeDatabase());

beforeEach(() => {
  getDatabase().exec('DELETE FROM factory_runs; DELETE FROM factory_intake; DELETE FROM factory_deps; DELETE FROM factory_items');
});

interface Call {
  prompt: string;
  opts: RunOptions;
}

/** A runClaude answering `replies` in turn (a function reply may throw). */
function claude(replies: (string | (() => string))[]) {
  const calls: Call[] = [];
  let n = 0;
  const run = vi.fn(async (_cwd: string, prompt: string, _globs: string[], opts: RunOptions = {}) => {
    calls.push({ prompt, opts });
    const next = replies.shift();
    const result = typeof next === 'function' ? next() : (next ?? '');
    return { isError: false, result, permissionDenials: 0, sessionId: opts.resumeSessionId ?? `sess-${++n}` };
  });
  return { run: run as unknown as EngineDeps['runClaude'], calls };
}

function item(featureId = ID, requirements: string[] = []) {
  store.createItem({ projectCwd: CWD, featureId, trackName: 'Inbox', workflow: 'item' });
  intakeStore.insertIntake({ projectCwd: CWD, featureId, source: 'intake', requirements });
}

function ctx(run: EngineDeps['runClaude'], featureId = ID, spec: string | null = null): StepContext {
  return {
    unit: { projectCwd: CWD, unitId: featureId, trackName: 'Inbox', isTrack: false, featureIds: [featureId] },
    features: [{ id: featureId, title: `Title ${featureId}`, spec }],
    worktree: { path: `C:\\wt\\${featureId}`, branch: `factory/${featureId}`, baseBranch: 'main' },
    progress: emptyProgress(),
    step: { id: 'shape', handler: 'shape', needs: [] },
    signal: new AbortController().signal,
    deps: { runClaude: run, stepTimeoutMs: () => 60_000 } as unknown as EngineDeps,
    agent: vi.fn(),
    commit: vi.fn(),
    saveProgress: vi.fn(),
  };
}

const specReply = (files: string[], extra: Record<string, unknown> = {}) =>
  JSON.stringify({
    spec: { goal: 'Make it so', acceptance: ['it is so'], files, assumptions: ['blue, not green'] },
    tier: 'haiku',
    ...extra,
  });

const QUESTION = JSON.stringify({ question: 'Per user or per device?', options: ['per user', 'per device'], default: 'per device' });

describe('parseShapeReply', () => {
  it('reads a spec or a question and nothing else', () => {
    expect(shape.parseShapeReply(specReply(['a.ts']))).toMatchObject({ kind: 'spec', tier: 'haiku', spec: { files: ['a.ts'] } });
    expect(shape.parseShapeReply(QUESTION)).toEqual({
      kind: 'question',
      question: { question: 'Per user or per device?', options: ['per user', 'per device'], default: 'per device' },
    });
    for (const bad of [
      'just do it',
      '{"spec": {"goal": "x", "acceptance": []}}',
      '{"question": "x?", "options": ["only one"], "default": "only one"}',
      '{"question": "x?", "options": ["a", "b"], "default": "c"}',
    ]) {
      expect(shape.parseShapeReply(bad), bad).toBeNull();
    }
    // An unknown tier is dropped, not refused.
    expect(shape.parseShapeReply(specReply([], { tier: 'gpt' }))).toMatchObject({ kind: 'spec', tier: null });
  });
});

describe('shapeStep', () => {
  it('writes the spec the later steps read, sets the tier and records its assumptions', async () => {
    item(ID, ['remember per device']);
    const { run, calls } = claude([specReply(['src/a.ts'], { discovered: [{ title: 'Old bug', detail: 'b.ts' }] })]);
    const c = ctx(run);
    const result = await shape.shapeStep(c);

    expect(result).toEqual({ outcome: 'done', discovered: [{ title: 'Old bug', detail: 'b.ts' }] });
    expect(calls[0].opts).toMatchObject({ allowedTools: ['Read', 'Glob', 'Grep'], model: shape.SHAPE_MODEL });
    expect(calls[0].opts.tag).toMatchObject({ projectCwd: CWD, kind: 'factory', stage: 'shape' });
    expect(calls[0].prompt).toContain('- remember per device');
    const rec = intakeStore.getIntake(CWD, ID);
    expect(rec).toMatchObject({ files: ['src/a.ts'], assumptions: ['blue, not green'] });
    expect(rec?.specPath).toBe(shape.specPathFor(CWD, ID));
    const md = readFileSync(rec?.specPath as string, 'utf-8');
    expect(md).toContain('## Acceptance criteria\n\n- it is so');
    expect(md).toContain('## Requirements (from the request)\n\n- remember per device');
    expect(store.getItem(CWD, ID)?.modelTier).toBe('haiku');
    expect(c.progress.notes.shape).toBe('- blue, not green');
  });

  it("keeps the tier the sender chose", async () => {
    item();
    store.updateItem(CWD, ID, { modelTier: 'opus' });
    await shape.shapeStep(ctx(claude([specReply([])]).run));
    expect(store.getItem(CWD, ID)?.modelTier).toBe('opus');
  });

  it('runs nothing for an item already shaped or a line that links a spec', async () => {
    item();
    const first = claude([specReply(['a.ts'])]);
    await shape.shapeStep(ctx(first.run));
    const again = claude([]);
    expect(await shape.shapeStep(ctx(again.run))).toEqual({ outcome: 'done', discovered: [] });
    store.createItem({ projectCwd: CWD, featureId: 'f-planned', trackName: 'Inbox', workflow: 'item' });
    expect(await shape.shapeStep(ctx(again.run, 'f-planned', 'project/planned.md'))).toEqual({ outcome: 'done' });
    expect(again.calls).toEqual([]);
  });

  it('parks on a blocking question; the answer resumes the session that asked', async () => {
    item();
    const { run, calls } = claude([QUESTION, specReply(['a.ts'])]);
    const asking = ctx(run);
    const parked = await shape.shapeStep(asking);
    // Where the Factory overlay reads it.
    expect(JSON.parse(asking.progress.notes[shape.QUESTIONS_NOTE])).toEqual([
      { question: 'Per user or per device?', options: ['per user', 'per device'], default: 'per device' },
    ]);
    expect(parked).toEqual({ park: 'shape: question: Per user or per device?\nOptions: per user | per device\nDefault: per device' });
    expect(intakeStore.getIntake(CWD, ID)).toMatchObject({ question: { default: 'per device' }, shapeSessionId: 'sess-1', answer: null });

    // The runner parks the item; the answer puts it back in the queue.
    store.updateItem(CWD, ID, { status: 'parked', step: 'shape' });
    expect(answerItem({ cwd: CWD }, ID, '  per user ')).toEqual({ featureId: ID, queued: true });
    expect(store.getItem(CWD, ID)?.status).toBe('open');

    const done = await shape.shapeStep(ctx(run));
    expect(done).toMatchObject({ outcome: 'done' });
    expect(calls[1].opts.resumeSessionId).toBe('sess-1');
    expect(calls[1].prompt).toContain('Answer: per user');
    const rec = intakeStore.getIntake(CWD, ID);
    expect(rec?.question).toBeNull();
    expect(readFileSync(rec?.specPath as string, 'utf-8')).toContain('- Per user or per device? → per user');
  });

  it('asks afresh, with the answer, when the asking session cannot be resumed', async () => {
    item();
    const { run, calls } = claude([
      QUESTION,
      () => {
        throw new Error('No conversation found');
      },
      specReply([]),
    ]);
    await shape.shapeStep(ctx(run));
    store.updateItem(CWD, ID, { status: 'parked', step: 'shape' });
    answerItem({ cwd: CWD }, ID, 'per user');
    expect(await shape.shapeStep(ctx(run))).toMatchObject({ outcome: 'done' });
    expect(calls[2].opts.resumeSessionId).toBeUndefined();
    expect(calls[2].prompt).toContain('The user answered: per user');
  });

  it('refuses an answer for an item not waiting on a question', () => {
    item();
    expect(() => answerItem({ cwd: CWD }, ID, 'x')).toThrow(/not waiting on a question/);
    expect(() => answerItem({ cwd: CWD }, ID, '  ')).toThrow(/answer is required/);
    expect(() => answerItem({ cwd: CWD }, 'f-nothere', 'x')).toThrow(/not a factory item/);
  });

  it('parks when the reply is neither a spec nor a question', async () => {
    item();
    const result = await shape.shapeStep(ctx(claude(['I think it is fine']).run));
    expect(result).toMatchObject({ park: expect.stringMatching(/^shape: the shaping run gave no valid spec/) });
  });
});

describe('overlap check', () => {
  it('makes an item wait for open items already shaped that touch the same files', async () => {
    item('f-first1');
    await shape.shapeStep(ctx(claude([specReply(['src/App.ts', 'README.md'])]).run, 'f-first1'));
    item('f-other1');
    await shape.shapeStep(ctx(claude([specReply(['docs/x.md'])]).run, 'f-other1'));
    item('f-done01');
    await shape.shapeStep(ctx(claude([specReply(['src/app.ts'])]).run, 'f-done01'));
    // f-done01 shaped after f-first1 and shares its file: it waits for it.
    store.updateItem(CWD, 'f-done01', { status: 'done' });

    item(ID);
    const result = await shape.shapeStep(ctx(claude([specReply(['.\\src\\app.ts'])]).run));
    expect(result).toMatchObject({ outcome: 'done', requeue: expect.stringContaining('waits for f-first1 (src/App.ts)') });
    const blocks = store.listDependencies(CWD, ID).filter((d) => d.fromFeature === ID);
    expect(blocks).toMatchObject([{ toFeature: 'f-first1', type: 'blocks', inferred: true }]);
    expect(store.readyItems(CWD).map((i) => i.featureId)).not.toContain(ID);

    // The blocker merges: the hint goes and the item is ready again.
    store.updateItem(CWD, 'f-first1', { status: 'done' });
    expect(store.readyItems(CWD).map((i) => i.featureId)).toContain(ID);
  });

  it('skips an edge that would close a cycle', () => {
    item('f-cyc001');
    item('f-cyc002');
    intakeStore.updateIntake(CWD, 'f-cyc001', { files: ['a.ts'] });
    store.addDependency({ projectCwd: CWD, fromFeature: 'f-cyc001', toFeature: 'f-cyc002', type: 'blocks' });
    expect(shape.inferOverlap(CWD, 'f-cyc002', ['a.ts'])).toEqual([]);
  });
});

describe('the runner around shaping', () => {
  function engine(replies: Record<string, string[]>) {
    const filed: { from: string; work: DiscoveredWork[] }[] = [];
    const stages: string[] = [];
    const deps = {
      runClaude: (async (_cwd: string, _prompt: string, _globs: string[], o: RunOptions = {}) => {
        const stage = o.tag?.stage ?? '?';
        stages.push(`${stage}:${o.model ?? '-'}`);
        const result = replies[stage]?.shift() ?? (stage === 'self-review' ? '{"verdict": "pass", "findings": []}' : `${stage} done`);
        return { isError: false, result, permissionDenials: 0, sessionId: 'sess-x' };
      }) as unknown as EngineDeps['runClaude'],
      prepareWorktree: async (unit: { unitId: string }) => ({ path: `C:\\wt\\${unit.unitId}`, branch: `factory/${unit.unitId}`, baseBranch: 'main' }),
      dirtyFiles: async () => [],
      commit: async () => true,
      headCommit: async () => 'sha',
      features: (_cwd: string, ids: string[]) => ids.map((id) => ({ id, title: `Title ${id}`, spec: null })),
      verifyCommands: () => [],
      runCommand: async () => ({ ok: true, output: '' }),
      tickFeature: async () => {},
      tokensUsed: () => 0,
      lastSessionOf: () => null,
      writeSummary: () => 'summary.md',
      planUsage: () => null,
      mergeSink: () => ({ enqueue: () => {} }),
      fileDiscovered: async (_cwd: string, from: string, work: DiscoveredWork[]) => {
        filed.push({ from, work });
        return work.map((_, i) => `f-new00${i}`);
      },
      notify: () => {},
      stepTimeoutMs: () => 60_000,
      now: () => Date.now(),
    } satisfies EngineDeps;
    return { deps, filed, stages };
  }

  const claimed = (featureId: string) => {
    expect(store.claimItem(CWD, featureId, { owner: 'run:t', kind: 'run' }).ok).toBe(true);
    return {
      ref: { projectCwd: CWD, unitId: featureId, trackName: 'Inbox', isTrack: false, featureIds: [featureId] },
      workflow: 'item',
      owner: 'run:t',
      modelTier: null,
    };
  };

  it("files discovered work from shaping's reply and from an agent's fenced block, and uses shaping's tier", async () => {
    item();
    const e = engine({
      shape: [specReply(['a.ts'], { discovered: [{ title: 'From shaping' }] })],
      implement: ['Done.\n```discovered\n[{"title": "From implement", "detail": "x.ts"}]\n```'],
    });
    const end = await runUnit(claimed(ID), e.deps, { signal: new AbortController().signal });
    expect(end).toMatchObject({ kind: 'parked', reason: expect.stringMatching(/^review/) });
    expect(e.filed).toEqual([
      { from: ID, work: [{ title: 'From shaping', detail: null }] },
      { from: ID, work: [{ title: 'From implement', detail: 'x.ts' }] },
    ]);
    // Shaping runs on its own model; the work after it on the tier it chose.
    expect(e.stages.slice(0, 2)).toEqual([`shape:${shape.SHAPE_MODEL}`, 'implement:haiku']);
  });

  it('gives an item that now waits back to the queue, shaping recorded', async () => {
    item('f-first1');
    intakeStore.updateIntake(CWD, 'f-first1', { files: ['a.ts'] });
    item();
    const e = engine({ shape: [specReply(['a.ts'])] });
    const end = await runUnit(claimed(ID), e.deps, { signal: new AbortController().signal });
    expect(end).toEqual({ kind: 'deferred', reason: expect.stringContaining('waits for f-first1') });
    expect(store.getItem(CWD, ID)).toMatchObject({ status: 'open', claimOwner: null, step: 'shape' });
    const state = getDatabase().prepare('SELECT progress FROM factory_runs WHERE unit_id = ?').get(ID) as { progress: string };
    expect(JSON.parse(state.progress).outcomes).toEqual({ shape: 'done' });
  });
});
