import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * getRollup() against a stubbed workspace board: blocked features, oldest
 * first, and the per-project summaries and totals, without a database or a
 * filesystem.
 */

const board = vi.hoisted(() => ({ current: [] as unknown[] }));

vi.mock('../src/server/projects/workspace.js', () => ({
  getWorkspaceBoard: () => board.current,
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

beforeEach(() => {
  board.current = [];
});
afterEach(() => vi.clearAllMocks());

describe('attention', () => {
  const blocked = (id: string, title: string) => ({ id, status: 'blocked', priority: null, title, spec: null });

  it('lists blocked features with their track, oldest project activity first', () => {
    board.current = [
      project('alpha', {
        lastActivity: '2026-09-13T18:00:00.000Z',
        tracks: [{ name: 'T', features: [blocked('f1', 'Newer'), { id: 'f2', status: 'pending', priority: null, title: 'x', spec: null }] }],
      }),
      project('beta', { lastActivity: '2026-09-11T08:00:00.000Z', tracks: [{ name: 'U', features: [blocked('f3', 'Older')] }] }),
    ];
    const attention = getRollup().attention;
    expect(attention.map((a) => a.title)).toEqual(['Older', 'Newer']);
    expect(attention[0]).toMatchObject({ kind: 'blocked', projectName: 'beta', detail: 'blocked in U', featureId: 'f3' });
  });
});

describe('project summaries and totals', () => {
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
