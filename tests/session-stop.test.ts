import { describe, it, expect, beforeEach, vi } from 'vitest';

/**
 * stopSession() parks a running session so it can be resumed later: the shell is killed,
 * the row stays `idle` (never `terminated`) with its scrollback persisted, and the sessions
 * it started go with it. reviveSession() then brings it back. project/stop-sessions.md
 */

type FakePty = { pid: number; write: ReturnType<typeof vi.fn>; exits: Array<(e: { exitCode: number }) => void> };
const ptys: FakePty[] = [];

const createPty = vi.fn(() => {
  const pty: FakePty & Record<string, unknown> = {
    pid: 1000 + ptys.length,
    write: vi.fn(),
    resize: vi.fn(),
    kill: vi.fn(),
    exits: [],
    onData: vi.fn((cb: (data: string) => void) => {
      setTimeout(() => cb('$ '), 0);
      return { dispose: vi.fn() };
    }),
    // Every listener, the manager's own and ptyExit's, so a kill reaches both as it does live.
    onExit: vi.fn((cb: (e: { exitCode: number }) => void) => {
      pty.exits.push(cb);
      return { dispose: vi.fn() };
    }),
  };
  ptys.push(pty);
  return pty;
});

// A killed shell reports its exit, like a real one.
const killPty = vi.fn((pty: FakePty) => {
  for (const cb of [...pty.exits]) cb({ exitCode: 1 });
});

vi.mock('../src/server/accounts.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/server/accounts.js')>()),
  assertAccountReady: vi.fn(),
  findTranscript: vi.fn(() => null),
}));
vi.mock('../src/server/projects/worktree-owner.js', () => ({
  projectCwdFor: vi.fn((cwd: string | undefined) => cwd),
}));

vi.mock('../src/server/sessions/pty-handler.js', async () => {
  const actual = await vi.importActual<typeof import('../src/server/sessions/pty-handler.js')>(
    '../src/server/sessions/pty-handler.js'
  );
  return {
    ...actual,
    createPty: (...args: unknown[]) => createPty(...(args as [])),
    writeToPty: vi.fn(),
    killPty: (pty: FakePty) => killPty(pty),
    resizePty: vi.fn(),
  };
});

const rows = new Map<string, Record<string, unknown>>();
const logSessionEvent = vi.fn();

vi.mock('../src/server/db/queries.js', () => ({
  insertSession: vi.fn(),
  launchProfileForTranscript: vi.fn(() => null),
  accountForTranscript: vi.fn(() => null),
  updateSession: (id: string, patch: Record<string, unknown>) => {
    const row = rows.get(id);
    if (row) Object.assign(row, patch);
  },
  getAllSessions: vi.fn(() => [...rows.values()]),
  deleteSession: vi.fn(),
  getSession: vi.fn((id: string) => rows.get(id) ?? null),
  countActiveSessions: () => rows.size,
  logSessionEvent: (...args: unknown[]) => logSessionEvent(...(args as [])),
  getMaxSessionSortOrder: vi.fn(() => 0),
  clearForkFlag: vi.fn(),
  getUnloggedSessionsForLog: vi.fn(() => []),
}));

const persistScrollback = vi.fn();
vi.mock('../src/server/sessions/persistence.js', () => ({
  isTmuxAvailable: vi.fn(() => Promise.resolve(false)),
  createTmuxSession: vi.fn(),
  killTmuxSession: vi.fn(),
  tmuxSessionExists: vi.fn(),
  persistScrollback: (...args: unknown[]) => persistScrollback(...(args as [])),
  restoreScrollback: vi.fn(() => [] as string[]),
  restoreScrollbackRaw: vi.fn(() => ''),
  getPersistenceStrategy: vi.fn(() => 'scrollback'),
}));

const generateSessionLog = vi.fn(() => Promise.resolve());
vi.mock('../src/server/sessions/project-log.js', () => ({
  generateSessionLog: (...args: unknown[]) => generateSessionLog(...(args as [])),
  anyDirtyFileTouchedSince: vi.fn(() => false),
}));

vi.mock('../src/server/config.js', () => ({
  getConfig: vi.fn(() => ({
    sessions: { maxSessions: 10, defaultShell: undefined, idleTimeoutMinutes: 0 },
    persistence: { scrollbackLines: 1000, dataDir: '/tmp/test' },
    projectLog: { enabled: true },
  })),
  loadConfig: vi.fn(),
}));

// Not Windows: scrollback is persisted at stop on every platform, which this pins.
vi.mock('../src/server/utils/platform.js', () => ({
  getDefaultShell: vi.fn(() => '/bin/bash'),
  getShellArgs: vi.fn(() => []),
  isWindows: vi.fn(() => false),
  isLinux: vi.fn(() => true),
  isMac: vi.fn(() => false),
  getPlatform: vi.fn(() => 'linux'),
}));

vi.mock('../src/server/utils/logger.js', () => ({
  createLogger: vi.fn(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() })),
}));

import { createSessionManager } from '../src/server/sessions/manager.js';

const PARENT = '11111111-1111-4111-8111-111111111111';
const CHILD = '33333333-3333-4333-8333-333333333333';
const OTHER = '44444444-4444-4444-8444-444444444444';

function row(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    name: `session ${id.slice(0, 4)}`,
    shell: '/bin/bash',
    cwd: '/home/albert/NodeProjects/claude-remote',
    createdAt: '2026-11-09T10:00:00.000Z',
    lastAccessedAt: '2026-11-09T10:00:00.000Z',
    ownerId: 'albert',
    status: 'idle',
    cols: 120,
    rows: 40,
    tmuxSession: null,
    categoryId: null,
    sortOrder: 0,
    claudeSessionId: '22222222-2222-4222-8222-222222222222',
    isFork: false,
    forkJsonlPath: null,
    spawnedBy: null,
    account: 'personal',
    ...overrides,
  };
}

let manager: ReturnType<typeof createSessionManager>;

/** A running session: a parked row brought up through revive, the path stop must reverse. */
function running(id: string, overrides: Record<string, unknown> = {}) {
  rows.set(id, row(id, overrides));
  manager.reviveSession({ id });
}

/** Let the fake shells print, so each scrollback has something to persist. */
const settle = () => new Promise((r) => setTimeout(r, 5));

beforeEach(() => {
  vi.clearAllMocks();
  // clearAllMocks keeps an implementation a test set; these must not reach the next one.
  persistScrollback.mockReset();
  killPty.mockImplementation((pty: FakePty) => {
    for (const cb of [...pty.exits]) cb({ exitCode: 1 });
  });
  ptys.length = 0;
  rows.clear();
  manager = createSessionManager();
});

describe('stopSession', () => {
  it('parks the row idle with no PTY, so it lists as stopped and revivable', async () => {
    running(PARENT);
    await settle();

    expect(await manager.stopSession(PARENT)).toEqual([PARENT]);

    // idle, never terminated: the exit the kill caused must not overwrite it.
    expect(rows.get(PARENT)?.status).toBe('idle');
    expect(manager.getSession(PARENT)).toBeUndefined();
    expect(manager.getSessionList().find((s) => s.id === PARENT)?.attachable).toBe(false);
    expect(logSessionEvent).toHaveBeenCalledWith(PARENT, 'stopped');
    expect(logSessionEvent).not.toHaveBeenCalledWith(PARENT, 'exited', expect.anything());
  });

  it('persists the scrollback and writes a session-log entry', async () => {
    running(PARENT);
    await settle();

    await manager.stopSession(PARENT);

    expect(persistScrollback).toHaveBeenCalledWith(PARENT, expect.stringContaining('$'));
    expect(generateSessionLog).toHaveBeenCalledWith(expect.objectContaining({ sessionId: PARENT }));
  });

  it('stops the sessions it started, children first, and leaves the rest running', async () => {
    running(PARENT);
    running(CHILD, { spawnedBy: PARENT });
    running(OTHER);

    expect(manager.stopTargets(PARENT)).toEqual([CHILD, PARENT]);
    expect(await manager.stopSession(PARENT)).toEqual([CHILD, PARENT]);

    expect(rows.get(CHILD)?.status).toBe('idle');
    expect(manager.getSession(CHILD)).toBeUndefined();
    expect(manager.getSession(OTHER)).toBeDefined();
  });

  it('refuses a fork, which could not be resumed, and leaves it running', async () => {
    running(PARENT);
    rows.get(PARENT)!.isFork = true;

    await expect(manager.stopSession(PARENT)).rejects.toThrow(/Forked sessions cannot be stopped/);
    expect(manager.getSession(PARENT)).toBeDefined();
  });

  it('refuses a session that is not running', async () => {
    rows.set(PARENT, row(PARENT));
    await expect(manager.stopSession(PARENT)).rejects.toThrow(/not running/);
  });

  it('runs beforeKill for each session after its scrollback is saved, children first', async () => {
    running(PARENT);
    running(CHILD, { spawnedBy: PARENT });
    await settle();
    const order: string[] = [];
    persistScrollback.mockImplementation((id: string) => order.push(`persist ${id}`));

    await manager.stopSession(PARENT, { beforeKill: (id) => order.push(`detach ${id}`) });

    expect(order).toEqual([`persist ${CHILD}`, `detach ${CHILD}`, `persist ${PARENT}`, `detach ${PARENT}`]);
  });

  it('a failed scrollback write stops nothing further and never detaches that session', async () => {
    running(PARENT);
    await settle();
    persistScrollback.mockImplementation(() => {
      throw new Error('database is locked');
    });
    const beforeKill = vi.fn();

    await expect(manager.stopSession(PARENT, { beforeKill })).rejects.toThrow('database is locked');

    expect(beforeKill).not.toHaveBeenCalled();
    expect(manager.getSession(PARENT)).toBeDefined();
  });

  it('stops the targets it is given, skipping one no longer running', async () => {
    running(PARENT);
    running(OTHER);
    await manager.stopSession(OTHER);

    expect(await manager.stopSession(PARENT, { targets: [OTHER, PARENT] })).toEqual([PARENT]);
    expect(logSessionEvent.mock.calls.filter(([id, e]) => id === OTHER && e === 'stopped')).toHaveLength(1);
  });

  it('a stopped shell that reports its exit late leaves the session revived meanwhile alone', async () => {
    running(PARENT);
    const old = ptys[0];
    // The kill is sent but the exit is not reported within PTY_EXIT_WAIT_MS.
    killPty.mockImplementationOnce(() => {});
    vi.useFakeTimers();
    const stopping = manager.stopSession(PARENT);
    await vi.advanceTimersByTimeAsync(5000);
    await stopping;
    vi.useRealTimers();

    manager.reviveSession({ id: PARENT });
    logSessionEvent.mockClear();
    for (const cb of [...old.exits]) cb({ exitCode: 1 });

    expect(rows.get(PARENT)?.status).toBe('active');
    expect(manager.getSession(PARENT)?.status).toBe('active');
    expect(logSessionEvent).not.toHaveBeenCalledWith(PARENT, 'exited', expect.anything());
  });

  it('can be revived in place afterwards', async () => {
    running(PARENT);
    await manager.stopSession(PARENT);

    const revived = manager.reviveSession({ id: PARENT });

    expect(revived.id).toBe(PARENT);
    expect(rows.get(PARENT)?.status).toBe('active');
    expect(ptys).toHaveLength(2);
  });
});

describe('Build & restart parking (project/revive-after-build-restart.md)', () => {
  it('targets every running session but forks and exited shells', async () => {
    running(PARENT);
    running(CHILD, { spawnedBy: PARENT });
    running(OTHER);
    rows.get(OTHER)!.isFork = true;
    const EXITED = '55555555-5555-4555-8555-555555555555';
    running(EXITED);
    // Its own shell exits, found through the session rather than by creation order.
    const exitedPty = manager.getSession(EXITED)!.pty as unknown as FakePty;
    for (const cb of [...exitedPty.exits]) cb({ exitCode: 0 });

    expect(manager.restartTargets().sort()).toEqual([PARENT, CHILD].sort());
  });

  it('parks each idle with its scrollback, writes no session-log entry, and revive brings it back', async () => {
    running(PARENT);
    running(OTHER);
    await settle();

    expect(await manager.parkForRestart([PARENT, OTHER])).toEqual([PARENT, OTHER]);

    expect(rows.get(PARENT)?.status).toBe('idle');
    expect(manager.getSession(PARENT)).toBeUndefined();
    expect(persistScrollback).toHaveBeenCalledWith(PARENT, expect.stringContaining('$'));
    expect(generateSessionLog).not.toHaveBeenCalled();

    manager.reviveSession({ id: PARENT });
    expect(manager.getSession(PARENT)).toBeDefined();
  });

  it('one session failing to park does not stop the rest', async () => {
    running(PARENT);
    running(OTHER);
    await settle();
    persistScrollback.mockImplementationOnce(() => {
      throw new Error('database is locked');
    });

    expect(await manager.parkForRestart([PARENT, OTHER])).toEqual([OTHER]);
    expect(manager.getSession(PARENT)).toBeDefined();
    expect(manager.getSession(OTHER)).toBeUndefined();
  });
});
