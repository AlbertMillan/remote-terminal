import { describe, it, expect, beforeEach, vi } from 'vitest';

/**
 * changeSessionAccount() moves a session's conversation to another account
 * (project/move-conversation-account.md): every check before anything stops, a running
 * session parked as Stop parks it, and a failed move keeps the row's account. The fakes are
 * session-stop.test.ts's.
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
  assertAccountReady: (...args: unknown[]) => assertAccountReady(...(args as [])),
  findTranscript: vi.fn(() => ({ path: '/x/projects/p/22222222-2222-4222-8222-222222222222.jsonl', account: 'personal' })),
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

const assertAccountReady = vi.fn();
const moveTranscript = vi.fn(() => Promise.resolve({ fromDir: '/a', toDir: '/b' }));
vi.mock('../src/server/sessions/account-move.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/server/sessions/account-move.js')>()),
  moveTranscript: (...args: unknown[]) => moveTranscript(...(args as [])),
}));

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
  setSessionAccount: (id: string, account: string) => {
    const row = rows.get(id);
    if (row) row.account = account;
  },
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

import { ChangeAccountError, createSessionManager } from '../src/server/sessions/manager.js';

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
  persistScrollback.mockReset();
  assertAccountReady.mockReset();
  moveTranscript.mockReset();
  moveTranscript.mockImplementation(() => Promise.resolve({ fromDir: '/a', toDir: '/b' }));
  killPty.mockImplementation((pty: FakePty) => {
    for (const cb of [...pty.exits]) cb({ exitCode: 1 });
  });
  ptys.length = 0;
  rows.clear();
  manager = createSessionManager();
});

describe('changeSessionAccount', () => {
  it('parks a running session, moves its transcript and repoints the row; the client revives it', async () => {
    running(PARENT);
    await settle();
    const detached: string[] = [];

    const result = await manager.changeSessionAccount(PARENT, 'work', { beforeKill: (id) => detached.push(id) });

    expect(result).toEqual({ resume: true });
    expect(detached).toEqual([PARENT]);
    expect(rows.get(PARENT)?.status).toBe('idle');
    expect(manager.isRunning(PARENT)).toBe(false);
    expect(persistScrollback).toHaveBeenCalled();
    expect(moveTranscript).toHaveBeenCalledWith(
      '/home/albert/NodeProjects/claude-remote',
      '22222222-2222-4222-8222-222222222222',
      'personal',
      'work'
    );
    expect(rows.get(PARENT)?.account).toBe('work');
    expect(logSessionEvent).toHaveBeenCalledWith(PARENT, 'account_changed', 'personal -> work');
  });

  it('only moves a stopped session, and asks for no revive', async () => {
    rows.set(PARENT, row(PARENT));
    expect(await manager.changeSessionAccount(PARENT, 'work')).toEqual({ resume: false });
    expect(killPty).not.toHaveBeenCalled();
    expect(rows.get(PARENT)?.account).toBe('work');
  });

  it('refuses before stopping anything: a started session, running children, a refused login', async () => {
    running(PARENT);
    running(CHILD, { spawnedBy: PARENT });
    await settle();
    await expect(manager.changeSessionAccount(CHILD, 'work')).rejects.toThrow(/session that started it/);
    await expect(manager.changeSessionAccount(PARENT, 'work')).rejects.toThrow(/1 running started session/);

    rows.set(OTHER, row(OTHER));
    assertAccountReady.mockImplementation(() => {
      throw new Error('nobody is logged in');
    });
    await expect(manager.changeSessionAccount(OTHER, 'work')).rejects.toThrow(/nobody is logged in/);

    expect(manager.isRunning(PARENT)).toBe(true);
    expect(manager.isRunning(CHILD)).toBe(true);
    expect(moveTranscript).not.toHaveBeenCalled();
    expect(rows.get(PARENT)?.account).toBe('personal');
  });

  it('keeps the account when the move fails, and says the session was stopped for it', async () => {
    running(PARENT);
    await settle();
    moveTranscript.mockImplementation(() => Promise.reject(new Error('EBUSY: resource busy')));

    const error = await manager.changeSessionAccount(PARENT, 'work').catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ChangeAccountError);
    expect((error as InstanceType<typeof ChangeAccountError>).stopped).toBe(true);
    expect((error as Error).message).toMatch(/Could not move the conversation to work: EBUSY/);
    expect(rows.get(PARENT)?.account).toBe('personal');
  });
});

describe('changeSessionAccount: while the files move', () => {
  it('refuses a revive, a stop and a second move until the move is done', async () => {
    running(PARENT);
    await settle();
    let finish!: () => void;
    moveTranscript.mockImplementation(
      () => new Promise((resolve) => (finish = () => resolve({ fromDir: '/a', toDir: '/b' })))
    );

    const moving = manager.changeSessionAccount(PARENT, 'work');
    await settle();
    expect(() => manager.reviveSession({ id: PARENT })).toThrow(/moving to another account/);
    expect(() => manager.stopTargets(PARENT)).toThrow(/moving to another account/);
    await expect(manager.changeSessionAccount(PARENT, 'work')).rejects.toThrow(/already moving/);

    finish();
    expect(await moving).toEqual({ resume: true });
    // Released: the client's revive now goes through, under the new account.
    expect(() => manager.reviveSession({ id: PARENT })).not.toThrow();
  });

  it('logs the session once, after the move, under the account the transcript ended up in', async () => {
    running(PARENT);
    await settle();
    let finish!: () => void;
    moveTranscript.mockImplementation(
      () => new Promise((resolve) => (finish = () => resolve({ fromDir: '/a', toDir: '/b' })))
    );

    const moving = manager.changeSessionAccount(PARENT, 'work');
    await settle();
    expect(generateSessionLog).not.toHaveBeenCalled(); // not at the stop: it would read a moving file
    finish();
    await moving;
    expect(generateSessionLog).toHaveBeenCalledTimes(1);
    expect(generateSessionLog).toHaveBeenCalledWith(expect.objectContaining({ sessionId: PARENT, account: 'work' }));
  });

  it('logs under the old account when the move fails, and releases the session', async () => {
    running(PARENT);
    await settle();
    moveTranscript.mockImplementation(() => Promise.reject(new Error('EIO')));

    await expect(manager.changeSessionAccount(PARENT, 'work')).rejects.toThrow(/EIO/);
    expect(generateSessionLog).toHaveBeenCalledWith(expect.objectContaining({ sessionId: PARENT, account: 'personal' }));
    expect(() => manager.reviveSession({ id: PARENT })).not.toThrow();
  });
});
