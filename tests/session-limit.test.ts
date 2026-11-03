import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

/**
 * The session limit as createSession sees it: read from the live config on every create,
 * so a change made in Settings (setMaxSessions) applies to the next session without a
 * restart, and counted so that concurrent creates can't all slip under it while one is
 * still awaiting tmux (Linux/macOS) before its row is in the table.
 *
 * Unlike the other session tests, config.ts is real here: the point is the path from
 * setMaxSessions to the check.
 */

const createPty = vi.fn(() => ({
  pid: 1000,
  write: vi.fn(),
  resize: vi.fn(),
  kill: vi.fn(),
  onData: vi.fn(() => ({ dispose: vi.fn() })),
  onExit: vi.fn(() => ({ dispose: vi.fn() })),
}));

vi.mock('../src/server/accounts.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/server/accounts.js')>()),
  assertAccountReady: vi.fn(),
}));

vi.mock('../src/server/sessions/pty-handler.js', async () => {
  const actual = await vi.importActual<typeof import('../src/server/sessions/pty-handler.js')>(
    '../src/server/sessions/pty-handler.js'
  );
  return { ...actual, createPty: () => createPty(), killPty: vi.fn(), resizePty: vi.fn() };
});

const rows = new Map<string, Record<string, unknown>>();
vi.mock('../src/server/db/queries.js', () => ({
  insertSession: vi.fn((m: Record<string, unknown>) => rows.set(m.id as string, { ...m })),
  updateSession: vi.fn(),
  getAllSessions: vi.fn(() => [...rows.values()]),
  deleteSession: vi.fn(),
  getSession: vi.fn((id: string) => rows.get(id) ?? null),
  countActiveSessions: vi.fn(() => rows.size),
  logSessionEvent: vi.fn(),
  getMaxSessionSortOrder: vi.fn(() => 0),
  launchProfileForTranscript: vi.fn(() => null),
  accountForTranscript: vi.fn(() => null),
  clearForkFlag: vi.fn(),
  getUnloggedSessionsForLog: vi.fn(() => []),
}));

/** Holds createSession at its tmux await, between the count and the insert. */
let tmuxGate: Promise<boolean> = Promise.resolve(false);
vi.mock('../src/server/sessions/persistence.js', () => ({
  isTmuxAvailable: vi.fn(() => tmuxGate),
  createTmuxSession: vi.fn(),
  killTmuxSession: vi.fn(() => Promise.resolve()),
  persistScrollback: vi.fn(),
  restoreScrollback: vi.fn(() => [] as string[]),
  restoreScrollbackRaw: vi.fn(() => ''),
}));

vi.mock('../src/server/sessions/project-log.js', () => ({
  generateSessionLog: vi.fn(() => Promise.resolve()),
}));

vi.mock('../src/server/utils/platform.js', () => ({
  getDefaultShell: vi.fn(() => '/bin/bash'),
  getShellArgs: vi.fn(() => []),
  isWindows: vi.fn(() => false),
}));

vi.mock('../src/server/utils/logger.js', () => ({
  createLogger: vi.fn(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() })),
}));

vi.mock('../src/server/projects/worktree-owner.js', () => ({
  projectCwdFor: vi.fn((cwd: string | undefined) => cwd),
}));

import { createSessionManager } from '../src/server/sessions/manager.js';
import { loadConfig, setMaxSessions } from '../src/server/config.js';

let dir: string;
const previousEnv = process.env.CLAUDE_REMOTE_CONFIG;
let manager: ReturnType<typeof createSessionManager>;

beforeEach(() => {
  rows.clear();
  tmuxGate = Promise.resolve(false);
  dir = mkdtempSync(join(tmpdir(), 'cr-limit-'));
  process.env.CLAUDE_REMOTE_CONFIG = join(dir, 'config.json');
  writeFileSync(
    process.env.CLAUDE_REMOTE_CONFIG,
    JSON.stringify({ sessions: { maxSessions: 1 }, persistence: { dataDir: join(dir, 'data') } })
  );
  loadConfig();
  manager = createSessionManager();
});

afterEach(async () => {
  await manager.shutdown();
  if (previousEnv === undefined) delete process.env.CLAUDE_REMOTE_CONFIG;
  else process.env.CLAUDE_REMOTE_CONFIG = previousEnv;
  rmSync(dir, { recursive: true, force: true });
});

describe('session limit', () => {
  it('createSession honours a limit changed through setMaxSessions, without a reload', async () => {
    await manager.createSession({ cwd: dir });
    await expect(manager.createSession({ cwd: dir })).rejects.toThrow('Maximum session limit (1) reached');

    setMaxSessions(2);
    await manager.createSession({ cwd: dir });
    await expect(manager.createSession({ cwd: dir })).rejects.toThrow('Maximum session limit (2) reached');
    expect(rows.size).toBe(2);
  });

  it('refuses a create that overlaps one still awaiting tmux at the last free slot', async () => {
    let openGate!: (value: boolean) => void;
    tmuxGate = new Promise<boolean>((resolve) => (openGate = resolve));

    const first = manager.createSession({ cwd: dir });
    // The first create has counted 0 rows and is parked before its insert.
    await expect(manager.createSession({ cwd: dir })).rejects.toThrow('Maximum session limit (1) reached');
    openGate(false);
    await first;
    expect(rows.size).toBe(1);
  });

  it('frees the slot of a create that failed before its insert', async () => {
    tmuxGate = Promise.reject(new Error('tmux exploded'));
    await expect(manager.createSession({ cwd: dir })).rejects.toThrow('tmux exploded');
    tmuxGate = Promise.resolve(false);
    await manager.createSession({ cwd: dir });
    expect(rows.size).toBe(1);
  });
});
