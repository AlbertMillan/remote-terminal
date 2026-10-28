import { describe, it, expect, beforeEach, vi } from 'vitest';
import { existsSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';

/**
 * Every PTY gets its environment through sessionEnv(): the session id for the
 * notification hooks, plus the token, server URL and CLI path the
 * agent-sessions CLI needs (docs/session-orchestration.md). A creation path
 * that builds its own env is a session whose agent cannot use the CLI.
 */

// vi.mock is hoisted above the imports, so the temp dir must be too.
const { dataDir } = await vi.hoisted(async () => {
  const { makeTmpDataDir } = await import('./helpers/tmp-data-dir.js');
  return { dataDir: makeTmpDataDir('session-env') };
});

type FakePty = { pid: number; write: ReturnType<typeof vi.fn>; kill: ReturnType<typeof vi.fn>; exit: () => void };
const ptys: FakePty[] = [];
const createPty = vi.fn(() => {
  const onExit: ((e: { exitCode: number }) => void)[] = [];
  const pty = {
    pid: 1000 + ptys.length,
    write: vi.fn(),
    resize: vi.fn(),
    kill: vi.fn(),
    // One prompt's worth of output, so injectCommand's readiness debounce fires.
    onData: vi.fn((cb: (data: string) => void) => {
      setTimeout(() => cb('$ '), 0);
      return { dispose: vi.fn() };
    }),
    onExit: vi.fn((cb: (e: { exitCode: number }) => void) => {
      onExit.push(cb);
      return { dispose: vi.fn() };
    }),
    // A killed shell reports its exit, as node-pty's does: terminateSession waits for it.
    exit: () => setTimeout(() => onExit.forEach((cb) => cb({ exitCode: 0 })), 0),
  };
  ptys.push(pty);
  return pty;
});
const writeToPty = vi.fn();

// Preflight reads the account's real login; these tests launch nothing real.
vi.mock('../src/server/accounts.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/server/accounts.js')>()),
  assertAccountReady: vi.fn(),
}));

vi.mock('../src/server/sessions/pty-handler.js', async () => {
  const actual = await vi.importActual<typeof import('../src/server/sessions/pty-handler.js')>(
    '../src/server/sessions/pty-handler.js'
  );
  return {
    ...actual,
    createPty: (...args: unknown[]) => createPty(...(args as [])),
    writeToPty: (...args: unknown[]) => writeToPty(...(args as [])),
    killPty: vi.fn((pty: FakePty) => pty.exit()),
    resizePty: vi.fn(),
  };
});

const rows = new Map<string, Record<string, unknown>>();
vi.mock('../src/server/db/queries.js', () => ({
  insertSession: vi.fn((m: Record<string, unknown>) => rows.set(m.id as string, { ...m })),
  updateSession: vi.fn((id: string, patch: Record<string, unknown>) => {
    const row = rows.get(id);
    if (row) Object.assign(row, patch);
  }),
  getAllSessions: vi.fn(() => [...rows.values()]),
  deleteSession: vi.fn((id: string) => rows.delete(id)),
  getSession: vi.fn((id: string) => rows.get(id) ?? null),
  countActiveSessions: vi.fn(() => 0),
  logSessionEvent: vi.fn(),
  getMaxSessionSortOrder: vi.fn(() => 0),
  launchProfileForTranscript: vi.fn(() => null),
  accountForTranscript: vi.fn(() => null),
  clearForkFlag: vi.fn(),
  getUnloggedSessionsForLog: vi.fn(() => []),
}));

vi.mock('../src/server/sessions/persistence.js', () => ({
  isTmuxAvailable: vi.fn(() => Promise.resolve(false)),
  createTmuxSession: vi.fn(),
  killTmuxSession: vi.fn(),
  persistScrollback: vi.fn(),
  restoreScrollback: vi.fn(() => [] as string[]),
  restoreScrollbackRaw: vi.fn(() => ''),
}));

vi.mock('../src/server/sessions/transcript.js', () => ({
  findClaudeProjectDir: vi.fn(() => join(dataDir, 'claude-project')),
  tryGetTranscriptPath: vi.fn(() => null),
}));

vi.mock('../src/server/sessions/project-log.js', () => ({
  generateSessionLog: vi.fn(() => Promise.resolve()),
}));

vi.mock('../src/server/config.js', () => ({
  getConfig: vi.fn(() => ({
    server: { port: 4399, host: '0.0.0.0' },
    tls: { enabled: false },
    sessions: { maxSessions: 10, defaultShell: undefined, idleTimeoutMinutes: 0 },
    persistence: { scrollbackLines: 1000, dataDir },
    projectLog: { enabled: false },
  })),
  loadConfig: vi.fn(),
}));

vi.mock('../src/server/utils/platform.js', () => ({
  getDefaultShell: vi.fn(() => '/bin/bash'),
  getShellArgs: vi.fn(() => []),
  isWindows: vi.fn(() => false),
}));

vi.mock('../src/server/utils/logger.js', () => ({
  createLogger: vi.fn(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() })),
}));

// Which project a worktree belongs to is read from the DB, which these tests don't open.
vi.mock('../src/server/projects/worktree-owner.js', () => ({
  projectCwdFor: vi.fn((cwd: string | undefined) => cwd),
}));

import { createSessionManager } from '../src/server/sessions/manager.js';
import { configureSessionEnv, loopbackUrl, sessionForToken } from '../src/server/sessions/session-env.js';
import { injectCommand } from '../src/server/sessions/session-open.js';
import { promptPathFor, writePromptFile } from '../src/server/sessions/prompt-file.js';
import type { ActiveSession } from '../src/server/sessions/types.js';
import { assertAccountReady } from '../src/server/accounts.js';
import { accountForTranscript } from '../src/server/db/queries.js';
import { projectCwdFor } from '../src/server/projects/worktree-owner.js';

const CLAUDE_ID = '22222222-2222-4222-8222-222222222222';
const URL = 'http://127.0.0.1:4399';
const CLI = join(dataDir, 'install', 'scripts', 'cr-session.mjs');

let manager: ReturnType<typeof createSessionManager>;

beforeEach(() => {
  vi.clearAllMocks();
  ptys.length = 0;
  rows.clear();
  configureSessionEnv({ url: URL, cliPath: CLI });
  manager = createSessionManager();
});


function lastEnv(): Record<string, string> {
  const calls = createPty.mock.calls as unknown as [{ env: Record<string, string> }][];
  return calls[calls.length - 1][0].env;
}

function expectSessionEnv(id: string): string {
  const env = lastEnv();
  expect(env.CLAUDE_REMOTE_SESSION_ID).toBe(id);
  expect(env.CLAUDE_REMOTE_URL).toBe(URL);
  expect(env.CLAUDE_REMOTE_CLI).toBe(CLI);
  expect(env.CLAUDE_REMOTE_TOKEN).toMatch(/^[0-9a-f]{64}$/);
  expect(sessionForToken(env.CLAUDE_REMOTE_TOKEN)).toBe(id);
  return env.CLAUDE_REMOTE_TOKEN;
}

describe('sessionEnv on every PTY creation path', () => {
  it('createSession', async () => {
    const s = await manager.createSession({ cwd: dataDir });
    expectSessionEnv(s.id);
  });

  it('createSession persists spawnedBy and permissionMode', async () => {
    const s = await manager.createSession({ cwd: dataDir, spawnedBy: 'parent-id', permissionMode: 'plan' });
    expect(rows.get(s.id)).toMatchObject({ spawnedBy: 'parent-id', permissionMode: 'plan' });
  });

  it('openClaudeSession', async () => {
    const s = await manager.openClaudeSession({ claudeSessionId: CLAUDE_ID, cwd: dataDir, mode: 'resume' });
    expectSessionEnv(s.id);
  });

  it('forkSession', async () => {
    const source = await manager.createSession({ cwd: dataDir });
    rows.get(source.id)!.claudeSessionId = CLAUDE_ID;
    mkdirSync(join(dataDir, 'claude-project'), { recursive: true });
    writeFileSync(join(dataDir, 'claude-project', `${CLAUDE_ID}.jsonl`), '{}\n');
    const fork = await manager.forkSession(source.id);
    expectSessionEnv(fork.id);
  });

  it('reviveSession, with a new token that replaces the old one', async () => {
    const s = await manager.createSession({ cwd: dataDir });
    const first = expectSessionEnv(s.id);
    await manager.shutdown();
    // shutdown() drops every token: none outlives its PTY.
    expect(sessionForToken(first)).toBeNull();

    const revived = createSessionManager().reviveSession({ id: s.id });
    const second = expectSessionEnv(revived.id);
    expect(second).not.toBe(first);
    expect(sessionForToken(first)).toBeNull();
  });

  it('terminating a session revokes its token', async () => {
    const s = await manager.createSession({ cwd: dataDir });
    const token = expectSessionEnv(s.id);
    await manager.terminateSession(s.id);
    expect(sessionForToken(token)).toBeNull();
  });
});

describe("every creation path runs under the session's account", () => {
  const lastAccount = () => {
    const calls = createPty.mock.calls as unknown as [{ account: string }][];
    return calls[calls.length - 1][0].account;
  };

  it('createSession: the account it names, preflighted, and stored on the row', async () => {
    const s = await manager.createSession({ cwd: dataDir, account: 'work' });
    expect(lastAccount()).toBe('work');
    expect(assertAccountReady).toHaveBeenCalledWith('work');
    expect(rows.get(s.id)!.account).toBe('work');
    expect(s.account).toBe('work');
  });

  it('createSession without one: the default, personal', async () => {
    await manager.createSession({ cwd: dataDir });
    expect(lastAccount()).toBe('personal');
  });

  it("createSession in a track worktree: its project's account, not the folder's", async () => {
    // Worktrees sit outside every project; the account is looked up by the owner's checkout.
    const project = join(dataDir, 'owner-project');
    const worktree = join(dataDir, 'worktrees', 'tracks', 'owner-ab12cd34');
    writeFileSync(join(dataDir, 'projects.json'), JSON.stringify({ projects: [{ cwd: project, account: 'work' }] }));
    vi.mocked(projectCwdFor).mockImplementation((cwd) => (cwd === worktree ? project : cwd));
    try {
      await manager.createSession({ cwd: worktree });
      expect(lastAccount()).toBe('work');
    } finally {
      vi.mocked(projectCwdFor).mockImplementation((cwd) => cwd);
      writeFileSync(join(dataDir, 'projects.json'), '{}');
    }
  });

  it('a refused createSession leaves no row and no PTY', async () => {
    (assertAccountReady as ReturnType<typeof vi.fn>).mockImplementationOnce(() => {
      throw new Error('refused');
    });
    await expect(manager.createSession({ cwd: dataDir, account: 'work' })).rejects.toThrow('refused');
    expect(rows.size).toBe(0);
    expect(createPty).not.toHaveBeenCalled();
  });

  it('a Log in session skips the preflight', async () => {
    await manager.createSession({ cwd: dataDir, account: 'work', skipPreflight: true });
    expect(assertAccountReady).not.toHaveBeenCalled();
    expect(lastAccount()).toBe('work');
  });

  it("forkSession and reviveSession keep the row's account", async () => {
    const source = await manager.createSession({ cwd: dataDir, account: 'work' });
    rows.get(source.id)!.claudeSessionId = CLAUDE_ID;
    mkdirSync(join(dataDir, 'claude-project'), { recursive: true });
    writeFileSync(join(dataDir, 'claude-project', `${CLAUDE_ID}.jsonl`), '{}\n');
    const fork = await manager.forkSession(source.id);
    expect(lastAccount()).toBe('work');
    expect(rows.get(fork.id)!.account).toBe('work');

    await manager.shutdown();
    vi.mocked(assertAccountReady).mockClear();
    createSessionManager().reviveSession({ id: source.id });
    expect(lastAccount()).toBe('work');
    expect(assertAccountReady).toHaveBeenCalledWith('work');
  });

  it('openClaudeSession resumes under the account of the row that ran the transcript', async () => {
    vi.mocked(accountForTranscript).mockReturnValueOnce('work');
    const s = await manager.openClaudeSession({ claudeSessionId: CLAUDE_ID, cwd: dataDir, mode: 'resume', account: 'personal' });
    expect(lastAccount()).toBe('work');
    expect(rows.get(s.id)!.account).toBe('work');
  });
});

describe('prompt files', () => {
  it('are deleted with their session row', async () => {
    const s = await manager.createSession({ cwd: dataDir });
    const path = writePromptFile(s.id, 'do the thing');
    expect(path).toBe(promptPathFor(s.id));
    expect(existsSync(path)).toBe(true);
    await manager.deleteSession(s.id);
    expect(existsSync(path)).toBe(false);
  });
});

describe('injectCommand', () => {
  it('types the line once the shell is ready', async () => {
    const pty = createPty();
    injectCommand({ pty } as unknown as ActiveSession, 'claude --permission-mode plan "Read C:/x/p.md and follow it."');
    // Waits for this call, not any call: earlier tests' sessions type theirs on a timer too.
    await vi.waitFor(() =>
      expect(writeToPty).toHaveBeenCalledWith(pty, 'claude --permission-mode plan "Read C:/x/p.md and follow it."\r')
    );
  });

  it('still types `claude --resume <id>` for a history resume, under the session name', async () => {
    const s = await manager.openClaudeSession({ claudeSessionId: CLAUDE_ID, cwd: dataDir, mode: 'resume' });
    await vi.waitFor(() => expect(writeToPty).toHaveBeenCalledWith(s.pty, `claude --resume ${CLAUDE_ID} --name "${s.name}"\r`));
  });
});

describe('loopbackUrl', () => {
  it('turns a wildcard bind into loopback, and keeps a specific host', () => {
    expect(loopbackUrl('http', '0.0.0.0', 4220)).toBe('http://127.0.0.1:4220');
    expect(loopbackUrl('http', '127.0.0.1', 4399)).toBe('http://127.0.0.1:4399');
    expect(loopbackUrl('http', '::1', 4220)).toBe('http://[::1]:4220');
    expect(loopbackUrl('https', '0.0.0.0', 4220)).toBe('https://localhost:4220');
  });
});
