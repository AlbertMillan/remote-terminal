import { describe, it, expect, beforeEach, beforeAll, afterAll, vi } from 'vitest';
import { mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { makeTmpDataDir } from './helpers/tmp-data-dir.js';

/**
 * Sessions claiming factory units (project/code-factory.md, phase 2; f-c4urw6):
 * Take over moves a run's claim to a terminal session atomically and stops the
 * run without resetting its work; a session claim has no lease; a closed
 * terminal leaves the unit paused and claimed; Return resumes it from the last
 * commit; Done goes through review and the merge queue; a session started on a
 * track claims its items. Every outside effect (claude, git, PTYs) is faked.
 */

const dataDir = makeTmpDataDir('factory-session-claims');
const configPath = join(dataDir, 'config.json');
// Review by "me": the review step parks for the user, so a test can see Done reach it.
writeFileSync(configPath, JSON.stringify({ persistence: { dataDir }, factory: { review: { mode: 'me' } } }));
process.env.CLAUDE_REMOTE_CONFIG = configPath;

const { loadConfig } = await import('../src/server/config.js');
const { initDatabase, closeDatabase, getDatabase } = await import('../src/server/db/schema.js');
const store = await import('../src/server/factory/store.js');
const { LEASE_EXPIRY_MS } = await import('../src/server/factory/types.js');
const { RunAbortedError } = await import('../src/server/agent/claude-run.js');
const { Dispatcher, releaseParked } = await import('../src/server/factory/dispatcher.js');
const runState = await import('../src/server/factory/run-state.js');
const claims = await import('../src/server/factory/session-claims.js');
const takeover = await import('../src/server/factory/takeover.js');
const { buildFactoryBoard } = await import('../src/server/factory/board.js');
const { factoryEvents } = await import('../src/server/factory/events.js');
const { DEFAULT_FACTORY_LIMITS } = await import('../src/server/factory/limits.js');
const { TRACK_TEMPLATE } = await import('../src/server/factory/templates.js');
type EngineDeps = import('../src/server/factory/deps.js').EngineDeps;
type MergeEntry = import('../src/server/factory/merge-sink.js').MergeEntry;
type RunOptions = import('../src/server/agent/claude-run.js').RunOptions;
type TakeoverDeps = import('../src/server/factory/takeover.js').TakeoverDeps;

const ALPHA = 'C:\\projects\\alpha';
const T0 = Date.parse('2026-11-26T10:00:00.000Z');
// A real folder: Take over refuses a worktree that is gone.
const WT = join(dataDir, 'wt');
mkdirSync(WT, { recursive: true });

beforeAll(() => {
  loadConfig();
  initDatabase();
});
afterAll(() => closeDatabase());

let clock = T0;
beforeEach(() => {
  clock = T0;
  getDatabase().exec(
    'DELETE FROM factory_session_claims; DELETE FROM factory_runs; DELETE FROM factory_deps; DELETE FROM factory_items; DELETE FROM agent_runs'
  );
  claims.setSessionLiveness({ isRunning: () => false, nameOf: () => null });
});

interface Run {
  prompt: string;
  opts: RunOptions;
}

/** Engine deps whose agent runs wait until aborted while `hold.on`, else answer at once. */
function engine() {
  const runs: Run[] = [];
  const enqueued: MergeEntry[] = [];
  const hold = { on: true };
  let n = 0;
  let head = 0;
  const deps: EngineDeps = {
    runClaude: vi.fn(async (_cwd: string, prompt: string, _globs: string[], o: RunOptions = {}) => {
      runs.push({ prompt, opts: o });
      if (hold.on) {
        await new Promise((_, reject) => {
          if (o.signal?.aborted) reject(new RunAbortedError());
          o.signal?.addEventListener('abort', () => reject(new RunAbortedError()), { once: true });
        });
      }
      const step = o.tag?.stage ?? '?';
      const result = step === 'self-review' ? '{"verdict": "pass", "findings": []}' : `${step} done`;
      return { isError: false, result, permissionDenials: 0, sessionId: o.resumeSessionId ?? `sess-${++n}` };
    }) as unknown as EngineDeps['runClaude'],
    prepareWorktree: async () => ({ path: WT, branch: 'factory/x', baseBranch: 'main' }),
    dirtyFiles: async () => [],
    commit: async () => {
      head++;
      return true;
    },
    headCommit: async () => `sha${head}`,
    features: (_cwd, ids) => ids.map((id) => ({ id, title: `Title ${id}`, spec: `project/${id}.md` })),
    verifyCommands: () => ['npm test'],
    runCommand: async () => ({ ok: true, output: '' }),
    tickFeature: async () => {},
    tokensUsed: () => 0,
    lastSessionOf: () => null,
    writeSummary: () => join(dataDir, 'factory', 'summary.md'),
    planUsage: () => null,
    mergeSink: () => ({ enqueue: (e) => enqueued.push(e) }),
    notify: () => {},
    stepTimeoutMs: () => 60_000,
    now: () => clock,
  };
  return { deps, runs, enqueued, hold };
}

/** Take-over deps: a fake shell, git reduced to a counter. */
function takeoverDeps(dispatcher: InstanceType<typeof Dispatcher> | null, opts: { transcript?: string | null } = {}) {
  const typed: string[] = [];
  const commits: string[] = [];
  const prompts: string[] = [];
  const running = new Set<string>();
  const stopped: string[] = [];
  let shells = 0;
  let head = 100;
  const deps: TakeoverDeps = {
    projectAccount: () => 'personal',
    preflight: () => ({ ok: true }) as ReturnType<TakeoverDeps['preflight']>,
    openShell: async ({ name }) => {
      const id = `shell-${++shells}`;
      return { id, name, type: (line) => typed.push(line) };
    },
    deleteSession: vi.fn(async () => true),
    stopUnit: async (key) => (dispatcher ? dispatcher.stopUnit(key) : false),
    tick: () => void dispatcher?.tick(),
    transcriptExists: () => true,
    lastSessionOf: () => (opts.transcript === undefined ? 'factory-sess' : opts.transcript),
    tokensUsed: () => 0,
    features: (_cwd, ids) => ids.map((id) => ({ id, title: `Title ${id}`, spec: null })),
    trackWorktree: () => ({ path: WT, branch: 'track/x', baseBranch: 'main' }),
    headCommit: async () => `sha${head}`,
    commitAll: async (_path, message) => {
      commits.push(message);
      head++;
      return true;
    },
    writePromptFile: (id, text) => {
      prompts.push(text);
      return join(dataDir, 'prompts', id, 'prompt.md');
    },
    claudeSessionOf: () => 'terminal-transcript',
    sessionName: (id) => `name of ${id}`,
    isSessionRunning: (id) => running.has(id),
    stopSession: async (id) => {
      stopped.push(id);
      running.delete(id);
    },
    announce: () => {},
    now: () => clock,
  };
  return { deps, typed, commits, prompts, running, stopped };
}

function loose(featureId: string) {
  clock += 1000;
  return store.createItem({ projectCwd: ALPHA, featureId, trackName: 'Inbox', workflow: 'item', step: null }, clock);
}

function trackItem(featureId: string, trackName = 'Search') {
  clock += 1000;
  return store.createItem({ projectCwd: ALPHA, featureId, trackName, workflow: 'track' }, clock);
}

/** A loose item past shaping, as if shaped earlier. */
function shaped(featureId: string) {
  loose(featureId);
  const state = runState.ensureRunState(ALPHA, featureId, [], clock);
  state.progress.outcomes.shape = 'done';
  runState.saveRunState(ALPHA, featureId, { progress: state.progress, worktreePath: WT, branch: 'factory/x', baseBranch: 'main' }, clock);
}

const limits = { ...DEFAULT_FACTORY_LIMITS, pauseWhenParked: 99 };
const until = async (cond: () => boolean) => {
  for (let i = 0; i < 200 && !cond(); i++) await new Promise((r) => setTimeout(r, 5));
  expect(cond()).toBe(true);
};

describe('Take over', () => {
  it('moves the claim from the run to the session atomically, stops the run, and keeps its work', async () => {
    shaped('f-aaa111');
    const e = engine();
    const d = new Dispatcher(e.deps, limits);
    await d.tick();
    await until(() => e.runs.length === 1); // implement is running, held
    const runOwner = store.getItem(ALPHA, 'f-aaa111')?.claimOwner;
    expect(runOwner).toMatch(/^run:/);

    const t = takeoverDeps(d);
    const result = await takeover.takeOver({ projectCwd: ALPHA, featureId: 'f-aaa111' }, t.deps);

    expect(result.stoppedRun).toBe(true);
    const item = store.getItem(ALPHA, 'f-aaa111');
    expect(item?.claimKind).toBe('session');
    expect(item?.claimOwner).toBe(claims.sessionOwner(result.sessionId));
    expect(item?.status).toBe('in_progress');
    expect(item?.leaseExpiresAt).toBeNull();
    // The run unwound without touching the unit: shaping kept, the cut step still marked.
    const state = runState.getRunState(ALPHA, 'f-aaa111');
    expect(state?.progress.outcomes.shape).toBe('done');
    expect(state?.progress.current).toBe('implement');
    // It resumes the factory's own conversation, in the unit's worktree.
    expect(result.resumed).toBe('factory-sess');
    expect(t.typed).toEqual([`claude --resume factory-sess --name "Title f-aaa111"`]);
    // The seat it freed does not claim the unit back.
    await d.tick();
    expect(e.runs).toHaveLength(1);
    expect(store.getItem(ALPHA, 'f-aaa111')?.claimKind).toBe('session');
    // The record names the session and the worktree.
    const record = claims.listClaimRecords(ALPHA)[0];
    expect(record).toMatchObject({ unitId: 'f-aaa111', sessionId: result.sessionId, worktreePath: WT, transcriptIds: ['factory-sess'] });
    await d.stop();
  });

  it('briefs a fresh session with the spec and progress when the factory has no conversation to resume', async () => {
    shaped('f-bbb222');
    const t = takeoverDeps(null, { transcript: null });
    const result = await takeover.takeOver({ projectCwd: ALPHA, featureId: 'f-bbb222' }, t.deps);
    expect(result.resumed).toBeNull();
    expect(t.prompts[0]).toContain('f-bbb222 Title f-bbb222');
    expect(t.prompts[0]).toContain('shape: done');
    expect(t.typed[0]).toMatch(/^claude --add-dir ".*" --name "Title f-bbb222" -- "Read .*prompt\.md and follow it\."$/);
  });

  it('takes over a parked unit, clearing its park', async () => {
    shaped('f-ccc333');
    store.updateItem(ALPHA, 'f-ccc333', { status: 'parked', step: 'verify' }, clock);
    const s = runState.getRunState(ALPHA, 'f-ccc333');
    if (s) s.progress.parked = 'verify';
    runState.saveRunState(ALPHA, 'f-ccc333', { progress: s?.progress, parkReason: 'verify failed' }, clock);
    const result = await takeover.takeOver({ projectCwd: ALPHA, featureId: 'f-ccc333' }, takeoverDeps(null).deps);
    expect(store.getItem(ALPHA, 'f-ccc333')?.claimOwner).toBe(claims.sessionOwner(result.sessionId));
    expect(runState.getRunState(ALPHA, 'f-ccc333')?.parkReason).toBeNull();
  });

  it('refuses a unit in the merge queue, one a session holds, and stops nothing when the account is refused', async () => {
    shaped('f-ddd444');
    runState.saveRunState(ALPHA, 'f-ddd444', { handedOffAt: new Date(clock).toISOString() }, clock);
    await expect(takeover.takeOver({ projectCwd: ALPHA, featureId: 'f-ddd444' }, takeoverDeps(null).deps)).rejects.toMatchObject({ status: 409 });

    shaped('f-eee555');
    const first = await takeover.takeOver({ projectCwd: ALPHA, featureId: 'f-eee555' }, takeoverDeps(null).deps);
    await expect(takeover.takeOver({ projectCwd: ALPHA, featureId: 'f-eee555' }, takeoverDeps(null).deps)).rejects.toMatchObject({ status: 409 });
    expect(store.getItem(ALPHA, 'f-eee555')?.claimOwner).toBe(claims.sessionOwner(first.sessionId));

    shaped('f-fff666');
    const t = takeoverDeps(null);
    t.deps.preflight = () => ({ ok: false, account: 'personal', message: 'logged out' }) as unknown as ReturnType<TakeoverDeps['preflight']>;
    const opened = vi.spyOn(t.deps, 'openShell');
    await expect(takeover.takeOver({ projectCwd: ALPHA, featureId: 'f-fff666' }, t.deps)).rejects.toThrow();
    expect(opened).not.toHaveBeenCalled();
    expect(store.getItem(ALPHA, 'f-fff666')?.claimOwner).toBeNull();
  });
});

describe('a session claim has no lease', () => {
  it('is never reclaimed by lease expiry, nor released as an orphan at boot', () => {
    loose('f-ggg777');
    const owner = claims.sessionOwner('s1');
    expect(store.claimForSession(ALPHA, ['f-ggg777'], owner, clock).ok).toBe(true);
    expect(store.reclaimExpiredLeases(clock + 10 * LEASE_EXPIRY_MS)).toEqual([]);
    expect(new Dispatcher(engine().deps, limits).recoverOrphans()).toEqual([]);
    expect(store.getItem(ALPHA, 'f-ggg777')).toMatchObject({ claimOwner: owner, claimKind: 'session', status: 'in_progress' });
  });

  it('is not claimed by dispatch, nor are open siblings of its track', async () => {
    trackItem('f-hhh111');
    trackItem('f-hhh222');
    // The session holds one feature; the other is still open.
    expect(store.claimForSession(ALPHA, ['f-hhh111'], claims.sessionOwner('s1'), clock).ok).toBe(true);
    const e = engine();
    const d = new Dispatcher(e.deps, limits);
    expect(await d.tick()).toEqual([]);
    expect(store.getItem(ALPHA, 'f-hhh222')?.claimOwner).toBeNull();
  });
});

describe('the terminal is the liveness', () => {
  it('shows "session · you" while the terminal runs, paused and still claimed once it closes', () => {
    shaped('f-iii111');
    store.claimForSession(ALPHA, ['f-iii111'], claims.sessionOwner('s9'), clock);
    let running = true;
    claims.setSessionLiveness({ isRunning: () => running, nameOf: () => 'history-search' });
    const live = buildFactoryBoard({ now: clock }).units.find((u) => u.unitId === 'f-iii111');
    expect(live?.claim).toEqual({ sessionId: 's9', sessionName: 'history-search', live: true });
    expect(live?.column).toBe('running');
    expect(live?.stalled).toBeNull(); // no heartbeat expected

    running = false;
    const paused = buildFactoryBoard({ now: clock + 60 * 60_000 }).units.find((u) => u.unitId === 'f-iii111');
    expect(paused?.claim).toEqual({ sessionId: 's9', sessionName: 'history-search', live: false });
    expect(store.getItem(ALPHA, 'f-iii111')?.claimKind).toBe('session');
  });

  it('pushes the feed when a session holding a claim stops or revives, and only then', () => {
    loose('f-jjj111');
    store.claimForSession(ALPHA, ['f-jjj111'], claims.sessionOwner('holder'), clock);
    let fire: (id: string) => void = () => {};
    claims.installSessionLiveness({ isRunning: () => false, nameOf: () => null }, (listener) => {
      fire = listener;
      return () => {};
    });
    const changes = vi.fn();
    const off = factoryEvents.onChange(changes);
    fire('bystander');
    expect(changes).not.toHaveBeenCalled();
    fire('holder');
    expect(changes).toHaveBeenCalledTimes(1);
    off();
  });
});

describe('Return to factory', () => {
  it('commits the leftovers, releases the claim, and the dispatcher resumes from that commit and conversation', async () => {
    shaped('f-kkk111');
    const e = engine();
    const d = new Dispatcher(e.deps, limits);
    await d.tick();
    await until(() => e.runs.length === 1);
    const t = takeoverDeps(d);
    const taken = await takeover.takeOver({ projectCwd: ALPHA, featureId: 'f-kkk111' }, t.deps);
    runState.saveRunState(ALPHA, 'f-kkk111', { sessionId: 'sess-1' }, clock);

    const back = await takeover.releaseSessionClaim({ projectCwd: ALPHA, featureId: 'f-kkk111' }, 'returned', t.deps);
    expect(back.committed).toBe(true);
    expect(t.commits[0]).toContain('Feature: f-kkk111');
    expect(t.commits[0]).toContain(`Factory-Session: ${taken.sessionId}`);
    const state = runState.getRunState(ALPHA, 'f-kkk111');
    expect(state?.lastCommit).toBe(back.head);
    expect(claims.listClaimRecords(ALPHA)[0]).toMatchObject({
      endedBy: 'returned',
      endCommit: back.head,
      transcriptIds: ['factory-sess', 'terminal-transcript'],
    });

    // The release woke the dispatcher, which claimed it straight back for a run, resumed
    // in the conversation at implement (not from scratch) and told what the session left.
    await until(() => e.runs.length >= 2);
    expect(store.getItem(ALPHA, 'f-kkk111')?.claimKind).toBe('run');
    const resumed = e.runs[1];
    expect(resumed.opts.tag?.stage).toBe('implement');
    expect(resumed.opts.resumeSessionId).toBe('sess-1');
    expect(resumed.prompt).toContain(`terminal session "name of ${taken.sessionId}"`);
    expect(resumed.prompt).toContain('handed it back to you unfinished');
    await d.stop();
  });

  it('is refused from a session that does not hold the unit', async () => {
    shaped('f-kkk222');
    await takeover.takeOver({ projectCwd: ALPHA, featureId: 'f-kkk222' }, takeoverDeps(null).deps);
    await expect(
      takeover.releaseSessionClaim({ projectCwd: ALPHA, featureId: 'f-kkk222', sessionId: 'someone-else' }, 'returned', takeoverDeps(null).deps)
    ).rejects.toMatchObject({ status: 403 });
  });
});

describe('Done from a session', () => {
  it('goes through verify, the summary and the review, then the merge queue: never a direct merge', async () => {
    shaped('f-lll111');
    const t = takeoverDeps(null);
    await takeover.takeOver({ projectCwd: ALPHA, featureId: 'f-lll111' }, t.deps);
    await takeover.releaseSessionClaim({ projectCwd: ALPHA, featureId: 'f-lll111' }, 'done', t.deps);
    expect(claims.listClaimRecords(ALPHA)[0].endedBy).toBe('done');

    const e = engine();
    e.hold.on = false;
    const d = new Dispatcher(e.deps, limits);
    await d.tick();
    await until(() => store.getItem(ALPHA, 'f-lll111')?.status === 'parked');
    const steps = e.runs.map((r) => r.opts.tag?.stage);
    expect(steps).not.toContain('implement'); // the session built it
    expect(steps).toEqual(['self-review', 'summary']);
    expect(e.runs[0].prompt).toContain('marked it done');
    expect(e.enqueued).toEqual([]);
    expect(runState.getRunState(ALPHA, 'f-lll111')?.progress.parked).toBe('review');

    // You approve the review: then, and only then, the merge queue.
    releaseParked(ALPHA, 'f-lll111', { outcome: 'approved' }, e.deps);
    await d.tick();
    await until(() => e.enqueued.length === 1);
    expect(e.enqueued[0]).toMatchObject({ kind: 'item', featureIds: ['f-lll111'] });
    await d.stop();
  });

  it('marks a track built as a whole: every feature done, reviewed together', () => {
    const progress = runState.ensureRunState(ALPHA, 'track:Search', [], clock).progress;
    progress.notes['review-feature'] = 'f-x';
    progress.outcomes.verify = 'pass';
    progress.loops.fix = 2;
    takeover.markWorkDone(TRACK_TEMPLATE, progress, ['f-a', 'f-b']);
    expect(progress.outcomes).toEqual({ features: 'done' });
    expect(progress.featuresDone).toEqual(['f-a', 'f-b']);
    expect(progress.loops).toEqual({});
    expect(progress.notes['review-feature']).toBeUndefined();
  });
});

describe('a session started on a track', () => {
  it('claims the track\'s factory items, displacing a run, and the board shows it as yours', async () => {
    trackItem('f-mmm111');
    trackItem('f-mmm222');
    const e = engine();
    const d = new Dispatcher(e.deps, limits);
    await d.tick();
    await until(() => e.runs.length === 1);

    const claim = await takeover.claimTrackForSession(ALPHA, 'Search', 'builder-1', WT, takeoverDeps(d).deps);
    expect(claim.claimed).toEqual(['f-mmm111', 'f-mmm222']);
    for (const id of claim.claimed) expect(store.getItem(ALPHA, id)?.claimOwner).toBe(claims.sessionOwner('builder-1'));
    expect(await d.tick()).toEqual([]);
    claims.setSessionLiveness({ isRunning: () => true, nameOf: () => 'Search' });
    const unit = buildFactoryBoard({ now: clock }).units.find((u) => u.unitId === 'track:Search');
    expect(unit?.claim).toMatchObject({ sessionId: 'builder-1', live: true });
    expect(claims.listClaimRecords(ALPHA)[0]).toMatchObject({ unitId: 'track:Search', trackName: 'Search', sessionId: 'builder-1' });
    await d.stop();
  });

  it('claims nothing on a track without factory work, and reports one another session holds', async () => {
    expect(await takeover.claimTrackForSession(ALPHA, 'Nothing', 's1', WT, takeoverDeps(null).deps)).toEqual({ claimed: [] });
    trackItem('f-nnn111', 'Held');
    store.claimForSession(ALPHA, ['f-nnn111'], claims.sessionOwner('other'), clock);
    const claim = await takeover.claimTrackForSession(ALPHA, 'Held', 's2', WT, takeoverDeps(null).deps);
    expect(claim.claimed).toEqual([]);
    expect(claim.note).toContain('other');
  });
});

describe('code-review fixes', () => {
  it('stops a live holder before the factory resumes in its worktree, unless the holder itself asked', async () => {
    shaped('f-rev111');
    const t = takeoverDeps(null);
    const taken = await takeover.takeOver({ projectCwd: ALPHA, featureId: 'f-rev111' }, t.deps);
    t.running.add(taken.sessionId);
    // Its own `cr factory return`: left running, it needs the answer.
    await takeover.releaseSessionClaim({ projectCwd: ALPHA, featureId: 'f-rev111', sessionId: taken.sessionId, callerId: taken.sessionId }, 'returned', t.deps);
    expect(t.stopped).toEqual([]);

    shaped('f-rev222');
    const again = await takeover.takeOver({ projectCwd: ALPHA, featureId: 'f-rev222' }, t.deps);
    t.running.add(again.sessionId);
    // The board's (or header's) Return: the terminal is stopped first.
    await takeover.releaseSessionClaim({ projectCwd: ALPHA, featureId: 'f-rev222' }, 'done', t.deps);
    expect(t.stopped).toEqual([again.sessionId]);
  });

  it('a take-over that fails after the claim moved gives the unit back and drops the shell', async () => {
    shaped('f-rev333');
    const t = takeoverDeps(null, { transcript: null });
    t.deps.writePromptFile = () => {
      throw new Error('disk full');
    };
    await expect(takeover.takeOver({ projectCwd: ALPHA, featureId: 'f-rev333' }, t.deps)).rejects.toThrow('disk full');
    expect(store.getItem(ALPHA, 'f-rev333')).toMatchObject({ status: 'open', claimOwner: null });
    expect(t.deps.deleteSession).toHaveBeenCalled();
  });

  it('keeps the outcome of a step that finished as the run was stopped, and acts on nothing else', async () => {
    shaped('f-rev444');
    const e = engine();
    e.hold.on = false;
    // implement finishes, but the run is stopped in the same breath (as by a take-over).
    const ac = new AbortController();
    e.deps.commit = async () => {
      ac.abort();
      return true;
    };
    expect(store.claimItem(ALPHA, 'f-rev444', { owner: 'run:x', kind: 'run' }, clock).ok).toBe(true);
    const { runUnit } = await import('../src/server/factory/runner.js');
    const end = await runUnit(
      { ref: { projectCwd: ALPHA, unitId: 'f-rev444', trackName: 'Inbox', isTrack: false, featureIds: ['f-rev444'] }, workflow: 'item', owner: 'run:x', modelTier: null },
      e.deps,
      { signal: ac.signal, limits }
    );
    expect(end.kind).toBe('stopped');
    const progress = runState.getRunState(ALPHA, 'f-rev444')?.progress;
    expect(progress?.outcomes.implement).toBe('done');
    expect(progress?.current).toBeNull();
    expect(e.runs.map((r) => r.opts.tag?.stage)).toEqual(['implement']);
  });
});
