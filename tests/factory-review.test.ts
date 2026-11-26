import { describe, it, expect, beforeEach, beforeAll, afterAll, vi } from 'vitest';
import Fastify from 'fastify';
import { readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { makeTmpDataDir } from './helpers/tmp-data-dir.js';

/**
 * The reviewer agent (project/code-factory.md, f-o5veqv): verdict parsing,
 * the escalation rules, the three modes, the changes → fix → re-review loop
 * and its cap, review per track or per feature, and Settings → Factory.
 * runClaude and git are fakes: no claude is ever spawned.
 */

const dataDir = makeTmpDataDir('factory-review');
const configPath = join(dataDir, 'config.json');
writeFileSync(configPath, JSON.stringify({ persistence: { dataDir } }));
process.env.CLAUDE_REMOTE_CONFIG = configPath;

const { loadConfig, getConfig, setFactoryReviewConfig } = await import('../src/server/config.js');
const { initDatabase, closeDatabase, getDatabase } = await import('../src/server/db/schema.js');
const store = await import('../src/server/factory/store.js');
const { runUnit } = await import('../src/server/factory/runner.js');
const runState = await import('../src/server/factory/run-state.js');
const review = await import('../src/server/factory/review-step.js');
const settingsMod = await import('../src/server/factory/review-settings.js');
type EngineDeps = import('../src/server/factory/deps.js').EngineDeps;
type MergeEntry = import('../src/server/factory/merge-sink.js').MergeEntry;
type RunOptions = import('../src/server/agent/claude-run.js').RunOptions;
type ReviewFacts = import('../src/server/factory/review-step.js').ReviewFacts;
type ReviewVerdict = import('../src/server/factory/review-step.js').ReviewVerdict;

const ALPHA = 'C:\\projects\\alpha';
const T0 = Date.parse('2026-11-26T10:00:00.000Z');

beforeAll(() => {
  loadConfig();
  initDatabase();
});
afterAll(() => closeDatabase());

/** What the fake git probe reports for the unit's diff. */
const git = {
  files: [] as { path: string; lines: number }[],
  pkgBefore: null as string | null,
  pkgAfter: null as string | null,
};

beforeEach(() => {
  getDatabase().exec('DELETE FROM factory_runs; DELETE FROM factory_deps; DELETE FROM factory_items');
  writeFileSync(configPath, JSON.stringify({ persistence: { dataDir } }));
  loadConfig();
  git.files = [{ path: 'src/a.ts', lines: 10 }];
  git.pkgBefore = null;
  git.pkgAfter = null;
  review.setReviewProbe({
    changedFiles: async () => git.files,
    fileAt: async (_wt, _from, side) => (side === 'base' ? git.pkgBefore : git.pkgAfter),
    readText: (path) => {
      try {
        return readFileSync(path, 'utf-8');
      } catch {
        return null;
      }
    },
  });
});

const NO_FACTS = { sensitivePaths: false, newDependencies: [], assumptions: [] };
const approve = (extra: Partial<ReviewVerdict> = {}) => JSON.stringify({ verdict: 'approve', findings: [], escalation: NO_FACTS, ...extra });
const changes = (issue = 'missing null check') =>
  JSON.stringify({ verdict: 'changes', findings: [{ file: 'src/a.ts', line: 3, issue }], escalation: NO_FACTS });

interface Run {
  prompt: string;
  globs: string[];
  opts: RunOptions;
}

function fake(opts: { review?: (n: number) => string; summary?: string } = {}) {
  const runs: Run[] = [];
  const enqueued: MergeEntry[] = [];
  const commits: string[] = [];
  let sessions = 0;
  const deps: EngineDeps = {
    runClaude: vi.fn(async (_cwd: string, prompt: string, globs: string[], o: RunOptions = {}) => {
      runs.push({ prompt, globs, opts: o });
      const step = o.tag?.stage ?? '?';
      const n = runs.filter((r) => r.opts.tag?.stage === step).length;
      const result =
        step === 'review'
          ? (opts.review?.(n) ?? approve())
          : step === 'self-review'
            ? '{"verdict": "pass", "findings": []}'
            : step === 'summary'
              ? (opts.summary ?? '## What changed\nstuff\n## Assumptions\nNone.')
              : `${step} done`;
      return { isError: false, result, permissionDenials: 0, sessionId: o.resumeSessionId ?? `sess-${++sessions}` };
    }) as unknown as EngineDeps['runClaude'],
    prepareWorktree: async (unit) => ({ path: `C:\\wt\\${unit.unitId}`, branch: `factory/${unit.unitId}`, baseBranch: 'main' }),
    dirtyFiles: async () => [],
    commit: async (_path, message) => {
      commits.push(message);
      return true;
    },
    headCommit: async () => `sha${commits.length}`,
    features: (_cwd, ids) => ids.map((id) => ({ id, title: `Title ${id}`, spec: `project/${id}.md` })),
    verifyCommands: () => ['npm test'],
    runCommand: async () => ({ ok: true, output: '' }),
    tickFeature: async () => {},
    tokensUsed: () => 0,
    lastSessionOf: () => null,
    writeSummary: (_cwd, unitId, markdown) => {
      const path = join(dataDir, `summary-${unitId.replace(/[^a-z0-9-]/gi, '-')}.md`);
      writeFileSync(path, markdown);
      return path;
    },
    planUsage: () => null,
    mergeSink: () => ({ enqueue: (e) => enqueued.push(e) }),
    notify: () => {},
    stepTimeoutMs: () => 60_000,
    now: () => T0,
  };
  return { deps, runs, enqueued, commits, reviews: () => runs.filter((r) => r.opts.tag?.stage === 'review') };
}

const OWNER = { owner: 'run:test', kind: 'run' as const };
const signal = () => new AbortController().signal;

function looseUnit(featureId = 'f-aaa111') {
  store.createItem({ projectCwd: ALPHA, featureId, trackName: 'Inbox', workflow: 'item' }, T0);
  expect(store.claimItem(ALPHA, featureId, OWNER, T0).ok).toBe(true);
  return {
    ref: { projectCwd: ALPHA, unitId: featureId, trackName: 'Inbox', isTrack: false, featureIds: [featureId] },
    workflow: 'item',
    owner: OWNER.owner,
    modelTier: null,
  };
}

function trackUnit(ids: string[], override?: 'track' | 'feature') {
  for (const id of ids) {
    store.createItem({ projectCwd: ALPHA, featureId: id, trackName: 'Factory', workflow: 'track', reviewGranularity: override }, T0);
    expect(store.claimItem(ALPHA, id, OWNER, T0).ok).toBe(true);
  }
  return {
    ref: { projectCwd: ALPHA, unitId: 'track:Factory', trackName: 'Factory', isTrack: true, featureIds: ids },
    workflow: 'track',
    owner: OWNER.owner,
    modelTier: null,
  };
}

const parkReason = (unitId = 'f-aaa111') => runState.getRunState(ALPHA, unitId)?.parkReason ?? '';

// ---------------------------------------------------------------------------

describe('verdict parsing', () => {
  it('reads a verdict that is the whole reply, or its closing ```json block', () => {
    expect(review.parseReviewVerdict(approve())).toEqual({ verdict: 'approve', findings: [], escalation: NO_FACTS });
    const fenced = `I read the diff.\n\n\`\`\`json\n${changes()}\n\`\`\``;
    expect(review.parseReviewVerdict(fenced)).toMatchObject({
      verdict: 'changes',
      findings: [{ file: 'src/a.ts', line: 3, issue: 'missing null check' }],
    });
    const noLine = JSON.stringify({ verdict: 'changes', findings: [{ file: 'a', line: null, issue: 'x' }], escalation: NO_FACTS });
    expect(review.parseReviewVerdict(noLine)?.findings[0].line).toBeNull();
  });

  it.each([
    ['garbage', 'lgtm, ship it'],
    ['empty', ''],
    ['truncated JSON', approve().slice(0, 20)],
    ['an unknown verdict', JSON.stringify({ verdict: 'pass', findings: [], escalation: NO_FACTS })],
    ['changes with no findings', JSON.stringify({ verdict: 'changes', findings: [], escalation: NO_FACTS })],
    ['a finding without an issue', JSON.stringify({ verdict: 'changes', findings: [{ file: 'a', line: 1 }], escalation: NO_FACTS })],
    ['a fractional line', JSON.stringify({ verdict: 'changes', findings: [{ file: 'a', line: 1.5, issue: 'x' }], escalation: NO_FACTS })],
    ['no escalation facts', JSON.stringify({ verdict: 'approve', findings: [] })],
    ['mistyped escalation facts', JSON.stringify({ verdict: 'approve', findings: [], escalation: { ...NO_FACTS, sensitivePaths: 'no' } })],
    ['prose after the JSON', `${approve()}\nThanks!`],
    ['a sample block mid-reply', `\`\`\`json\n${approve()}\n\`\`\`\nBut really I have concerns.`],
  ])('counts %s as no verdict', (_label, text) => {
    expect(review.parseReviewVerdict(text)).toBeNull();
  });
});

describe('escalation rules', () => {
  const settings = settingsMod.DEFAULT_REVIEW_SETTINGS;
  const verdict = review.parseReviewVerdict(approve())!;
  const facts = (over: Partial<ReviewFacts> = {}): ReviewFacts => ({
    sensitiveFiles: [],
    changedLines: 10,
    addedDependencies: [],
    assumptions: [],
    fixLoops: 0,
    ...over,
  });
  const all = { ...settings, rules: { ...settings.rules, newDependency: true } };

  it('a clean unit matches none', () => {
    expect(review.escalationReasons(all, facts(), verdict)).toEqual([]);
  });

  it.each([
    ['sensitivePaths', facts({ sensitiveFiles: ['src/server/auth/access-gate.ts'] }), /auth, the access gate/],
    ['largeDiff', facts({ changedLines: 601 }), /601 changed lines \(over 600/],
    ['fixLoops', facts({ fixLoops: 2 }), /2 fix loops/],
    ['assumptions', facts({ assumptions: ['used UTC'] }), /assumptions instead of asking: used UTC/],
    ['newDependency', facts({ addedDependencies: ['left-pad'] }), /adds a dependency \(left-pad\)/],
  ] as const)('%s matches, and is silent when switched off', (rule, f, reason) => {
    expect(review.escalationReasons(all, f, verdict)).toEqual([expect.stringMatching(reason)]);
    const off = { ...all, rules: { ...all.rules, [rule]: false } };
    expect(review.escalationReasons(off, f, verdict)).toEqual([]);
  });

  it('the diff rule takes its threshold from the settings', () => {
    expect(review.escalationReasons({ ...all, largeDiffLines: 1000 }, facts({ changedLines: 900 }), verdict)).toEqual([]);
  });

  it("adds the reviewer's own facts to what git shows", () => {
    const seen = review.parseReviewVerdict(
      approve({ escalation: { sensitivePaths: true, newDependencies: ['zod'], assumptions: ['kept v1 API'] } })
    )!;
    expect(review.escalationReasons(all, facts(), seen)).toHaveLength(3);
  });

  it('only new dependencies are off by default', () => {
    expect(settings.rules).toEqual({ sensitivePaths: true, largeDiff: true, fixLoops: true, assumptions: true, newDependency: false });
  });

  it('knows sensitive paths, what counts toward the diff, added dependencies and summary assumptions', () => {
    for (const p of ['src/server/auth/tailscale.ts', 'src/server/auth/access-gate.ts', 'src/server/accounts.ts', 'src/server/db/schema.ts', 'db/migrations/001.sql']) {
      expect(review.isSensitivePath(p)).toBe(true);
    }
    for (const p of ['src/server/factory/runner.ts', 'src/client/author.ts', 'docs/accountsy-notes/x.md']) {
      expect(review.isSensitivePath(p)).toBe(false);
    }
    for (const p of ['tests/a.test.ts', 'src/a.spec.ts', 'package-lock.json', 'sub/yarn.lock', 'dist/app.js', 'x.min.js', 'tests/fixtures/protocol/messages.json']) {
      expect(review.countsTowardDiff(p)).toBe(false);
    }
    expect(review.countsTowardDiff('src/server/factory/review-step.ts')).toBe(true);

    expect(review.addedDependencies('{"dependencies":{"a":"1"}}', '{"dependencies":{"a":"2"},"devDependencies":{"b":"1"}}')).toEqual(['b']);
    expect(review.addedDependencies(null, '{"dependencies":{"a":"1"}}')).toEqual(['a']);
    expect(review.addedDependencies('{"dependencies":{"a":"1"}}', '{}')).toEqual([]);

    expect(review.summaryAssumptions('## What changed\nx\n## Assumptions\n- used UTC\n- kept the old route\n## Other\ny')).toEqual([
      'used UTC',
      'kept the old route',
    ]);
    expect(review.summaryAssumptions('## Assumptions\nNone.')).toEqual([]);
    expect(review.summaryAssumptions('## Assumptions (decisions you made instead of asking)\n- (none)\n')).toEqual([]);
    expect(review.summaryAssumptions('no section')).toEqual([]);
  });
});

describe('the review step, by mode', () => {
  it('runs the reviewer read-only on Opus at high effort, tagged, with the /code-review criteria and the spec', async () => {
    const f = fake();
    const end = await runUnit(looseUnit(), f.deps, { signal: signal() });
    expect(end).toEqual({ kind: 'handed-off' });
    const [run] = f.reviews();
    expect(run.globs).toEqual([]);
    expect(run.opts).toMatchObject({ model: 'opus', effort: 'high', laneKey: ALPHA, failOnDenial: false });
    expect(run.opts.allowedTools).not.toContain('Edit');
    expect(run.opts.allowedTools).not.toContain('Write');
    expect(run.opts.tag).toMatchObject({ projectCwd: ALPHA, kind: 'factory', stage: 'review' });
    expect(run.opts.resumeSessionId).toBeUndefined();
    expect(run.prompt).toContain('git diff main...HEAD');
    expect(run.prompt).toContain('project/f-aaa111.md');
    expect(run.prompt).toContain('=== REVIEW CRITERIA ===');
    expect(run.prompt).toMatch(/verify\): pass/);
  });

  it('"me" parks every unit without running the reviewer; approving it moves on to merge', async () => {
    setFactoryReviewConfig({ mode: 'me' });
    const f = fake();
    const end = await runUnit(looseUnit(), f.deps, { signal: signal() });
    expect(end).toMatchObject({ kind: 'parked', reason: expect.stringMatching(/^review: waiting for you/) });
    expect(f.reviews()).toHaveLength(0);
    expect(store.getItem(ALPHA, 'f-aaa111')).toMatchObject({ status: 'parked', step: 'review' });
  });

  it('"agent" merges an approval even when a rule would match', async () => {
    setFactoryReviewConfig({ mode: 'agent' });
    git.files = [{ path: 'src/server/auth/access-gate.ts', lines: 5000 }];
    const f = fake();
    expect(await runUnit(looseUnit(), f.deps, { signal: signal() })).toEqual({ kind: 'handed-off' });
    expect(f.enqueued).toHaveLength(1);
  });

  it('"agent, escalate when risky" (the default) merges a clean approval', async () => {
    const f = fake();
    expect(await runUnit(looseUnit(), f.deps, { signal: signal() })).toEqual({ kind: 'handed-off' });
  });

  it('"agent, escalate when risky" parks a risky approval with the reasons and the verdict', async () => {
    git.files = [
      { path: 'src/server/db/schema.ts', lines: 20 },
      { path: 'src/big.ts', lines: 700 },
      { path: 'tests/big.test.ts', lines: 5000 },
    ];
    const f = fake({
      summary: '## What changed\nx\n## Assumptions\n- chose UTC',
      review: () =>
        JSON.stringify({ verdict: 'approve', findings: [{ file: 'src/big.ts', line: null, issue: 'consider splitting' }], escalation: NO_FACTS }),
    });
    const end = await runUnit(looseUnit(), f.deps, { signal: signal() });
    expect(end.kind).toBe('parked');
    const reason = parkReason();
    expect(reason).toMatch(/^review: escalated: /);
    expect(reason).toContain('src/server/db/schema.ts');
    // schema.ts and src/big.ts; the test file is not counted.
    expect(reason).toContain('720 changed lines');
    expect(reason).toContain('chose UTC');
    expect(reason).toContain('Reviewer: approve\n- src/big.ts: consider splitting');
    expect(f.enqueued).toHaveLength(0);
  });

  it('a new dependency escalates only once its rule is switched on', async () => {
    git.files = [{ path: 'package.json', lines: 1 }];
    git.pkgBefore = '{"dependencies":{}}';
    git.pkgAfter = '{"dependencies":{"left-pad":"1.0.0"}}';
    const f = fake();
    expect(await runUnit(looseUnit('f-aaa111'), f.deps, { signal: signal() })).toEqual({ kind: 'handed-off' });

    setFactoryReviewConfig({ rules: { ...settingsMod.DEFAULT_REVIEW_SETTINGS.rules, newDependency: true } });
    const g = fake();
    expect((await runUnit(looseUnit('f-bbb222'), g.deps, { signal: signal() })).kind).toBe('parked');
    expect(parkReason('f-bbb222')).toContain('adds a dependency (left-pad)');
  });

  it('an unparseable verdict is not approved: it parks for the user', async () => {
    const f = fake({ review: () => 'Looks fine to me!' });
    const end = await runUnit(looseUnit(), f.deps, { signal: signal() });
    expect(end.kind).toBe('parked');
    expect(parkReason()).toMatch(/no valid verdict, so it is not approved[\s\S]*Looks fine to me!/);
    expect(f.enqueued).toHaveLength(0);
  });
});

describe('changes → fix → re-review', () => {
  it('sends the findings to a fix, checks again and re-reviews, then merges on approval', async () => {
    const f = fake({ review: (n) => (n === 1 ? changes('handle the empty list') : approve()) });
    const end = await runUnit(looseUnit(), f.deps, { signal: signal() });
    expect(end).toEqual({ kind: 'handed-off' });
    const steps = f.runs.map((r) => r.opts.tag?.stage);
    expect(steps).toEqual(['implement', 'self-review', 'summary', 'review', 'review-fix', 'self-review', 'summary', 'review']);
    const fix = f.runs.find((r) => r.opts.tag?.stage === 'review-fix')!;
    expect(fix.prompt).toContain('src/a.ts:3: handle the empty list');
    expect(fix.globs).toEqual(['**']);
    // The working conversation carries on into the fix.
    expect(fix.opts.resumeSessionId).toBe('sess-1');
    expect(f.commits).toContain('fix review: Title f-aaa111');
  });

  it('escalates once the reviewer still asks for changes after two fix loops', async () => {
    const f = fake({ review: () => changes('still wrong') });
    const end = await runUnit(looseUnit(), f.deps, { signal: signal() });
    expect(end.kind).toBe('parked');
    expect(f.runs.filter((r) => r.opts.tag?.stage === 'review-fix')).toHaveLength(2);
    expect(f.reviews()).toHaveLength(3);
    expect(parkReason()).toMatch(/^review: escalated: 2 fix loops did not satisfy the reviewer\n\nReviewer: changes\n- src\/a\.ts:3: still wrong/);
    expect(store.getItem(ALPHA, 'f-aaa111')).toMatchObject({ status: 'parked', step: 'review' });
    // Released without an outcome, it gets fix rounds again rather than re-parking at once.
    expect(runState.getRunState(ALPHA, 'f-aaa111')?.progress.loops['review-fix']).toBe(0);
  });

  it('an approval that needed every fix loop escalates under the fix-loop rule, and merges with it off', async () => {
    const f = fake({ review: (n) => (n < 3 ? changes() : approve()) });
    expect((await runUnit(looseUnit('f-aaa111'), f.deps, { signal: signal() })).kind).toBe('parked');
    expect(parkReason('f-aaa111')).toMatch(/took 2 fix loops before the reviewer approved/);

    setFactoryReviewConfig({ rules: { ...settingsMod.DEFAULT_REVIEW_SETTINGS.rules, fixLoops: false } });
    const g = fake({ review: (n) => (n < 3 ? changes() : approve()) });
    expect(await runUnit(looseUnit('f-bbb222'), g.deps, { signal: signal() })).toEqual({ kind: 'handed-off' });
  });
});

describe('review granularity', () => {
  const ids = ['f-ttt001', 'f-ttt002'];

  it('per track (the default): one review of the whole track after all its features', async () => {
    const f = fake();
    const end = await runUnit(trackUnit(ids), f.deps, { signal: signal() });
    expect(end).toEqual({ kind: 'handed-off' });
    expect(f.runs.map((r) => r.opts.tag?.stage)).toEqual(['features', 'features', 'self-review', 'summary', 'review']);
    expect(f.reviews()[0].prompt).toContain('git diff main...HEAD');
    expect(f.reviews()[0].prompt).toContain('f-ttt001');
    expect(f.reviews()[0].prompt).toContain('f-ttt002');
    expect(f.enqueued).toEqual([expect.objectContaining({ kind: 'track', featureIds: ids })]);
  });

  it('per feature (the setting): each feature is checked and reviewed after its own commit, then the track merges once', async () => {
    setFactoryReviewConfig({ granularity: 'feature' });
    const f = fake();
    const end = await runUnit(trackUnit(ids), f.deps, { signal: signal() });
    expect(end).toEqual({ kind: 'handed-off' });
    const round = ['features', 'self-review', 'summary', 'review'];
    expect(f.runs.map((r) => r.opts.tag?.stage)).toEqual([...round, ...round]);
    const [first, second] = f.reviews();
    // Each review sees only its own feature's commits.
    expect(first.prompt).toContain('git diff sha0...HEAD');
    expect(first.prompt).toContain('f-ttt001');
    expect(first.prompt).not.toContain('f-ttt002');
    expect(second.prompt).toContain('git diff sha1...HEAD');
    expect(second.prompt).toContain('f-ttt002');
    expect(second.prompt).not.toContain('f-ttt001');
    expect(f.commits).toEqual(['Title f-ttt001\n\nFeature: f-ttt001', 'Title f-ttt002\n\nFeature: f-ttt002']);
    expect(f.enqueued).toHaveLength(1);
  });

  it('per feature gives each feature its own fix loops', async () => {
    setFactoryReviewConfig({ granularity: 'feature', rules: { ...settingsMod.DEFAULT_REVIEW_SETTINGS.rules, fixLoops: false } });
    // Each feature uses the full two fix loops: shared, the second feature would hit the cap.
    const f = fake({ review: (n) => (n % 3 !== 0 ? changes() : approve()) });
    expect(await runUnit(trackUnit(ids), f.deps, { signal: signal() })).toEqual({ kind: 'handed-off' });
    expect(f.runs.filter((r) => r.opts.tag?.stage === 'review-fix')).toHaveLength(4);
  });

  it('per feature, a run that died after committing a feature resumes its review, not the next feature', async () => {
    setFactoryReviewConfig({ granularity: 'feature' });
    const unit = trackUnit(ids);
    runState.ensureRunState(ALPHA, 'track:Factory');
    const progress = runState.getRunState(ALPHA, 'track:Factory')!.progress;
    progress.featuresDone = ['f-ttt001'];
    progress.current = 'features';
    progress.notes = { 'review-feature': 'f-ttt001', 'review-base': 'sha-before-1' };
    runState.saveRunState(ALPHA, 'track:Factory', { progress });

    const f = fake();
    expect(await runUnit(unit, f.deps, { signal: signal() })).toEqual({ kind: 'handed-off' });
    const steps = f.runs.map((r) => r.opts.tag?.stage);
    // No build first: the round for f-ttt001 goes straight to its checks and review.
    expect(steps.slice(0, 3)).toEqual(['self-review', 'summary', 'review']);
    const [first, second] = f.reviews();
    expect(first.prompt).toContain('git diff sha-before-1...HEAD');
    expect(first.prompt).toContain('f-ttt001');
    expect(first.prompt).not.toContain('f-ttt002');
    expect(second.prompt).toContain('f-ttt002');
    expect(f.runs.filter((r) => r.opts.tag?.stage === 'features')).toHaveLength(1);
  });

  it("a track's own granularity overrides the setting", async () => {
    const f = fake();
    expect(await runUnit(trackUnit(ids, 'feature'), f.deps, { signal: signal() })).toEqual({ kind: 'handed-off' });
    expect(f.reviews()).toHaveLength(2);

    getDatabase().exec('DELETE FROM factory_runs; DELETE FROM factory_items');
    setFactoryReviewConfig({ granularity: 'feature' });
    const g = fake();
    expect(await runUnit(trackUnit(ids, 'track'), g.deps, { signal: signal() })).toEqual({ kind: 'handed-off' });
    expect(g.reviews()).toHaveLength(1);
  });

  it('the store keeps the override and refuses a bad one', () => {
    store.createItem({ projectCwd: ALPHA, featureId: 'f-ggg001', trackName: 'T', workflow: 'track', reviewGranularity: 'feature' }, T0);
    expect(store.getItem(ALPHA, 'f-ggg001')?.reviewGranularity).toBe('feature');
    expect(store.updateItem(ALPHA, 'f-ggg001', { reviewGranularity: null })?.reviewGranularity).toBeNull();
    expect(() => store.updateItem(ALPHA, 'f-ggg001', { reviewGranularity: 'epic' as 'track' })).toThrow(store.FactoryStoreError);
  });
});

describe('Settings → Factory', () => {
  const SAME_ORIGIN = { origin: 'http://localhost:4220', host: 'localhost:4220' };

  async function app(verify: (ip: string) => Promise<unknown> = async () => ({ userId: 'me' })) {
    const a = Fastify();
    settingsMod.registerFactorySettingsRoutes(a, { verify });
    await a.ready();
    return a;
  }
  // The first Fastify boot is slow on a loaded machine; pay it outside the tests' timeouts.
  beforeAll(async () => {
    await (await app()).close();
  }, 60_000);

  const put = async (payload: unknown, headers: Record<string, string> = SAME_ORIGIN) =>
    (await app()).inject({ method: 'PUT', url: '/api/factory/settings', headers, payload: payload as object });

  it('reports the defaults, the fix-loop cap and the engine limits', async () => {
    const res = await (await app()).inject({ method: 'GET', url: '/api/factory/settings' });
    expect(res.json()).toMatchObject({
      mode: 'agent-escalate',
      granularity: 'track',
      largeDiffLines: 600,
      rules: settingsMod.DEFAULT_REVIEW_SETTINGS.rules,
      fixLoopMax: 2,
      limits: { seats: 3, seatsPerProject: 2, pauseWhenParked: 3, runawayTokens: 3_000_000 },
    });
  });

  it('round-trips through config.json: applies at once and survives a reload', async () => {
    const res = await put({ mode: 'me', granularity: 'feature', largeDiffLines: 900, rules: { newDependency: true } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ mode: 'me', granularity: 'feature', largeDiffLines: 900 });
    // One switch sent; the others kept.
    expect(res.json().rules).toEqual({ ...settingsMod.DEFAULT_REVIEW_SETTINGS.rules, newDependency: true });
    expect(settingsMod.factoryReviewSettings().mode).toBe('me');

    loadConfig();
    expect(settingsMod.factoryReviewSettings()).toMatchObject({ mode: 'me', granularity: 'feature', largeDiffLines: 900 });
    const onDisk = JSON.parse(readFileSync(configPath, 'utf-8'));
    // Only what was set is written; other sections stay as they were.
    expect(onDisk.persistence).toEqual({ dataDir });
    expect(Object.keys(onDisk.factory.review).sort()).toEqual(['granularity', 'largeDiffLines', 'mode', 'rules']);
  });

  it.each([
    [{ mode: 'robot' }],
    [{ granularity: 'epic' }],
    [{ largeDiffLines: 10 }],
    [{ largeDiffLines: 600.5 }],
    [{ rules: { sensitivePaths: 'yes' } }],
    [{ rules: { madeUp: true } }],
    [{}],
  ])('refuses %j and changes nothing', async (body) => {
    const res = await put(body);
    expect(res.statusCode).toBe(400);
    expect(getConfig().factory).toBeUndefined();
  });

  it('refuses a cross-origin write and an unverified caller', async () => {
    expect((await put({ mode: 'me' }, { origin: 'https://evil.example', host: 'localhost:4220' })).statusCode).toBe(403);
    const denied = await (await app(async () => null)).inject({
      method: 'PUT',
      url: '/api/factory/settings',
      headers: SAME_ORIGIN,
      payload: { mode: 'me' },
    });
    expect(denied.statusCode).toBe(403);
    expect(settingsMod.factoryReviewSettings().mode).toBe('agent-escalate');
  });

  it('a hand-edited bad value falls back to its default', () => {
    expect(settingsMod.factoryReviewSettings({ mode: 'x', granularity: 3, largeDiffLines: -1, rules: { largeDiff: 'no' } })).toEqual(
      settingsMod.DEFAULT_REVIEW_SETTINGS
    );
  });
});
