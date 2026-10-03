import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { existsSync, readFileSync, rmSync } from 'fs';
import { join } from 'path';

/**
 * The agent-sessions API (docs/session-orchestration.md): a main session's
 * agent starts a prompted session on a planned track and lists the ones it
 * started. It starts a shell and types into it, so every request must come
 * from loopback AND carry a live session's in-memory token.
 */

// vi.mock is hoisted above the imports, so the temp dir must be too.
const { dataDir } = await vi.hoisted(async () => {
  const { makeTmpDataDir } = await import('./helpers/tmp-data-dir.js');
  return { dataDir: makeTmpDataDir('agent-sessions') };
});

vi.mock('../src/server/config.js', async () => {
  const actual = await vi.importActual<typeof import('../src/server/config.js')>('../src/server/config.js');
  return {
    ...actual,
    getConfig: () => {
      const base = actual.getConfig();
      return { ...base, persistence: { ...base.persistence, dataDir } };
    },
  };
});

import {
  registerAgentSessionRoutes,
  MAX_PROMPT_BYTES,
  type AgentSessionDeps,
} from '../src/server/agent/sessions-api.js';
import { revokeSessionToken, sessionEnv, sessionForToken } from '../src/server/sessions/session-env.js';
import { deletePromptFile, promptDirFor, promptPathFor, writePromptFile } from '../src/server/sessions/prompt-file.js';
import type { ActiveSession, SessionMetadata } from '../src/server/sessions/types.js';

const PROJECT = 'C:\\p\\demo';
const WORKTREE = 'C:\\data\\worktrees\\tracks\\abcd1234';
const MAIN_ID = '11111111-1111-4111-8111-111111111111';

function row(id: string, overrides: Partial<SessionMetadata> = {}): SessionMetadata & { attachable: boolean } {
  return {
    id,
    name: id.slice(0, 4),
    shell: 'pwsh',
    cwd: PROJECT,
    createdAt: '2026-10-01T10:00:00.000Z',
    lastAccessedAt: '2026-10-01T10:00:00.000Z',
    ownerId: null,
    status: 'active',
    cols: 80,
    rows: 24,
    tmuxSession: null,
    categoryId: null,
    sortOrder: 0,
    claudeSessionId: null,
    isFork: false,
    forkJsonlPath: null,
    spawnedBy: null,
    permissionMode: null,
    attachable: true,
    ...overrides,
  };
}

let rows: Map<string, SessionMetadata & { attachable: boolean }>;
let deps: AgentSessionDeps;
let app: FastifyInstance;
let mainToken: string;
let created: number;

function makeDeps(): AgentSessionDeps {
  return {
    sessionForToken,
    getSession: (id) => rows.get(id) ?? null,
    listSessions: () => [...rows.values()],
    projectForCwd: (cwd) => (cwd === PROJECT || cwd.startsWith(WORKTREE) ? { cwd: PROJECT } : null),
    trackExists: (_p, track) => track === 'Split view',
    trackBranches: () => [{ worktreePath: WORKTREE, trackName: 'Split view' }],
    ensureTrackBranch: vi.fn(async () => ({ worktreePath: WORKTREE })),
    needsInstall: vi.fn(() => false),
    installDependencies: vi.fn(async () => ({ ran: true, ok: false, detail: 'npm ci failed' })),
    ensureLocalClaudeSettings: vi.fn(async () => false),
    createSession: vi.fn(async (opts) => {
      const id = `22222222-2222-4222-8222-${String(++created).padStart(12, '0')}`;
      rows.set(
        id,
        row(id, {
          name: opts.name ?? 'x',
          cwd: opts.cwd ?? '',
          spawnedBy: opts.spawnedBy ?? null,
          permissionMode: opts.permissionMode ?? null,
          createdAt: `2026-10-01T10:00:0${created}.000Z`,
        })
      );
      return { id, name: opts.name, cwd: opts.cwd, createdAt: new Date(), lastAccessedAt: new Date(), status: 'active', cols: 80, rows: 24, shell: 'pwsh' } as unknown as ActiveSession;
    }),
    deleteSession: vi.fn(async (id: string) => {
      deletePromptFile(id);
      rows.delete(id);
    }),
    writePromptFile,
    injectCommand: vi.fn(),
    lastNotification: () => undefined,
    broadcastAdded: vi.fn(),
    maxPerParent: () => 2,
  };
}

beforeEach(async () => {
  rows = new Map([[MAIN_ID, row(MAIN_ID)]]);
  created = 0;
  mainToken = sessionEnv(MAIN_ID).CLAUDE_REMOTE_TOKEN;
  deps = makeDeps();
  app = Fastify({ logger: false });
  registerAgentSessionRoutes(app, deps);
  await app.ready();
});

afterEach(async () => {
  await app.close();
});

afterAll(() => rmSync(dataDir, { recursive: true, force: true }));

function start(body: unknown, opts: { token?: string | null; remoteAddress?: string; headers?: Record<string, string> } = {}) {
  const token = opts.token === undefined ? mainToken : opts.token;
  return app.inject({
    method: 'POST',
    url: '/api/agent/sessions',
    remoteAddress: opts.remoteAddress ?? '127.0.0.1',
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...opts.headers },
    payload: body as object,
  });
}

const GOOD = { track: 'Split view', prompt: 'Implement f-abc123 per project/split-view.md.' };

describe('auth', () => {
  it('refuses a non-loopback address with 403, even with a valid token', async () => {
    const res = await start(GOOD, { remoteAddress: '100.101.102.103' });
    expect(res.statusCode).toBe(403);
    expect(deps.createSession).not.toHaveBeenCalled();
  });

  it('never trusts X-Forwarded-For', async () => {
    const res = await start(GOOD, { remoteAddress: '100.101.102.103', headers: { 'x-forwarded-for': '127.0.0.1' } });
    expect(res.statusCode).toBe(403);
  });

  it('accepts IPv6 loopback', async () => {
    const res = await start(GOOD, { remoteAddress: '::1' });
    expect(res.statusCode).toBe(200);
  });

  it('refuses a missing token with 401', async () => {
    expect((await start(GOOD, { token: null })).statusCode).toBe(401);
  });

  it('refuses a wrong token with 401', async () => {
    expect((await start(GOOD, { token: 'f'.repeat(64) })).statusCode).toBe(401);
  });

  it('refuses the token of a PTY that has exited with 401', async () => {
    revokeSessionToken(MAIN_ID);
    expect((await start(GOOD)).statusCode).toBe(401);
  });

  it('refuses a replaced token: a revived session gets a new one and the old one dies', async () => {
    const old = mainToken;
    const fresh = sessionEnv(MAIN_ID).CLAUDE_REMOTE_TOKEN;
    expect(fresh).not.toBe(old);
    expect((await start(GOOD, { token: old })).statusCode).toBe(401);
    expect((await start(GOOD, { token: fresh })).statusCode).toBe(200);
  });

  it('refuses start from a started session with 403', async () => {
    const childId = '33333333-3333-4333-8333-333333333333';
    rows.set(childId, row(childId, { spawnedBy: MAIN_ID, cwd: WORKTREE }));
    const childToken = sessionEnv(childId).CLAUDE_REMOTE_TOKEN;
    const res = await start(GOOD, { token: childToken });
    expect(res.statusCode).toBe(403);
    expect(deps.createSession).not.toHaveBeenCalled();
  });

  it('guards list the same way', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/agent/sessions', remoteAddress: '10.0.0.2', headers: { authorization: `Bearer ${mainToken}` } });
    expect(res.statusCode).toBe(403);
    const res2 = await app.inject({ method: 'GET', url: '/api/agent/sessions', remoteAddress: '127.0.0.1' });
    expect(res2.statusCode).toBe(401);
  });
});

describe('start', () => {
  it('refuses a track nobody planned with 404', async () => {
    const res = await start({ ...GOOD, track: 'Invented' });
    expect(res.statusCode).toBe(404);
    expect(deps.ensureTrackBranch).not.toHaveBeenCalled();
  });

  it('refuses with 429 once the caller has maxPerParent live started sessions', async () => {
    rows.set('c1', row('c1', { spawnedBy: MAIN_ID }));
    rows.set('c2', row('c2', { spawnedBy: MAIN_ID }));
    expect((await start(GOOD)).statusCode).toBe(429);
  });

  it('does not count started sessions whose terminal is gone', async () => {
    rows.set('c1', row('c1', { spawnedBy: MAIN_ID, attachable: false }));
    rows.set('c2', row('c2', { spawnedBy: MAIN_ID }));
    expect((await start(GOOD)).statusCode).toBe(200);
  });

  it('counts starts still waiting on their install toward the limit', async () => {
    let release!: () => void;
    (deps.ensureTrackBranch as ReturnType<typeof vi.fn>).mockImplementation(
      () => new Promise((r) => (release = () => r({ worktreePath: WORKTREE })))
    );
    rows.set('c1', row('c1', { spawnedBy: MAIN_ID }));
    const first = start(GOOD);
    await vi.waitFor(() => expect(deps.ensureTrackBranch).toHaveBeenCalled());
    expect((await start(GOOD)).statusCode).toBe(429);
    release();
    expect((await first).statusCode).toBe(200);
  });

  it('does not count a child whose shell exited, though its PTY entry remains', async () => {
    rows.set('c1', row('c1', { spawnedBy: MAIN_ID, status: 'terminated', attachable: true }));
    rows.set('c2', row('c2', { spawnedBy: MAIN_ID }));
    expect((await start(GOOD)).statusCode).toBe(200);
  });

  it('refuses a second live session on the same track with 409, naming the first', async () => {
    rows.set('c1', row('c1', { spawnedBy: MAIN_ID, cwd: WORKTREE, name: 'Split view' }));
    const res = await start(GOOD);
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toContain('c1');
    expect(deps.ensureTrackBranch).not.toHaveBeenCalled();
  });

  it('allows a new session on a track whose earlier child has exited', async () => {
    rows.set('c1', row('c1', { spawnedBy: MAIN_ID, cwd: WORKTREE, status: 'terminated' }));
    expect((await start(GOOD)).statusCode).toBe(200);
  });

  it('refuses a retry while the first start on that track is still installing (the agent timed out)', async () => {
    let release!: () => void;
    (deps.ensureTrackBranch as ReturnType<typeof vi.fn>).mockImplementation(
      () => new Promise((r) => (release = () => r({ worktreePath: WORKTREE })))
    );
    const first = start(GOOD);
    await vi.waitFor(() => expect(deps.ensureTrackBranch).toHaveBeenCalled());
    const retry = await start(GOOD);
    expect(retry.statusCode).toBe(409);
    expect(retry.json().error).toMatch(/still in progress/);
    release();
    expect((await first).statusCode).toBe(200);
    expect(deps.createSession).toHaveBeenCalledTimes(1);
  });

  it('refuses a prompt path no shell quotes safely, and removes the session it made', async () => {
    deps.writePromptFile = vi.fn(() => 'C:\\Users\\a%b\\prompts\\x.md');
    const res = await start(GOOD);
    expect(res.statusCode).toBe(500);
    expect(deps.injectCommand).not.toHaveBeenCalled();
    expect(deps.deleteSession).toHaveBeenCalled();
  });

  it('maps the global session limit to 429', async () => {
    (deps.createSession as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('Maximum session limit (10) reached'));
    expect((await start(GOOD)).statusCode).toBe(429);
  });

  it.each(['bypassPermissions', 'dontAsk'])('refuses %s with 400', async (permissionMode) => {
    const res = await start({ ...GOOD, permissionMode });
    expect(res.statusCode).toBe(400);
    expect(deps.createSession).not.toHaveBeenCalled();
  });

  it.each(['manual', 'default'])('stores %s as manual and types no --permission-mode', async (permissionMode) => {
    const res = await start({ ...GOOD, permissionMode });
    expect(res.statusCode).toBe(200);
    expect(rows.get(res.json().sessionId)!.permissionMode).toBe('manual');
    const [, line] = (deps.injectCommand as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(line).toMatch(/^claude --add-dir "/);
    expect(line).not.toContain('--permission-mode');
  });

  it('copies the local Claude settings into the worktree before the session is created', async () => {
    const order: string[] = [];
    (deps.ensureLocalClaudeSettings as ReturnType<typeof vi.fn>).mockImplementation(async () => order.push('settings'));
    const create = deps.createSession as ReturnType<typeof vi.fn>;
    const inner = create.getMockImplementation()!;
    create.mockImplementation(async (opts) => (order.push('create'), inner(opts)));
    expect((await start(GOOD)).statusCode).toBe(200);
    expect(deps.ensureLocalClaudeSettings).toHaveBeenCalledWith(PROJECT, WORKTREE);
    expect(order).toEqual(['settings', 'create']);
  });

  it('refuses a prompt over 100 KB with 413', async () => {
    const res = await start({ ...GOOD, prompt: 'x'.repeat(MAX_PROMPT_BYTES + 1) });
    expect(res.statusCode).toBe(413);
  });

  it('refuses an empty prompt or a missing track with 400', async () => {
    expect((await start({ track: 'Split view', prompt: '   ' })).statusCode).toBe(400);
    expect((await start({ prompt: 'hi' })).statusCode).toBe(400);
  });

  it('refuses a caller outside any workspace project with 400', async () => {
    rows.set(MAIN_ID, row(MAIN_ID, { cwd: 'C:\\elsewhere' }));
    expect((await start(GOOD)).statusCode).toBe(400);
  });

  it('starts the session in the worktree, persists who started it and the mode, and types the command', async () => {
    const prompt = 'Line one with "quotes", $HOME and `ticks`\nline two\n';
    const res = await start({ ...GOOD, prompt, permissionMode: 'acceptEdits', name: 'Split view: impl' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toMatchObject({ name: 'Split view: impl', worktreePath: WORKTREE, install: { ran: false, ok: true } });

    expect(deps.createSession).toHaveBeenCalledWith(
      expect.objectContaining({ cwd: WORKTREE, spawnedBy: MAIN_ID, permissionMode: 'acceptEdits', name: 'Split view: impl' })
    );
    const child = rows.get(body.sessionId)!;
    expect(child.spawnedBy).toBe(MAIN_ID);
    expect(child.permissionMode).toBe('acceptEdits');

    // The prompt file: outside the worktree, under the data dir, byte for byte.
    const path = promptPathFor(body.sessionId);
    expect(path.startsWith(dataDir)).toBe(true);
    expect(path.startsWith(WORKTREE)).toBe(false);
    expect(readFileSync(path, 'utf-8')).toBe(prompt);

    // Its own folder, which --add-dir names: readable without asking, and no other session's.
    expect(path).toBe(join(promptDirFor(body.sessionId), 'prompt.md'));
    const dir = promptDirFor(body.sessionId).replace(/\\/g, '/');
    const [, line] = (deps.injectCommand as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(line).toBe(`claude --permission-mode acceptEdits --add-dir "${dir}" "Read ${path.replace(/\\/g, '/')} and follow it."`);
    expect(line).not.toContain('\\');

    expect(deps.broadcastAdded).toHaveBeenCalledWith(
      expect.objectContaining({ id: body.sessionId, spawnedBy: MAIN_ID, permissionMode: 'acceptEdits', attachable: true })
    );
  });

  it('defaults to auto mode and the track name', async () => {
    const res = await start(GOOD);
    expect(res.json().name).toBe('Split view');
    expect(rows.get(res.json().sessionId)!.permissionMode).toBe('auto');
    const [, line] = (deps.injectCommand as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(line).toMatch(/^claude --permission-mode auto --add-dir "[^"]+" "Read /);
  });

  it('installs a worktree that needs it, and still starts the session when the install fails', async () => {
    (deps.needsInstall as ReturnType<typeof vi.fn>).mockReturnValue(true);
    const res = await start(GOOD);
    expect(res.statusCode).toBe(200);
    expect(deps.installDependencies).toHaveBeenCalledWith(WORKTREE);
    expect(res.json().install).toEqual({ ran: true, ok: false, detail: 'npm ci failed' });
    expect(deps.createSession).toHaveBeenCalled();
  });

  it("removes the session's prompt folder when the session is deleted", async () => {
    const res = await start(GOOD);
    const dir = promptDirFor(res.json().sessionId);
    expect(existsSync(promptPathFor(res.json().sessionId))).toBe(true);
    await deps.deleteSession(res.json().sessionId);
    expect(existsSync(dir)).toBe(false);
  });
});

describe('list', () => {
  it("returns only the caller's started sessions, with track, mode and last notification", async () => {
    const at = new Date('2026-10-01T12:00:00.000Z');
    deps.lastNotification = (id) => (id === 'c1' ? { type: 'needs-input', timestamp: at } : undefined);
    rows.set('c1', row('c1', { spawnedBy: MAIN_ID, cwd: WORKTREE, permissionMode: 'plan', createdAt: '2026-10-01T11:00:00.000Z' }));
    // c2's shell exited: its PTY entry remains (attachable in the sidebar), but list reports it done.
    rows.set('c2', row('c2', { spawnedBy: MAIN_ID, cwd: WORKTREE, attachable: true, status: 'terminated', createdAt: '2026-10-01T11:30:00.000Z' }));
    rows.set('other', row('other', { spawnedBy: '99999999-9999-4999-8999-999999999999' }));

    const res = await app.inject({ method: 'GET', url: '/api/agent/sessions', remoteAddress: '127.0.0.1', headers: { authorization: `Bearer ${mainToken}` } });
    expect(res.statusCode).toBe(200);
    expect(res.json().sessions).toEqual([
      { id: 'c1', name: 'c1', track: 'Split view', status: 'active', attachable: true, permissionMode: 'plan', notification: { type: 'needs-input', at: at.toISOString() } },
      { id: 'c2', name: 'c2', track: 'Split view', status: 'terminated', attachable: false, permissionMode: null, notification: null },
    ]);
  });
});
