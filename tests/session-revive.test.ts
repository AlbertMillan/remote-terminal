import { describe, it, expect, beforeEach, vi } from 'vitest';

/**
 * reviveSession() brings a stale session — a DB row that outlived its PTY when the server
 * restarted — back to life in place. These tests pin the four things that make it a revive
 * rather than a fresh session: the row keeps its identity, the persisted scrollback survives,
 * a recorded conversation is resumed, and rows that cannot be revived are refused rather
 * than silently producing a broken session.
 */

const ptys: Array<{ pid: number; write: ReturnType<typeof vi.fn> }> = [];
let ptySpawnError: Error | null = null;

const createPty = vi.fn(() => {
  if (ptySpawnError) throw ptySpawnError;
  const pty = {
    pid: 1000 + ptys.length,
    write: vi.fn(),
    resize: vi.fn(),
    kill: vi.fn(),
    // Emit once, so _injectResumeCommand's "shell is ready" debounce fires the way it does
    // in practice instead of falling through to its 5s hard fallback.
    onData: vi.fn((cb: (data: string) => void) => {
      setTimeout(() => cb('$ '), 0);
      return { dispose: vi.fn() };
    }),
    onExit: vi.fn(() => ({ dispose: vi.fn() })),
  };
  ptys.push(pty);
  return pty;
});

const writeToPty = vi.fn();

vi.mock('../src/server/sessions/pty-handler.js', async () => {
  // ScrollbackBuffer is real: the seeding assertion is only meaningful against the real one.
  const actual = await vi.importActual<typeof import('../src/server/sessions/pty-handler.js')>(
    '../src/server/sessions/pty-handler.js'
  );
  return {
    ...actual,
    createPty: (...args: unknown[]) => createPty(...(args as [])),
    writeToPty: (...args: unknown[]) => writeToPty(...(args as [])),
    killPty: (...args: unknown[]) => killPty(...(args as [])),
    resizePty: vi.fn(),
  };
});

const rows = new Map<string, Record<string, unknown>>();
const updateSession = vi.fn((id: string, patch: Record<string, unknown>) => {
  const row = rows.get(id);
  if (row) Object.assign(row, patch);
});
const logSessionEvent = vi.fn();

vi.mock('../src/server/db/queries.js', () => ({
  insertSession: vi.fn(),
  updateSession: (...args: unknown[]) => updateSession(...(args as [string, Record<string, unknown>])),
  getAllSessions: vi.fn(() => []),
  deleteSession: vi.fn(),
  getSession: vi.fn((id: string) => rows.get(id) ?? null),
  countActiveSessions: vi.fn(() => rows.size),
  logSessionEvent: (...args: unknown[]) => logSessionEvent(...(args as [])),
  getMaxSessionSortOrder: vi.fn(() => 0),
  clearForkFlag: vi.fn(),
  getUnloggedSessionsForLog: vi.fn(() => []),
}));

const restoreScrollbackRaw = vi.fn(() => '');
const killPty = vi.fn();

vi.mock('../src/server/sessions/persistence.js', () => ({
  isTmuxAvailable: vi.fn(() => Promise.resolve(false)),
  createTmuxSession: vi.fn(),
  killTmuxSession: vi.fn(),
  tmuxSessionExists: vi.fn(),
  persistScrollback: vi.fn(),
  restoreScrollback: vi.fn(() => [] as string[]),
  restoreScrollbackRaw: () => restoreScrollbackRaw(),
  getPersistenceStrategy: vi.fn(() => 'scrollback'),
}));

vi.mock('../src/server/sessions/project-log.js', () => ({
  generateSessionLog: vi.fn(() => Promise.resolve()),
  anyDirtyFileTouchedSince: vi.fn(() => false),
}));

vi.mock('../src/server/config.js', () => ({
  getConfig: vi.fn(() => ({
    sessions: { maxSessions: 10, defaultShell: undefined, idleTimeoutMinutes: 0 },
    persistence: { scrollbackLines: 1000, dataDir: '/tmp/test' },
    projectLog: { enabled: false },
  })),
  loadConfig: vi.fn(),
}));

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

const STALE_ID = '11111111-1111-4111-8111-111111111111';
const CLAUDE_ID = '22222222-2222-4222-8222-222222222222';

function staleRow(overrides: Record<string, unknown> = {}) {
  return {
    id: STALE_ID,
    name: 'claude-remote',
    shell: '/bin/bash',
    cwd: '/home/albert/NodeProjects/claude-remote',
    createdAt: '2026-09-17T10:00:00.000Z',
    lastAccessedAt: '2026-09-17T18:00:00.000Z',
    ownerId: 'albert',
    // shutdown() parks sessions as 'idle', not 'terminated', precisely so they can come back.
    status: 'idle',
    cols: 120,
    rows: 40,
    tmuxSession: null,
    categoryId: 'cat-1',
    sortOrder: 7,
    claudeSessionId: null,
    isFork: false,
    forkJsonlPath: null,
    ...overrides,
  };
}

let manager: ReturnType<typeof createSessionManager>;

beforeEach(() => {
  vi.clearAllMocks();
  vi.useRealTimers();
  ptys.length = 0;
  ptySpawnError = null;
  rows.clear();
  restoreScrollbackRaw.mockReturnValue('');
  updateSession.mockImplementation((id: string, patch: Record<string, unknown>) => {
    const row = rows.get(id);
    if (row) Object.assign(row, patch);
  });
  manager = createSessionManager();
});

describe('reviveSession — the row keeps its identity', () => {
  it('reuses the same id, name, cwd and shell rather than creating a new session', () => {
    rows.set(STALE_ID, staleRow());

    const session = manager.reviveSession({ id: STALE_ID });

    expect(session.id).toBe(STALE_ID);
    expect(session.name).toBe('claude-remote');
    expect(session.cwd).toBe('/home/albert/NodeProjects/claude-remote');
    expect(session.shell).toBe('/bin/bash');
    // Only one row exists: revive must not insert a second "Resume: ..." session.
    expect(rows.size).toBe(1);
  });

  it('spawns the PTY with the row id as CLAUDE_REMOTE_SESSION_ID so hooks keep pointing here', () => {
    rows.set(STALE_ID, staleRow());

    manager.reviveSession({ id: STALE_ID });

    expect(createPty).toHaveBeenCalledWith(
      expect.objectContaining({
        cwd: '/home/albert/NodeProjects/claude-remote',
        shell: '/bin/bash',
        env: { CLAUDE_REMOTE_SESSION_ID: STALE_ID },
      })
    );
  });

  it('marks the row active again and records a revived event', () => {
    rows.set(STALE_ID, staleRow());

    manager.reviveSession({ id: STALE_ID });

    expect(rows.get(STALE_ID)?.status).toBe('active');
    expect(logSessionEvent).toHaveBeenCalledWith(STALE_ID, 'revived', expect.any(String));
    expect(manager.getSession(STALE_ID)).toBeDefined();
  });

  it('falls back to the stored dimensions when the client sends none', () => {
    rows.set(STALE_ID, staleRow());

    const session = manager.reviveSession({ id: STALE_ID });

    expect(session.cols).toBe(120);
    expect(session.rows).toBe(40);
  });
});

describe('reviveSession — the conversation', () => {
  it('injects `claude --resume` for a row that recorded a Claude session', async () => {
    rows.set(STALE_ID, staleRow({ claudeSessionId: CLAUDE_ID }));

    manager.reviveSession({ id: STALE_ID });

    // The injection is debounced 100ms behind the shell's first output.
    await vi.waitFor(() => expect(writeToPty).toHaveBeenCalled(), { timeout: 2000 });
    expect(writeToPty).toHaveBeenCalledWith(expect.anything(), `claude --resume ${CLAUDE_ID}\r`);
  });

  it('injects nothing for a plain shell row, which just gets its shell back', async () => {
    rows.set(STALE_ID, staleRow({ claudeSessionId: null }));

    manager.reviveSession({ id: STALE_ID });

    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(writeToPty).not.toHaveBeenCalled();
  });
});

describe('reviveSession — persisted scrollback', () => {
  it('seeds the fresh buffer so the pre-restart output is not silently dropped', () => {
    rows.set(STALE_ID, staleRow());
    restoreScrollbackRaw.mockReturnValue('$ npm test\n336 passed');

    manager.reviveSession({ id: STALE_ID });

    // _initSessionPty installs an empty buffer and getScrollback() prefers the in-memory one,
    // so without the seed this would come back empty.
    expect(manager.getScrollback(STALE_ID)).toEqual(['$ npm test', '336 passed']);
  });

  it('keeps an unterminated final line, which the buffer would otherwise hold back', () => {
    rows.set(STALE_ID, staleRow());
    // No trailing newline: a shell prompt left mid-line is the normal case.
    restoreScrollbackRaw.mockReturnValue('$ npm test\n336 passed\n$ ');

    manager.reviveSession({ id: STALE_ID });

    expect(manager.getScrollback(STALE_ID)).toEqual(['$ npm test', '336 passed', '$ ']);
  });

  it('survives a hard kill, where nothing was persisted', () => {
    rows.set(STALE_ID, staleRow());
    restoreScrollbackRaw.mockReturnValue('');

    manager.reviveSession({ id: STALE_ID });

    expect(manager.getScrollback(STALE_ID)).toEqual([]);
  });
});

describe('reviveSession — refusals', () => {
  it('refuses an unknown session', () => {
    expect(() => manager.reviveSession({ id: STALE_ID })).toThrow(/not found/i);
  });

  it('refuses a session that is already running', () => {
    rows.set(STALE_ID, staleRow());
    manager.reviveSession({ id: STALE_ID });

    expect(() => manager.reviveSession({ id: STALE_ID })).toThrow(/already running/i);
    expect(ptys).toHaveLength(1);
  });

  it('refuses a terminated session', () => {
    rows.set(STALE_ID, staleRow({ status: 'terminated' }));

    expect(() => manager.reviveSession({ id: STALE_ID })).toThrow(/terminated/i);
  });

  it('refuses a fork, whose transcript is unlinked at boot', () => {
    rows.set(STALE_ID, staleRow({ isFork: true, claudeSessionId: CLAUDE_ID }));

    // Reviving would run `claude --resume` against a JSONL cleanupOrphanedForkFiles deleted.
    expect(() => manager.reviveSession({ id: STALE_ID })).toThrow(/fork/i);
    expect(createPty).not.toHaveBeenCalled();
  });

  it('names the directory when the cwd is gone instead of falling back to home', () => {
    rows.set(STALE_ID, staleRow());
    ptySpawnError = new Error('chdir failed');

    expect(() => manager.reviveSession({ id: STALE_ID })).toThrow(
      /Failed to start shell in \/home\/albert\/NodeProjects\/claude-remote/
    );
    // A failed revive leaves the row stale, not half-alive.
    expect(manager.getSession(STALE_ID)).toBeUndefined();
  });

  it('kills the PTY when recording the revive fails, rather than orphaning it', () => {
    rows.set(STALE_ID, staleRow());
    updateSession.mockImplementation(() => {
      throw new Error('database is locked');
    });

    expect(() => manager.reviveSession({ id: STALE_ID })).toThrow(/database is locked/);
    // The caller was told it failed, so nothing may still be running behind its back.
    expect(killPty).toHaveBeenCalledTimes(1);
    expect(manager.getSession(STALE_ID)).toBeUndefined();
  });

  it('does not re-check maxSessions, which a stale row already counts toward', () => {
    // Ten rows = the configured cap. Every one of them is stale after a restart; if revive
    // checked the cap, none of them could ever be brought back.
    for (let i = 0; i < 10; i++) {
      const id = `0000000${i}-1111-4111-8111-111111111111`;
      rows.set(id, staleRow({ id }));
    }

    expect(() => manager.reviveSession({ id: '00000003-1111-4111-8111-111111111111' })).not.toThrow();
  });
});
