import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import { execFileSync } from 'child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import Fastify, { type FastifyInstance } from 'fastify';

// Real repositories: every git spawn costs ~50-100ms on Windows, and the
// suites run in parallel, so the 5s default is too tight under load.
vi.setConfig({ testTimeout: 30_000 });

/**
 * A track's session asks to Land it (POST /api/agent/land).
 *
 * Phase 1 runs in the request, so every refusal reaches the agent while it
 * can still act; phase 2 runs after the 202, and the Land closes the session
 * that asked. What matters is order — reply, then close, then merge — and
 * that a Land failing in phase 2 still reports, and leaves the track as it
 * was. Phase 2 runs the real landTrack against a real repository; only the
 * session manager and the notifier are fakes.
 */

const dataDir = mkdtempSync(join(tmpdir(), 'cr-agent-land-data-'));
const configPath = join(dataDir, 'config.json');
writeFileSync(configPath, JSON.stringify({ persistence: { dataDir } }));
process.env.CLAUDE_REMOTE_CONFIG = configPath;

const { loadConfig } = await import('../src/server/config.js');
const { initDatabase, closeDatabase, getDatabase } = await import('../src/server/db/schema.js');
const tracks = await import('../src/server/projects/track-branches.js');
const { updateAndInstall } = await import('../src/server/projects/track-land.js');
const api = await import('../src/server/agent/sessions-api.js');
const { sessionEnv, sessionForToken } = await import('../src/server/sessions/session-env.js');
type LandNotificationPayload = import('../src/server/websocket/protocol.js').LandNotificationPayload;
type SessionMetadata = import('../src/server/sessions/types.js').SessionMetadata;

const DOC = `## Track: Alpha
- [ ] \`f-aaaaaa\` First step → project/alpha.md

## Track: Beta
- [ ] \`f-cccccc\` Unrelated
`;

const ORCHESTRATOR = '11111111-1111-4111-8111-111111111111';
const CALLER = '22222222-2222-4222-8222-222222222222';
const OTHER = '33333333-3333-4333-8333-333333333333';

let repo: string;
let app: FastifyInstance;
let landDeps: import('../src/server/agent/sessions-api.js').AgentLandDeps;
let sessions: Map<string, Partial<SessionMetadata> & { id: string; cwd: string }>;
let events: string[];
let notified: LandNotificationPayload[];
/** Projects an Update announced to open boards. */
let announced: string[];
/** Runs inside terminateSession: what is true at the moment a session is closed. */
let onClose: (id: string) => void;

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8' }).trim();
}

function commitFile(cwd: string, rel: string, content: string, message: string): void {
  mkdirSync(join(cwd, rel, '..'), { recursive: true });
  writeFileSync(join(cwd, rel), content);
  git(cwd, 'add', '--', rel);
  git(cwd, 'commit', '-q', '-m', message);
}

beforeAll(() => {
  loadConfig();
  initDatabase();
});

afterAll(() => {
  closeDatabase();
  rmSync(dataDir, { recursive: true, force: true });
});

beforeEach(async () => {
  getDatabase().exec('DELETE FROM track_branches');
  repo = mkdtempSync(join(tmpdir(), 'cr-agent-land-repo-'));
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'config', 'user.email', 'test@example.com');
  git(repo, 'config', 'user.name', 'Test');
  git(repo, 'config', 'commit.gpgsign', 'false');
  writeFileSync(join(repo, 'PROJECT.md'), DOC);
  mkdirSync(join(repo, 'project'));
  writeFileSync(join(repo, 'project', 'alpha.md'), '# Alpha\n');
  writeFileSync(join(repo, 'shared.ts'), 'one\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-q', '-m', 'plan');

  events = [];
  notified = [];
  onClose = () => {};
  sessions = new Map();

  // Real phase-1 checks and the real landTrack; the session manager (who is
  // running where, and closing them) and the notifier are the fakes.
  landDeps = {
    ...api.defaultLandDeps,
    getSession: (id) => (sessions.get(id) as SessionMetadata | undefined) ?? null,
    listSessions: () => [...sessions.values()].map((s) => ({ id: s.id, cwd: s.cwd, spawnedBy: s.spawnedBy ?? null })),
    projectForCwd: () => ({ cwd: repo }),
    land: (project, track) =>
      tracks.landTrack(project, track, {
        sessions: [...sessions.values()].map((s) => ({ id: s.id, cwd: s.cwd })),
        terminateSession: async (id) => {
          events.push(`close ${id}`);
          onClose(id);
          sessions.delete(id);
        },
        removeSessions: async () => undefined,
      }),
    notify: (payload) => {
      events.push(`notify ${payload.ok ? 'ok' : 'failed'}`);
      notified.push(payload);
    },
  };
  announced = [];
  // The real Update under the real lock; no reinstall (the repo has no
  // lockfile) and no WebSocket.
  const updateDeps: import('../src/server/agent/sessions-api.js').AgentUpdateDeps = {
    getSession: landDeps.getSession,
    listSessions: landDeps.listSessions,
    trackBranchFor: landDeps.trackBranchFor,
    projectForCwd: landDeps.projectForCwd,
    update: (project, track) =>
      updateAndInstall(project, track, {
        install: async () => ({ ran: false, ok: true, detail: 'nothing to install' }),
        announce: (cwd) => announced.push(cwd),
      }),
  };
  app = Fastify({ logger: false });
  api.registerAgentSessionRoutes(app, { ...api.defaultDeps, sessionForToken }, landDeps, updateDeps);
  await app.ready();
});

afterEach(async () => {
  await app.close();
  rmSync(repo, { recursive: true, force: true });
});

/** A started session (spawned by an orchestrator) in the track's worktree, as the usual caller is. */
async function trackSession() {
  const t = await tracks.ensureTrackBranch({ cwd: repo }, 'Alpha');
  sessions.set(ORCHESTRATOR, { id: ORCHESTRATOR, cwd: repo, spawnedBy: null });
  sessions.set(CALLER, { id: CALLER, cwd: t.worktreePath, spawnedBy: ORCHESTRATOR });
  return t;
}

async function land(opts: { as?: string; token?: string | null; remoteAddress?: string; track?: unknown } = {}) {
  const token = opts.token === undefined ? sessionEnv(opts.as ?? CALLER).CLAUDE_REMOTE_TOKEN : opts.token;
  const res = await app.inject({
    method: 'POST',
    url: '/api/agent/land',
    remoteAddress: opts.remoteAddress ?? '127.0.0.1',
    headers: token ? { authorization: `Bearer ${token}` } : {},
    ...(opts.track === undefined ? {} : { payload: { track: opts.track } }),
  });
  events.push(`reply ${res.statusCode}`);
  return res;
}

/** Phase 2's one notification, failing with what was missing rather than a bare timeout. */
async function notification(): Promise<LandNotificationPayload> {
  await vi.waitFor(() => expect(notified, 'phase 2 sent no notification').toHaveLength(1), {
    timeout: 20_000,
    interval: 100,
  });
  return notified[0];
}

describe('auth and the caller’s track', () => {
  it('refuses a request with no token (401)', async () => {
    await trackSession();
    expect((await land({ token: null })).statusCode).toBe(401);
  });

  it('refuses a non-loopback address (403), even with a valid token', async () => {
    await trackSession();
    expect((await land({ remoteAddress: '100.101.102.103' })).statusCode).toBe(403);
  });

  it('refuses a session in the main checkout (400): it is in no track’s worktree', async () => {
    await trackSession();
    const res = await land({ as: ORCHESTRATOR });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/isn't in a track's worktree/);
    expect(tracks.getActiveTrackBranch(repo, 'Alpha')).not.toBeNull();
  });

  it('accepts a started session in its own track’s worktree (202)', async () => {
    await trackSession();
    const res = await land();
    expect(res.statusCode).toBe(202);
    expect(res.json()).toMatchObject({ accepted: true, track: 'Alpha' });
    await notification();
  });
});

describe('a parent lands a track its started session worked in', () => {
  it('accepts the orchestrator naming its child’s track, closes the child and keeps the parent', async () => {
    const t = await trackSession();
    commitFile(t.worktreePath, 'src/a.ts', 'export const a = 1;\n', 'implement a');

    const res = await land({ as: ORCHESTRATOR, track: 'Alpha' });
    await notification();

    expect(res.statusCode).toBe(202);
    expect(res.json()).toMatchObject({ accepted: true, track: 'Alpha', closesCaller: false });
    expect(res.json().detail).toMatch(/the track's sessions will close/);
    expect(events).toEqual(['reply 202', `close ${CALLER}`, 'notify ok']);
    expect(sessions.has(ORCHESTRATOR)).toBe(true);
    expect(git(repo, 'log', '-1', '--format=%s')).toBe('Merge track: Alpha');
  });

  it('refuses a track none of the caller’s started sessions works in (403), closing nobody', async () => {
    await trackSession();
    const beta = await tracks.ensureTrackBranch({ cwd: repo }, 'Beta');
    // Someone else's session on Beta, not one the orchestrator started.
    sessions.set(OTHER, { id: OTHER, cwd: beta.worktreePath, spawnedBy: null });

    const res = await land({ as: ORCHESTRATOR, track: 'Beta' });

    expect(res.statusCode).toBe(403);
    expect(res.json().error).toMatch(/"Beta" is not a track this session or a session it started works in/);
    expect(events).toEqual(['reply 403']);
    expect(tracks.getActiveTrackBranch(repo, 'Beta')).not.toBeNull();
  });

  it('refuses a started session naming a sibling’s track (403)', async () => {
    await trackSession();
    const beta = await tracks.ensureTrackBranch({ cwd: repo }, 'Beta');
    sessions.set(OTHER, { id: OTHER, cwd: beta.worktreePath, spawnedBy: ORCHESTRATOR });

    expect((await land({ as: CALLER, track: 'Beta' })).statusCode).toBe(403);
    expect(sessions.has(OTHER)).toBe(true);
  });

  it('lets a session name its own track, and still closes it', async () => {
    await trackSession();
    const res = await land({ track: 'Alpha' });
    expect(res.statusCode).toBe(202);
    expect(res.json().closesCaller).toBe(true);
    await notification();
  });

  it('refuses a track that is not a string (400)', async () => {
    await trackSession();
    expect((await land({ as: ORCHESTRATOR, track: 42 })).statusCode).toBe(400);
    expect((await land({ as: ORCHESTRATOR, track: '  ' })).statusCode).toBe(400);
  });
});

describe('phase 1: refusals reach the agent', () => {
  it('names the uncommitted code in the worktree, and closes nobody', async () => {
    const t = await trackSession();
    writeFileSync(join(t.worktreePath, 'scratch.ts'), 'wip\n');

    const res = await land();

    expect(res.statusCode).toBe(409);
    expect(res.json().error).toContain('scratch.ts');
    expect(sessions.has(CALLER)).toBe(true);
    expect(events).toEqual(['reply 409']);
    expect(tracks.getActiveTrackBranch(repo, 'Alpha')).not.toBeNull();
  });

  it('refuses a merge that would conflict, naming the file', async () => {
    const t = await trackSession();
    commitFile(t.worktreePath, 'shared.ts', 'track side\n', 'track edit');
    commitFile(repo, 'shared.ts', 'main side\n', 'main edit');

    const res = await land();

    expect(res.statusCode).toBe(409);
    expect(res.json().error).toMatch(/would conflict with main in shared\.ts/);
    expect(sessions.has(CALLER)).toBe(true);
  });
});

describe('phase 2: after the reply', () => {
  it('replies first, closes the worktree’s sessions before merging, then notifies once with Land’s detail', async () => {
    const t = await trackSession();
    commitFile(t.worktreePath, 'src/a.ts', 'export const a = 1;\n', 'implement a');
    sessions.set(OTHER, { id: OTHER, cwd: join(t.worktreePath, 'src'), spawnedBy: null });
    const mainBefore = git(repo, 'rev-parse', 'HEAD');
    const headAtClose: string[] = [];
    onClose = () => headAtClose.push(git(repo, 'rev-parse', 'HEAD'));

    const res = await land();
    await notification();

    expect(res.statusCode).toBe(202);
    expect(events[0]).toBe('reply 202');
    expect(events.slice(1).sort()).toEqual([`close ${CALLER}`, `close ${OTHER}`, 'notify ok'].sort());
    expect(events.at(-1)).toBe('notify ok');
    // Closed before anything was merged into main.
    expect(headAtClose).toEqual([mainBefore, mainBefore]);
    expect(sessions.has(ORCHESTRATOR)).toBe(true); // in main, not the worktree

    expect(notified).toHaveLength(1);
    expect(notified[0]).toMatchObject({ kind: 'land', projectCwd: repo, track: 'Alpha', ok: true });
    expect(notified[0].detail).toMatch(/^Landed into main/);
    expect(git(repo, 'log', '-1', '--format=%s')).toBe('Merge track: Alpha');
    expect(existsSync(join(repo, 'src', 'a.ts'))).toBe(true);
    expect(tracks.getActiveTrackBranch(repo, 'Alpha')).toBeNull();
  });

  it('reports a Land failing in phase 2, and leaves the track unlanded with its worktree', async () => {
    const t = await trackSession();
    commitFile(t.worktreePath, 'shared.ts', 'track side\n', 'track edit');
    // Phase 1 passed; main moves in between, as another session committing would.
    onClose = () => commitFile(repo, 'shared.ts', 'main side\n', 'main edit meanwhile');

    const res = await land();
    await notification();

    expect(res.statusCode).toBe(202);
    expect(notified).toHaveLength(1);
    expect(notified[0]).toMatchObject({ kind: 'land', track: 'Alpha', ok: false });
    expect(notified[0].detail).toMatch(/^Landing "Alpha" failed: Merging .* failed/);
    expect(tracks.getActiveTrackBranch(repo, 'Alpha')).not.toBeNull();
    expect(existsSync(t.worktreePath)).toBe(true);
    expect(readFileSync(join(t.worktreePath, 'shared.ts'), 'utf-8').replace(/\r\n/g, '\n')).toBe('track side\n');
    expect(git(repo, 'log', '-1', '--format=%s')).toBe('main edit meanwhile');
  });
});

describe('one Land at a time, and the edges', () => {
  it('refuses while another track operation holds the project (409), closing nobody', async () => {
    await trackSession();
    const { withProjectLock } = await import('../src/server/projects/project-lock.js');
    await withProjectLock(repo, 'landing "Beta"', async () => {
      const res = await land();
      expect(res.statusCode).toBe(409);
      expect(res.json().error).toMatch(/busy \(landing "Beta"\)/);
    });
    expect(sessions.has(CALLER)).toBe(true);
    expect(notified).toEqual([]);
  });

  it('refuses a second Land of the track while the first is under way, and forgets it once it ends', async () => {
    await trackSession();
    const failing = { ...landDeps, land: async () => Promise.reject(new Error('boom')) };
    const first = await api.requestLand(failing, CALLER);

    await expect(api.requestLand(failing, CALLER)).rejects.toMatchObject({
      status: 409,
      message: expect.stringMatching(/already under way/),
    });

    await api.runRequestedLand(failing, first);
    expect(notified).toHaveLength(1);
    expect(notified[0]).toMatchObject({ ok: false, detail: 'Landing "Alpha" failed: boom' });
    // Ended (here, failed): the track can be landed again.
    const again = await api.requestLand(failing, CALLER);
    api.dropAcceptedLand(again);
  });

  it('never throws from phase 2, even when the result cannot be sent', async () => {
    await trackSession();
    const deps = {
      ...landDeps,
      land: async () => ({ detail: 'Landed into main' }),
      notify: () => {
        throw new Error('socket gone');
      },
    };
    const accepted = await api.requestLand(deps, CALLER);
    await expect(api.runRequestedLand(deps, accepted)).resolves.toBeUndefined();
    // And the track is no longer marked as under way.
    api.dropAcceptedLand(await api.requestLand(deps, CALLER));
  });

  it('refuses a session whose folder resolves to a different project (400)', async () => {
    await trackSession();
    const deps = { ...landDeps, projectForCwd: () => ({ cwd: dataDir }) };
    await expect(api.requestLand(deps, CALLER)).rejects.toMatchObject({
      status: 400,
      message: expect.stringMatching(/not in a workspace project/),
    });
  });
});

/**
 * A track's session asks to Update it from main (POST /api/agent/update):
 * the same caller scoping as Land, one phase, the outcome as the reply.
 */
describe('update from main', () => {
  async function update(opts: { as?: string; token?: string | null; remoteAddress?: string; track?: unknown } = {}) {
    const token = opts.token === undefined ? sessionEnv(opts.as ?? CALLER).CLAUDE_REMOTE_TOKEN : opts.token;
    return app.inject({
      method: 'POST',
      url: '/api/agent/update',
      remoteAddress: opts.remoteAddress ?? '127.0.0.1',
      headers: token ? { authorization: `Bearer ${token}` } : {},
      ...(opts.track === undefined ? {} : { payload: { track: opts.track } }),
    });
  }

  it('refuses no token (401), a non-loopback address (403) and a session in main with no track (400)', async () => {
    await trackSession();
    expect((await update({ token: null })).statusCode).toBe(401);
    expect((await update({ remoteAddress: '100.101.102.103' })).statusCode).toBe(403);
    const res = await update({ as: ORCHESTRATOR });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/isn't in a track's worktree/);
  });

  it('merges main into the caller’s own track, keeps its plan and session, and tells the boards', async () => {
    const t = await trackSession();
    commitFile(repo, 'src/main.ts', 'export const m = 1;\n', 'code on main');

    const res = await update();

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ track: 'Alpha', mergeSha: git(t.worktreePath, 'rev-parse', 'HEAD'), install: null });
    expect(res.json().detail).toContain('Merged 1 commit from main into the track.');
    expect(git(t.worktreePath, 'log', '-1', '--format=%s')).toBe('Merge main into track: Alpha');
    expect(readFileSync(join(t.worktreePath, 'PROJECT.md'), 'utf-8')).toContain('## Track: Alpha');
    expect(existsSync(join(t.worktreePath, 'project', 'alpha.md'))).toBe(true);
    expect(sessions.has(CALLER)).toBe(true);
    expect(announced).toEqual([repo]);
    expect(notified).toEqual([]);
  });

  it('lets the orchestrator update its child’s track, and refuses a track no session of its works in (403)', async () => {
    const t = await trackSession();
    await tracks.ensureTrackBranch({ cwd: repo }, 'Beta');
    commitFile(repo, 'src/main.ts', 'x\n', 'code on main');

    const denied = await update({ as: ORCHESTRATOR, track: 'Beta' });
    expect(denied.statusCode).toBe(403);
    expect(denied.json().error).toMatch(/it can update only those/);

    const res = await update({ as: ORCHESTRATOR, track: 'Alpha' });
    expect(res.statusCode).toBe(200);
    expect(res.json().mergeSha).toBe(git(t.worktreePath, 'rev-parse', 'HEAD'));
  });

  it('says so when already up to date, and announces nothing', async () => {
    const t = await trackSession();
    await tracks.updateTrackFromMain({ cwd: repo }, 'Alpha'); // takes in the move commit
    const head = git(t.worktreePath, 'rev-parse', 'HEAD');

    const res = await update();

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ mergeSha: null, detail: 'Already up to date with main' });
    expect(git(t.worktreePath, 'rev-parse', 'HEAD')).toBe(head);
    expect(announced).toEqual([]);
  });

  it('refuses uncommitted code and a conflict (409), naming the files and changing nothing', async () => {
    const t = await trackSession();
    writeFileSync(join(t.worktreePath, 'scratch.ts'), 'wip\n');
    const dirty = await update();
    expect(dirty.statusCode).toBe(409);
    expect(dirty.json().error).toContain('scratch.ts');
    rmSync(join(t.worktreePath, 'scratch.ts'));

    commitFile(t.worktreePath, 'shared.ts', 'track side\n', 'track edit');
    commitFile(repo, 'shared.ts', 'main side\n', 'main edit');
    const head = git(t.worktreePath, 'rev-parse', 'HEAD');
    const conflict = await update();
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json().error).toMatch(/conflicts in shared\.ts/);
    expect(git(t.worktreePath, 'rev-parse', 'HEAD')).toBe(head);
    expect(git(t.worktreePath, 'status', '--porcelain')).toBe('');
    expect(announced).toEqual([]);
  });

  it('refuses at once while another track operation holds the project (409)', async () => {
    await trackSession();
    const { withProjectLock } = await import('../src/server/projects/project-lock.js');
    await withProjectLock(repo, 'landing "Beta"', async () => {
      const res = await update();
      expect(res.statusCode).toBe(409);
      expect(res.json().error).toMatch(/busy \(landing "Beta"\)/);
    });
  });
});
