import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * The roll-up's value is entirely in its ordering: a question blocking work
 * right now must not sit below a feature someone marked blocked last month.
 * These tests drive getRollup() against stubbed sources so the ordering is
 * pinned without needing a database or a filesystem.
 */

const board = vi.hoisted(() => ({ current: [] as unknown[] }));
const jobs = vi.hoisted(() => ({ current: [] as unknown[] }));

vi.mock('../src/server/projects/workspace.js', () => ({
  getWorkspaceBoard: () => board.current,
}));
vi.mock('../src/server/jobs/store.js', () => ({
  listJobs: () => jobs.current,
}));

const { getRollup } = await import('../src/server/projects/rollup.js');

const counts = (over: Partial<Record<string, number>> = {}) => ({
  total: 0,
  done: 0,
  in_progress: 0,
  pending: 0,
  blocked: 0,
  ...over,
});

function project(name: string, over: Record<string, unknown> = {}) {
  return {
    cwd: `C:\\p\\${name}`,
    name,
    nested: [],
    registered: true,
    vcs: { kind: 'git', canDispatch: true, needsInit: false, canPush: true, note: null },
    hasDoc: true,
    revision: 'r',
    docPath: '',
    status: 'active',
    verify: [],
    tracks: [],
    counts: counts(),
    lastActivity: '2026-09-13T10:00:00.000Z',
    lastModified: null,
    transcriptCount: 0,
    ...over,
  };
}

function job(over: Record<string, unknown> = {}) {
  return {
    id: 'j1',
    projectCwd: 'C:\\p\\alpha',
    featureId: null,
    title: 'A job',
    status: 'parked',
    stage: 'design',
    gate: 'design',
    approvedGate: null,
    parkReason: 'gate',
    detail: null,
    worktreePath: 'W',
    branch: 'b',
    claudeSessionId: null,
    createdAt: '2026-09-13T09:00:00.000Z',
    updatedAt: '2026-09-13T09:00:00.000Z',
    stages: [],
    ...over,
  };
}

beforeEach(() => {
  board.current = [];
  jobs.current = [];
});
afterEach(() => vi.clearAllMocks());

describe('attention ordering', () => {
  it('puts a blocking question above a failure, a gate and a blocked feature', () => {
    board.current = [
      project('alpha', {
        tracks: [
          {
            name: 'T',
            features: [
              { id: 'f1', status: 'blocked', priority: null, title: 'Blocked thing', spec: null },
            ],
          },
        ],
        counts: counts({ total: 1, blocked: 1 }),
      }),
    ];
    jobs.current = [
      job({ id: 'gate', parkReason: 'gate' }),
      job({ id: 'q', parkReason: 'question', detail: 'Which option?' }),
      job({ id: 'fail', status: 'failed', detail: 'merge refused' }),
    ];

    const kinds = getRollup().attention.map((a) => a.kind);
    expect(kinds).toEqual(['question', 'failed', 'gate', 'blocked']);
  });

  it('puts the older item first within the same kind', () => {
    jobs.current = [
      job({ id: 'new', parkReason: 'question', updatedAt: '2026-09-13T18:00:00.000Z' }),
      job({ id: 'old', parkReason: 'question', updatedAt: '2026-09-11T08:00:00.000Z' }),
    ];
    expect(getRollup().attention.map((a) => a.jobId)).toEqual(['old', 'new']);
  });

  it('carries a stage warning into the gate item rather than just naming the gate', () => {
    jobs.current = [job({ gate: 'merge', detail: 'QA incomplete: Unity Editor not running' })];
    expect(getRollup().attention[0].detail).toBe('QA incomplete: Unity Editor not running');
  });

  it('falls back to naming the gate when there is no warning', () => {
    jobs.current = [job({ gate: 'merge', detail: null })];
    expect(getRollup().attention[0].detail).toMatch(/merge gate/);
  });

  it('ignores running, done and cancelled jobs', () => {
    jobs.current = [
      job({ id: 'a', status: 'running', parkReason: null }),
      job({ id: 'b', status: 'done', parkReason: null }),
      job({ id: 'c', status: 'cancelled', parkReason: null }),
      job({ id: 'd', status: 'queued', parkReason: null }),
    ];
    expect(getRollup().attention).toEqual([]);
  });

  it('resolves the project name for each item', () => {
    board.current = [project('alpha')];
    jobs.current = [job({ projectCwd: 'C:/P/ALPHA' })];
    expect(getRollup().attention[0].projectName).toBe('alpha');
  });
});

describe('in flight', () => {
  it('lists running jobs with their current stage', () => {
    board.current = [project('alpha')];
    jobs.current = [
      job({ id: 'r', status: 'running', parkReason: null, stage: 'implement' }),
      job({ id: 'p', status: 'parked' }),
    ];
    const rollup = getRollup();
    expect(rollup.inFlight).toEqual([
      { jobId: 'r', projectName: 'alpha', title: 'A job', stage: 'implement' },
    ]);
  });
});

describe('project summaries and totals', () => {
  it('counts jobs per project', () => {
    board.current = [project('alpha'), project('beta')];
    jobs.current = [
      job({ projectCwd: 'C:\\p\\alpha', status: 'running', parkReason: null }),
      job({ projectCwd: 'C:\\p\\alpha', status: 'parked' }),
      job({ projectCwd: 'C:\\p\\beta', status: 'failed' }),
    ];
    const byName = Object.fromEntries(getRollup().projects.map((p) => [p.name, p]));
    expect(byName.alpha.runningJobs).toBe(1);
    expect(byName.alpha.waitingJobs).toBe(1);
    expect(byName.beta.waitingJobs).toBe(1);
  });

  it('aggregates feature counts across projects', () => {
    board.current = [
      project('alpha', { counts: counts({ total: 4, done: 2, in_progress: 1, blocked: 1 }) }),
      project('beta', { counts: counts({ total: 2, done: 1 }), hasDoc: true }),
      project('gamma', { hasDoc: false }),
    ];
    expect(getRollup().totals).toMatchObject({
      projects: 3,
      withDoc: 2,
      features: 6,
      done: 3,
      inProgress: 1,
      blocked: 1,
    });
  });

  it('handles an empty machine without throwing', () => {
    const rollup = getRollup();
    expect(rollup.attention).toEqual([]);
    expect(rollup.projects).toEqual([]);
    expect(rollup.totals.projects).toBe(0);
  });
});
