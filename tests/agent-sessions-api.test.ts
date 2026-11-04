import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
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
  checkPromptArrived,
  peerHeader,
  registerAgentSessionRoutes,
  MAX_PROMPT_BYTES,
  type AgentSessionDeps,
} from '../src/server/agent/sessions-api.js';
import { revokeSessionToken, sessionEnv, sessionForToken } from '../src/server/sessions/session-env.js';
import { deletePromptFile, peerNotesDirFor, promptDirFor, promptPathFor, writePromptFile } from '../src/server/sessions/prompt-file.js';
import type { ActiveSession, SessionMetadata } from '../src/server/sessions/types.js';
import { launchFlags, type LaunchProfile } from '../src/server/sessions/launch-profile.js';
import { storedSessionFields } from '../src/server/websocket/connections.js';

const PROJECT = 'C:\\p\\demo';
const WORKTREE = 'C:\\data\\worktrees\\tracks\\abcd1234';
// The user's Claude config as launchFlags reads it: the servers mcpServersFor offers.
const FAKE_HOME = join(dataDir, 'home');
mkdirSync(FAKE_HOME, { recursive: true });
writeFileSync(join(FAKE_HOME, '.claude.json'), JSON.stringify({ mcpServers: { playwright: { command: 'npx' }, everhour: { command: 'eh' } } }));
const MAIN_ID = '11111111-1111-4111-8111-111111111111';
const TRACK_ID = 'tb-split-view';
// The notes folder the stand-in launch grants a peer; null when it couldn't.
let grantedNotes: string | null = null;

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
    account: 'personal',
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
    ensureTrackBranch: vi.fn(async () => ({ worktreePath: WORKTREE, id: TRACK_ID })),
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
          mcpServers: opts.mcpServers ?? null,
          access: opts.access ?? null,
          account: opts.account ?? 'personal',
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
    mcpServersFor: vi.fn(() => ['playwright', 'everhour']),
    claudeName: vi.fn(() => null),
    // The real flags, reading a stand-in for the user's Claude config.
    // The real flags, reading a stand-in for the user's Claude config. The notes folder is the
    // one track-store would map the worktree to, which this suite doesn't stand up.
    launchFlags: vi.fn((id: string, cwd: string, p: LaunchProfile) => {
      const flags = launchFlags(id, cwd, p, join(FAKE_HOME, '.claude.json'));
      return p.access === 'read' ? { ...flags, notesDir: grantedNotes } : flags;
    }),
    preflight: vi.fn((account: string) => ({ ok: true as const, account, configDir: 'C:\cfg', found: { accountUuid: 'a' } })),
    setMcpServers: vi.fn((id: string, servers: string[]) => {
      const r = rows.get(id);
      if (r) r.mcpServers = servers;
    }),
    injectCommand: vi.fn(),
    lastNotification: () => undefined,
    broadcastAdded: vi.fn(),
    maxPerParent: () => 2,
    promptDelivery: vi.fn(() => ({ state: 'pending' as const })),
    notifyPromptMissing: vi.fn(),
    schedule: vi.fn(),
  };
}

beforeEach(async () => {
  rows = new Map([[MAIN_ID, row(MAIN_ID)]]);
  created = 0;
  grantedNotes = peerNotesDirFor(TRACK_ID).replace(/\\/g, '/');
  mainToken = sessionEnv(MAIN_ID).CLAUDE_REMOTE_TOKEN;
  deps = makeDeps();
  app = Fastify({ logger: false });
  registerAgentSessionRoutes(app, deps);
  await app.ready();
});

afterEach(async () => {
  await app.close();
});


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
    expect(line).toMatch(/^claude --strict-mcp-config --add-dir "/);
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
    // `--` ends --add-dir's list of directories, or the prompt is read as one more.
    expect(line).toBe(`claude --permission-mode acceptEdits --strict-mcp-config --add-dir "${dir}" --name "Split view: impl" -- "Read ${path.replace(/\\/g, '/')} and follow it."`);
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
    expect(line).toMatch(/^claude --permission-mode auto --strict-mcp-config --add-dir "[^"]+" --name "Split view" -- "Read /);
  });

  it("runs under the caller's account, even when the project defaults to another", async () => {
    const res = await start(GOOD);
    expect(res.json().account).toBe('personal');
    expect(deps.createSession).toHaveBeenCalledWith(expect.objectContaining({ account: 'personal' }));
    const registry = join(dataDir, 'projects.json');
    writeFileSync(registry, JSON.stringify({ projects: [{ cwd: PROJECT, account: 'work' }] }));
    try {
      rows = new Map([[MAIN_ID, row(MAIN_ID)]]);
      const res2 = await start(GOOD);
      expect(res2.json().account).toBe('personal');
    } finally {
      rmSync(registry, { force: true });
    }
  });

  it("refuses an account other than the caller's with 403, before creating anything", async () => {
    const res = await start({ ...GOOD, account: 'work' });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toContain('"personal"');
    expect(deps.preflight).not.toHaveBeenCalled();
    expect(deps.ensureTrackBranch).not.toHaveBeenCalled();
    expect(deps.createSession).not.toHaveBeenCalled();
  });

  it("allows naming the caller's own account, and list shows it", async () => {
    rows = new Map([[MAIN_ID, row(MAIN_ID, { account: 'work' })]]);
    const res = await start({ ...GOOD, account: 'work' });
    expect(res.statusCode).toBe(200);
    expect(res.json().account).toBe('work');
    expect(rows.get(res.json().sessionId)!.account).toBe('work');
    const list = await app.inject({
      method: 'GET',
      url: '/api/agent/sessions',
      remoteAddress: '127.0.0.1',
      headers: { authorization: `Bearer ${mainToken}` },
    });
    expect(list.json().sessions[0].account).toBe('work');
  });

  it('refuses a start on the wrong login with 409, naming found and expected, before creating anything', async () => {
    (deps.preflight as ReturnType<typeof vi.fn>).mockReturnValueOnce({
      ok: false,
      account: 'work',
      configDir: 'C:\cfg',
      reason: 'mismatch',
      found: { accountUuid: 'b', emailAddress: 'me@home.example' },
      expected: { organizationUuid: 'org-1' },
      message: 'Account "work" (C:\cfg) is logged in as me@home.example, but expects organization org-1',
    });
    rows = new Map([[MAIN_ID, row(MAIN_ID, { account: 'work' })]]);
    const res = await start(GOOD);
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toContain('me@home.example');
    expect(res.json().error).toContain('org-1');
    expect(deps.preflight).toHaveBeenCalledWith('work');
    expect(deps.ensureTrackBranch).not.toHaveBeenCalled();
    expect(deps.createSession).not.toHaveBeenCalled();
  });

  it('refuses an account the config does not define, before creating anything', async () => {
    const res = await start({ ...GOOD, account: 'nobody' });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain('personal, work');
    expect(deps.ensureTrackBranch).not.toHaveBeenCalled();
    expect(deps.createSession).not.toHaveBeenCalled();
  });

  it('loads no MCP servers by default, and stores that on the row', async () => {
    const res = await start(GOOD);
    expect(deps.createSession).toHaveBeenCalledWith(expect.objectContaining({ mcpServers: [] }));
    expect(rows.get(res.json().sessionId)!.mcpServers).toEqual([]);
    expect(deps.launchFlags).toHaveBeenCalledWith(res.json().sessionId, WORKTREE, { permissionMode: 'auto', mcpServers: [], access: null }, 'personal');
    expect(deps.mcpServersFor).not.toHaveBeenCalled();
  });

  it('scopes in the MCP servers the start names', async () => {
    const res = await start({ ...GOOD, mcpServers: ['playwright', 'playwright'] });
    expect(res.statusCode).toBe(200);
    expect(deps.mcpServersFor).toHaveBeenCalledWith(PROJECT, 'personal');
    expect(rows.get(res.json().sessionId)!.mcpServers).toEqual(['playwright']);
    const [, line] = (deps.injectCommand as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(line).toMatch(/^claude --permission-mode auto --strict-mcp-config --mcp-config "[^"]+" --add-dir /);
    expect(res.json().mcp).toEqual({ ok: true, servers: ['playwright'] });
    expect(deps.setMcpServers).not.toHaveBeenCalled();
  });

  it('still starts when the launch drops a server, but stores and reports what it got', async () => {
    // The check passed, then the config lost the server (or its file couldn't be written).
    (deps.launchFlags as ReturnType<typeof vi.fn>).mockImplementationOnce((id: string, cwd: string, p: LaunchProfile) =>
      launchFlags(id, cwd, { ...p, mcpServers: ['everhour'] }, join(FAKE_HOME, '.claude.json'))
    );
    const res = await start({ ...GOOD, mcpServers: ['playwright', 'everhour'] });
    expect(res.statusCode).toBe(200);
    expect(res.json().mcp).toMatchObject({ ok: false, servers: ['everhour'] });
    expect(res.json().mcp.detail).toContain('playwright');
    expect(rows.get(res.json().sessionId)!.mcpServers).toEqual(['everhour']);
  });

  it('refuses an MCP server the config does not define, naming the ones it does, before creating anything', async () => {
    const res = await start({ ...GOOD, mcpServers: ['playwright', 'slack'] });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain('"slack"');
    expect(res.json().error).toContain('playwright, everhour');
    expect(deps.ensureTrackBranch).not.toHaveBeenCalled();
    expect(deps.createSession).not.toHaveBeenCalled();
  });

  it.each([['playwright'], [['a b']], [[1]], [Array.from({ length: 9 }, (_, i) => `s${i}`)]])(
    'refuses malformed mcpServers %j with 400',
    async (mcpServers) => {
      expect((await start({ ...GOOD, mcpServers })).statusCode).toBe(400);
      expect(deps.createSession).not.toHaveBeenCalled();
    }
  );

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
    rows.set('c1', row('c1', { spawnedBy: MAIN_ID, cwd: WORKTREE, permissionMode: 'plan', mcpServers: ['playwright'], createdAt: '2026-10-01T11:00:00.000Z' }));
    // c2's shell exited: its PTY entry remains (attachable in the sidebar), but list reports it done.
    rows.set('c2', row('c2', { spawnedBy: MAIN_ID, cwd: WORKTREE, attachable: true, status: 'terminated', createdAt: '2026-10-01T11:30:00.000Z' }));
    rows.set('other', row('other', { spawnedBy: '99999999-9999-4999-8999-999999999999' }));

    const res = await app.inject({ method: 'GET', url: '/api/agent/sessions', remoteAddress: '127.0.0.1', headers: { authorization: `Bearer ${mainToken}` } });
    expect(res.statusCode).toBe(200);
    expect(res.json().sessions).toEqual([
      { id: 'c1', name: 'c1', track: 'Split view', status: 'active', attachable: true, permissionMode: 'plan', mcpServers: ['playwright'], account: 'personal', access: 'write', notification: { type: 'needs-input', at: at.toISOString() }, prompt: { state: 'pending' } },
      { id: 'c2', name: 'c2', track: 'Split view', status: 'terminated', attachable: false, permissionMode: null, mcpServers: null, account: 'personal', access: 'write', notification: null, prompt: { state: 'pending' } },
    ]);
  });
});

describe('did the prompt arrive', () => {
  it('schedules one check after the grace period for each start', async () => {
    const res = await start(GOOD);
    expect(res.statusCode).toBe(200);
    const schedule = deps.schedule as ReturnType<typeof vi.fn>;
    expect(schedule).toHaveBeenCalledTimes(1);
    expect(schedule.mock.calls[0][1]).toBe(90_000);
  });

  it('notifies once the check finds the prompt never arrived', async () => {
    const id = (await start(GOOD)).json().sessionId;
    deps.promptDelivery = vi.fn(() => ({ state: 'not-received' as const, detail: 'Claude started, but the prompt never reached it' }));
    (deps.schedule as ReturnType<typeof vi.fn>).mock.calls[0][0]();
    expect(deps.notifyPromptMissing).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'prompt-missing', sessionId: id, name: 'Split view', detail: 'Claude started, but the prompt never reached it' })
    );
  });

  it('stays quiet when the prompt arrived, or the session is gone or exited', () => {
    rows.set('c1', row('c1', { spawnedBy: MAIN_ID, cwd: WORKTREE }));
    deps.promptDelivery = vi.fn(() => ({ state: 'received' as const }));
    checkPromptArrived(deps, 'c1');

    deps.promptDelivery = vi.fn(() => ({ state: 'not-received' as const }));
    checkPromptArrived(deps, 'deleted');
    rows.set('c2', row('c2', { spawnedBy: MAIN_ID, cwd: WORKTREE, status: 'terminated' }));
    checkPromptArrived(deps, 'c2');

    expect(deps.notifyPromptMissing).not.toHaveBeenCalled();
  });

  it('never throws from the timer, even when the check does', () => {
    rows.set('c1', row('c1', { spawnedBy: MAIN_ID, cwd: WORKTREE }));
    deps.promptDelivery = vi.fn(() => {
      throw new Error('disk gone');
    });
    expect(() => checkPromptArrived(deps, 'c1')).not.toThrow();
  });
});

describe('read-only peers (project/builder-critic-pairs.md)', () => {
  const PEER = { ...GOOD, access: 'read', prompt: 'Review Split view against project/split-view.md.' };

  async function startBuilder(body: Record<string, unknown> = {}) {
    const res = await start({ ...GOOD, ...body });
    expect(res.statusCode).toBe(200);
    return res.json();
  }

  it('refuses a peer with no live writer on the track with 409, before creating anything', async () => {
    const res = await start(PEER);
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toMatch(/start the builder first/);
    expect(deps.ensureTrackBranch).not.toHaveBeenCalled();
    // An exited builder is no builder.
    rows.set('c1', row('c1', { spawnedBy: MAIN_ID, cwd: WORKTREE, status: 'terminated' }));
    expect((await start(PEER)).statusCode).toBe(409);
    expect(deps.createSession).not.toHaveBeenCalled();
  });

  it('starts a peer beside the builder: access read, a default name, the notes folder, the read-only launch', async () => {
    await startBuilder();
    const res = await start(PEER);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    const notes = peerNotesDirFor(TRACK_ID).replace(/\\/g, '/');
    expect(body).toMatchObject({ name: 'Split view peer', access: 'read', notesPath: notes, worktreePath: WORKTREE });
    expect(notes.startsWith(dataDir.replace(/\\/g, '/'))).toBe(true);
    expect(deps.createSession).toHaveBeenLastCalledWith(expect.objectContaining({ access: 'read', spawnedBy: MAIN_ID, cwd: WORKTREE }));
    expect(rows.get(body.sessionId)!.access).toBe('read');
    expect(deps.launchFlags).toHaveBeenLastCalledWith(body.sessionId, WORKTREE, { permissionMode: 'auto', mcpServers: [], access: 'read' }, 'personal');
    expect(deps.broadcastAdded).toHaveBeenLastCalledWith(expect.objectContaining({ id: body.sessionId, access: 'read' }));
  });

  it('gives the builder access write, no notes folder and no header', async () => {
    const body = await startBuilder();
    expect(body.access).toBe('write');
    expect(body.notesPath).toBeUndefined();
    expect(rows.get(body.sessionId)!.access ?? null).toBeNull();
    expect(readFileSync(promptPathFor(body.sessionId), 'utf-8')).toBe(GOOD.prompt);
  });

  it("starts the peer's prompt file with the server's header, then the parent's brief", async () => {
    await startBuilder({ name: 'Split view builder' });
    (deps.claudeName as ReturnType<typeof vi.fn>).mockImplementation((id: string | null) => (id === 'cc-main' ? 'planner' : null));
    rows.set(MAIN_ID, row(MAIN_ID, { claudeSessionId: 'cc-main' }));
    const body = (await start({ ...PEER, name: 'Split view reviewer' })).json();
    const text = readFileSync(promptPathFor(body.sessionId), 'utf-8');
    expect(text).toBe(
      peerHeader({ worktreePath: WORKTREE, mainCheckout: PROJECT, notesPath: grantedNotes, writer: 'Split view builder', parent: 'planner' }) + PEER.prompt
    );
    expect(deps.claudeName).toHaveBeenCalledWith('cc-main');
  });

  it('names the parent by its session name when no Claude name is known', async () => {
    await startBuilder();
    const body = (await start(PEER)).json();
    expect(readFileSync(promptPathFor(body.sessionId), 'utf-8')).toContain(`your parent is \`${rows.get(MAIN_ID)!.name}\``);
  });

  it('names the second peer "peer 2", and refuses a third with 409', async () => {
    deps.maxPerParent = () => 5;
    await startBuilder();
    expect((await start(PEER)).json().name).toBe('Split view peer');
    expect((await start(PEER)).json().name).toBe('Split view peer 2');
    const third = await start(PEER);
    expect(third.statusCode).toBe(409);
    expect(third.json().error).toMatch(/already has 2 read-only peers/);
    expect(deps.createSession).toHaveBeenCalledTimes(3);
  });

  it('frees a peer slot when a peer exits, never reusing a live name', async () => {
    deps.maxPerParent = () => 5;
    await startBuilder();
    const first = (await start(PEER)).json();
    await start(PEER);
    rows.get(first.sessionId)!.status = 'terminated';
    const res = await start(PEER);
    expect(res.statusCode).toBe(200);
    expect(res.json().name).toBe('Split view peer 3');
  });

  it('still refuses a second writer with 409 while peers run', async () => {
    deps.maxPerParent = () => 5;
    await startBuilder();
    await start(PEER);
    const res = await start(GOOD);
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toMatch(/already started "Split view"/);
  });

  it('counts peers toward maxPerParent', async () => {
    await startBuilder();
    expect((await start(PEER)).statusCode).toBe(200);
    expect((await start(PEER)).statusCode).toBe(429);
  });

  it('refuses a peer from the builder itself (a started session) with 403', async () => {
    const builder = await startBuilder();
    const res = await start(PEER, { token: sessionEnv(builder.sessionId).CLAUDE_REMOTE_TOKEN });
    expect(res.statusCode).toBe(403);
  });

  it("refuses a peer while the builder's start is still running, and a third peer while two are starting", async () => {
    deps.maxPerParent = () => 5;
    let release!: () => void;
    (deps.ensureTrackBranch as ReturnType<typeof vi.fn>).mockImplementationOnce(
      () => new Promise((r) => (release = () => r({ worktreePath: WORKTREE, id: TRACK_ID })))
    );
    const builder = start(GOOD);
    await vi.waitFor(() => expect(deps.ensureTrackBranch).toHaveBeenCalled());
    const early = await start(PEER);
    expect(early.statusCode).toBe(409);
    expect(early.json().error).toMatch(/still in progress/);
    release();
    expect((await builder).statusCode).toBe(200);

    const releases: (() => void)[] = [];
    (deps.ensureTrackBranch as ReturnType<typeof vi.fn>).mockImplementation(
      () => new Promise((r) => releases.push(() => r({ worktreePath: WORKTREE, id: TRACK_ID })))
    );
    const a = start(PEER);
    const b = start(PEER);
    await vi.waitFor(() => expect(releases).toHaveLength(2));
    expect((await start(PEER)).statusCode).toBe(409);
    releases.forEach((r) => r());
    const [ra, rb] = [await a, await b];
    expect([ra.statusCode, rb.statusCode]).toEqual([200, 200]);
    // Two starts in flight at once still get different names.
    expect(new Set([ra.json().name, rb.json().name]).size).toBe(2);
  });

  it("gives a peer its builder's permission mode unless the start names one", async () => {
    deps.maxPerParent = () => 5;
    await startBuilder({ permissionMode: 'acceptEdits' });
    const inherited = (await start(PEER)).json();
    expect(rows.get(inherited.sessionId)!.permissionMode).toBe('acceptEdits');
    const named = (await start({ ...PEER, permissionMode: 'plan' })).json();
    expect(rows.get(named.sessionId)!.permissionMode).toBe('plan');
  });

  it('refuses an access other than read or write with 400', async () => {
    expect((await start({ ...GOOD, access: 'admin' })).statusCode).toBe(400);
    expect((await start({ ...GOOD, access: 'write' })).statusCode).toBe(200);
  });

  it('list shows each session as write or read', async () => {
    await startBuilder();
    await start(PEER);
    const res = await app.inject({ method: 'GET', url: '/api/agent/sessions', remoteAddress: '127.0.0.1', headers: { authorization: `Bearer ${mainToken}` } });
    expect(res.json().sessions.map((s: { name: string; access: string }) => [s.name, s.access])).toEqual([
      ['Split view', 'write'],
      ['Split view peer', 'read'],
    ]);
  });
});

describe('peerHeader', () => {
  it('states the read-only rule, the Bash rule, the notes folder, the writer and the parent, with forward slashes', () => {
    const text = peerHeader({ worktreePath: 'C:\\wt\\abcd', mainCheckout: 'C:\\p\\demo', notesPath: 'C:\\data\\peers\\tb', writer: 'Builder', parent: 'planner' });
    expect(text).toContain('Read-only in `C:/wt/abcd`');
    expect(text).toContain('and in `C:/p/demo`');
    expect(text).toContain('Write nowhere but your notes folder');
    expect(text).toMatch(/Edit, Write and NotebookEdit are denied/);
    expect(text).toMatch(/Bash is not fenced/);
    for (const cmd of ['git add', 'commit', 'checkout', 'stash', 'reset']) expect(text).toContain(cmd);
    expect(text).toMatch(/no builds, no installs/);
    expect(text).toContain('notes folder is `C:/data/peers/tb`');
    expect(text).toContain('The writer is `Builder`');
    expect(text).toContain('your parent is `planner`');
    expect(text).not.toContain('\\');
    // The brief follows a rule, so the facts never run into it.
    expect(text.endsWith('---\n\n')).toBe(true);
  });
});

describe('read-only peers: names, the notes folder and slots (code review fixes)', () => {
  const PEER = { ...GOOD, access: 'read', prompt: 'Review it.' };
  const startBuilder = async (body: Record<string, unknown> = {}) => (await start({ ...GOOD, ...body })).json();

  it('refuses a name a live session of the caller already has with 409, before creating anything', async () => {
    deps.maxPerParent = () => 5;
    await startBuilder({ name: 'Split view builder' });
    const res = await start({ ...PEER, name: 'Split view builder' });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toMatch(/already has a live session named "Split view builder"/);
    expect(deps.createSession).toHaveBeenCalledTimes(1);
    // An exited session's name is free again.
    rows.set('c9', row('c9', { spawnedBy: MAIN_ID, cwd: 'C:\\elsewhere', name: 'Old', status: 'terminated' }));
    expect((await start({ ...PEER, name: 'Old' })).statusCode).toBe(200);
  });

  it("refuses a peer name its builder couldn't message it by with 400", async () => {
    await startBuilder();
    for (const name of ['Review!', 'a"b', '50% peer']) {
      expect((await start({ ...PEER, name })).statusCode).toBe(400);
    }
    expect(deps.createSession).toHaveBeenCalledTimes(1);
  });

  it("names the builder by its Claude name in the header and the default peer name, unquotable characters dropped", async () => {
    const builder = await startBuilder({ name: 'Split view builder' });
    rows.get(builder.sessionId)!.claudeSessionId = 'cc-builder';
    (deps.claudeName as ReturnType<typeof vi.fn>).mockImplementation((id: string | null) => (id === 'cc-builder' ? 'wt-8b4c!' : null));
    const body = (await start(PEER)).json();
    expect(body.name).toBe('wt-8b4c peer');
    expect(readFileSync(promptPathFor(body.sessionId), 'utf-8')).toContain('The writer is `wt-8b4c!`');
  });

  it("says so in the header, and leaves notesPath out, when the launch couldn't grant a notes folder", async () => {
    await startBuilder();
    grantedNotes = null;
    const body = (await start(PEER)).json();
    expect(body.notesPath).toBeUndefined();
    const text = readFileSync(promptPathFor(body.sessionId), 'utf-8');
    expect(text).toContain('You have no notes folder this time');
    expect(text).not.toContain('Your notes folder is');
  });

  it("prints the notes folder the launch granted, not one of its own", async () => {
    await startBuilder();
    grantedNotes = 'C:/granted/notes';
    const body = (await start(PEER)).json();
    expect(body.notesPath).toBe('C:/granted/notes');
    expect(readFileSync(promptPathFor(body.sessionId), 'utf-8')).toContain('notes folder is `C:/granted/notes`');
  });

  it('frees the peer slot when a peer start fails, so the track never sticks at two', async () => {
    deps.maxPerParent = () => 5;
    await startBuilder();
    (deps.createSession as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('spawn failed'));
    expect((await start(PEER)).statusCode).toBe(500);
    (deps.createSession as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('spawn failed'));
    expect((await start(PEER)).statusCode).toBe(500);
    expect((await start(PEER)).statusCode).toBe(200);
    expect((await start(PEER)).statusCode).toBe(200);
  });
});

describe('storedSessionFields', () => {
  it("carries every stored field a reply needs, access included, with defaults for a missing row", () => {
    expect(storedSessionFields({ categoryId: 'c', sortOrder: 3, isFork: true, claudeSessionId: 'x', spawnedBy: 'p', permissionMode: 'plan', access: 'read' })).toEqual({
      categoryId: 'c', sortOrder: 3, isFork: true, claudeSessionId: 'x', spawnedBy: 'p', permissionMode: 'plan', access: 'read',
    });
    expect(storedSessionFields(null)).toEqual({
      categoryId: null, sortOrder: 0, isFork: false, claudeSessionId: null, spawnedBy: null, permissionMode: null, access: null,
    });
  });
});
