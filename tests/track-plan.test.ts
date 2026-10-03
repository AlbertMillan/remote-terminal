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
 * A track's plan lives in its branch while it is in progress
 * (project/track-plan-in-branch.md), against a real repository and database.
 *
 * What has to hold is mostly a property of git: the commit that takes the
 * section off main holds nothing the user staged, main's working copy keeps
 * its other uncommitted edits, and Land puts the section back without ever
 * merging PROJECT.md.
 */

const dataDir = mkdtempSync(join(tmpdir(), 'cr-plan-data-'));
const configPath = join(dataDir, 'config.json');
writeFileSync(configPath, JSON.stringify({ persistence: { dataDir } }));
process.env.CLAUDE_REMOTE_CONFIG = configPath;

const { loadConfig } = await import('../src/server/config.js');
const { initDatabase, closeDatabase, getDatabase } = await import('../src/server/db/schema.js');
const tracks = await import('../src/server/projects/track-branches.js');
/** Land with no running sessions anywhere. */
const NO_SESSIONS = { sessions: [], terminateSession: async () => true };
const { getRegistryPath } = await import('../src/server/projects/registry.js');
const { getWorkspaceBoard } = await import('../src/server/projects/workspace.js');
const { registerProjectRoutes } = await import('../src/server/projects/routes.js');
const { runRebuildStage } = await import('../src/server/jobs/stages/rebuild.js');
const { planTrackDelete, executeTrackDelete } = await import('../src/server/projects/track-delete.js');
const { pathKey } = await import('../src/server/sessions/project-discovery.js');
const { withProjectLock } = await import('../src/server/projects/project-lock.js');
const { sessionManager } = await import('../src/server/sessions/manager.js');

const DOC = `## Track: Alpha
- [ ] \`f-aaaaaa\` First step → project/alpha.md
- [ ] \`f-bbbbbb\` Second step → project/shared.md

## Track: Beta
- [ ] \`f-cccccc\` Unrelated → project/shared.md
`;

let repo: string;
const project = () => ({ cwd: repo });

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8' }).trim();
}

function write(cwd: string, rel: string, content: string): void {
  mkdirSync(join(cwd, rel, '..'), { recursive: true });
  writeFileSync(join(cwd, rel), content);
}

function commitFile(cwd: string, rel: string, content: string, message: string): void {
  write(cwd, rel, content);
  git(cwd, 'add', '--', rel);
  git(cwd, 'commit', '-q', '-m', message);
}

const read = (cwd: string, rel = 'PROJECT.md') => readFileSync(join(cwd, rel), 'utf-8');

beforeAll(() => {
  loadConfig();
  initDatabase();
});

afterAll(() => {
  closeDatabase();
  rmSync(dataDir, { recursive: true, force: true });
});

beforeEach(() => {
  getDatabase().exec('DELETE FROM track_branches');
  repo = mkdtempSync(join(tmpdir(), 'cr-plan-repo-'));
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'config', 'user.email', 'test@example.com');
  git(repo, 'config', 'user.name', 'Test');
  git(repo, 'config', 'commit.gpgsign', 'false');
  write(repo, 'PROJECT.md', DOC);
  write(repo, 'project/alpha.md', '# Alpha\n');
  write(repo, 'project/shared.md', '# Shared\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-q', '-m', 'plan');
});

describe('branch creation', () => {
  it('leaves main clean, with one commit that removes the section and its own spec', async () => {
    const before = git(repo, 'rev-parse', 'HEAD');
    const t = await tracks.ensureTrackBranch(project(), 'Alpha');

    expect(git(repo, 'status', '--porcelain')).toBe('');
    expect(git(repo, 'rev-parse', 'HEAD~1')).toBe(before);
    expect(git(repo, 'log', '-1', '--format=%s')).toBe('Move "Alpha" plan into its track branch');
    expect(read(repo)).not.toContain('## Track: Alpha');
    expect(read(repo)).toContain('`f-cccccc`');
    expect(existsSync(join(repo, 'project', 'alpha.md'))).toBe(false);
    // Shared with Beta: stays on main, and the track has it too.
    expect(existsSync(join(repo, 'project', 'shared.md'))).toBe(true);
    expect(existsSync(join(t.worktreePath, 'project', 'shared.md'))).toBe(true);

    expect(read(t.worktreePath)).toContain('`f-aaaaaa` First step');
    expect(existsSync(join(t.worktreePath, 'project', 'alpha.md'))).toBe(true);
  });

  it('keeps a staged unrelated file staged and out of the commit', async () => {
    write(repo, 'staged.ts', 'export {};\n');
    git(repo, 'add', 'staged.ts');
    await tracks.ensureTrackBranch(project(), 'Alpha');

    expect(git(repo, 'show', '--name-only', '--format=', 'HEAD').split('\n')).not.toContain('staged.ts');
    expect(git(repo, 'status', '--porcelain')).toBe('A  staged.ts');
  });

  it('carries uncommitted lines and specs into the worktree, and keeps other uncommitted edits on main', async () => {
    const edited = read(repo)
      .replace('`f-cccccc` Unrelated', '`f-cccccc` Unrelated, edited on main')
      .replace(
        '- [ ] `f-bbbbbb` Second step → project/shared.md',
        '- [ ] `f-bbbbbb` Second step → project/shared.md\n- [ ] `f-dddddd` Written but not committed → project/draft.md'
      );
    write(repo, 'PROJECT.md', edited);
    write(repo, 'project/draft.md', '# Draft\n');

    const t = await tracks.ensureTrackBranch(project(), 'Alpha');

    expect(read(t.worktreePath)).toContain('`f-dddddd` Written but not committed');
    expect(read(t.worktreePath, 'project/draft.md')).toBe('# Draft\n');
    expect(git(t.worktreePath, 'status', '--porcelain')).toBe('');
    expect(existsSync(join(repo, 'project', 'draft.md'))).toBe(false);
    // The Beta edit is still uncommitted on main, and is all that is.
    expect(read(repo)).toContain('Unrelated, edited on main');
    expect(read(repo)).not.toContain('## Track: Alpha');
    expect(git(repo, 'status', '--porcelain')).toBe('M PROJECT.md');
    expect(git(repo, 'show', 'HEAD:PROJECT.md')).not.toContain('edited on main');
  });
});

describe('ids', () => {
  afterEach(() => vi.restoreAllMocks());

  it('never hands out an id that exists only in a worktree', async () => {
    const t = await tracks.ensureTrackBranch(project(), 'Alpha');
    write(t.worktreePath, 'PROJECT.md', read(t.worktreePath).replace('`f-aaaaaa`', '`f-zzzzzz`'));
    const plan = tracks.readProjectPlan(project());
    expect(tracks.allFeatureIds(plan).has('f-zzzzzz')).toBe(true);

    // Six "z" draws, then six "y" draws: the first candidate is taken.
    const draws = [...Array(6).fill(25.5 / 36), ...Array(6).fill(24.5 / 36)];
    vi.spyOn(Math, 'random').mockImplementation(() => draws.shift() ?? 0);
    const { addFeature } = await import('../src/server/projects/project-doc-format.js');
    const main = plan.main.doc;
    expect(addFeature(main, { title: 'New', track: 'Beta' }, tracks.allFeatureIds(plan)).id).toBe('f-yyyyyy');
  });
});

describe('board', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    writeFileSync(getRegistryPath(), JSON.stringify({ projects: [{ cwd: repo }] }));
    app = Fastify();
    registerProjectRoutes(app);
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    rmSync(getRegistryPath(), { force: true });
  });

  const boardProject = () => getWorkspaceBoard().find((p) => pathKey(p.cwd) === pathKey(repo));

  it('reads a branched track from its worktree and writes its ticks there, under that file’s revision', async () => {
    const t = await tracks.ensureTrackBranch(project(), 'Alpha');
    const before = boardProject();
    const alpha = before?.tracks.find((x) => x.name === 'Alpha');
    expect(alpha?.features.map((f) => f.id)).toEqual(['f-aaaaaa', 'f-bbbbbb']);
    expect(alpha?.revision).toBeTruthy();
    const mainDoc = read(repo);

    const stale = await app.inject({
      method: 'PATCH',
      url: '/api/projects/feature',
      payload: { cwd: repo, revision: before?.revision, id: 'f-aaaaaa', status: 'done' },
    });
    expect(stale.statusCode).toBe(409);

    const ok = await app.inject({
      method: 'PATCH',
      url: '/api/projects/feature',
      payload: { cwd: repo, revision: alpha?.revision, id: 'f-aaaaaa', status: 'done' },
    });
    expect(ok.statusCode).toBe(200);
    expect(read(t.worktreePath)).toContain('- [x] `f-aaaaaa`');
    expect(read(repo)).toBe(mainDoc);
    expect(boardProject()?.revision).toBe(before?.revision);

    // A Beta write still uses main's revision, which the tick left alone.
    const beta = await app.inject({
      method: 'PATCH',
      url: '/api/projects/feature',
      payload: { cwd: repo, revision: before?.revision, id: 'f-cccccc', status: 'in_progress' },
    });
    expect(beta.statusCode).toBe(200);
  });

  /**
   * The session manager as the routes see it: one session in the worktree
   * whose shell exited, one still running there, one on main. Only the
   * running one in the worktree counts, and only it is closed.
   */
  function fakeSessions(worktreePath: string) {
    const all = [
      { id: 'exited', cwd: worktreePath, status: 'terminated' },
      { id: 'running', cwd: join(worktreePath, 'src'), status: 'active' },
      { id: 'main', cwd: repo, status: 'active' },
    ];
    vi.spyOn(sessionManager, 'getAllSessions').mockReturnValue(all as never);
    return vi.spyOn(sessionManager, 'terminateSession').mockResolvedValue(true);
  }

  it('routes count and close only running sessions in the worktree (an exited shell does not block)', async () => {
    const t = await tracks.ensureTrackBranch(project(), 'Alpha');
    const terminate = fakeSessions(t.worktreePath);
    try {
      const planRes = await app.inject({
        method: 'GET',
        url: `/api/projects/track/delete-plan?cwd=${encodeURIComponent(repo)}&track=Alpha`,
      });
      expect(planRes.statusCode).toBe(200);
      expect(planRes.json().plan.branch.sessionsToClose).toBe(1);

      const boardRes = await app.inject({ method: 'GET', url: '/api/projects' });
      const p = (boardRes.json().projects as { cwd: string; tracks: { name: string; openSessions: number }[] }[]).find(
        (x) => pathKey(x.cwd) === pathKey(repo)
      );
      expect(p?.tracks.find((x) => x.name === 'Alpha')?.openSessions).toBe(1);

      const land = await app.inject({
        method: 'POST',
        url: '/api/projects/track/land',
        payload: { cwd: repo, track: 'Alpha' },
      });
      expect(land.statusCode).toBe(200);
      expect(terminate.mock.calls.map((c) => c[0])).toEqual(['running']);
      expect(existsSync(t.worktreePath)).toBe(false);
    } finally {
      vi.restoreAllMocks();
    }
  });

  it('counts the running sessions inside a branched track’s worktree, for the Land confirm', async () => {
    const t = await tracks.ensureTrackBranch(project(), 'Alpha');
    const board = getWorkspaceBoard({
      runningSessions: [{ cwd: t.worktreePath }, { cwd: join(t.worktreePath, 'src') }, { cwd: repo }],
    });
    const p = board.find((x) => pathKey(x.cwd) === pathKey(repo));
    expect(p?.tracks.find((x) => x.name === 'Alpha')?.openSessions).toBe(2);
    expect(p?.tracks.find((x) => x.name === 'Beta')?.openSessions).toBe(0);
  });

  it('shows one copy with a badge when main also has lines, and Move into branch takes them over', async () => {
    const t = await tracks.ensureTrackBranch(project(), 'Alpha');
    // A session on main writes a line for the in-progress track.
    write(repo, 'PROJECT.md', `${read(repo)}\n## Track: Alpha\n- [ ] \`f-eeeeee\` Added on main later\n`);

    const alpha = boardProject()?.tracks.filter((x) => x.name === 'Alpha');
    expect(alpha).toHaveLength(1);
    expect(alpha?.[0].features.map((f) => f.id)).toEqual(['f-aaaaaa', 'f-bbbbbb']);
    expect(alpha?.[0].alsoOnMain).toBe(1);

    const res = await app.inject({
      method: 'POST',
      url: '/api/projects/track/move-into-branch',
      payload: { cwd: repo, track: 'Alpha' },
    });
    expect(res.statusCode).toBe(200);
    expect(read(t.worktreePath)).toContain('`f-eeeeee` Added on main later');
    expect(read(repo)).not.toContain('## Track: Alpha');
    expect(boardProject()?.tracks.find((x) => x.name === 'Alpha')?.alsoOnMain).toBe(0);
  });
});

describe('land', () => {
  it('commits uncommitted planning in the worktree and goes through', async () => {
    const t = await tracks.ensureTrackBranch(project(), 'Alpha');
    write(t.worktreePath, 'PROJECT.md', read(t.worktreePath).replace('- [ ] `f-aaaaaa`', '- [x] `f-aaaaaa`'));
    write(t.worktreePath, 'project/alpha.md', '# Alpha\n\nRevised in the track.\n');

    await tracks.landTrack(project(), 'Alpha', NO_SESSIONS);
    expect(read(repo)).toContain('- [x] `f-aaaaaa`');
    expect(read(repo, 'project/alpha.md')).toContain('Revised in the track');
    expect(git(repo, 'status', '--porcelain')).toBe('');
  });

  it('refuses uncommitted code on main, naming it', async () => {
    await tracks.ensureTrackBranch(project(), 'Alpha');
    write(repo, 'src/stray.ts', 'export {};\n');
    await expect(tracks.landTrack(project(), 'Alpha', NO_SESSIONS)).rejects.toMatchObject({
      status: 409,
      message: expect.stringContaining('src/stray.ts'),
    });
  });

  it('lets uncommitted backlog planning on main through, untouched and unpushed', async () => {
    const remote = mkdtempSync(join(tmpdir(), 'cr-plan-remote-'));
    git(remote, 'init', '-q', '--bare');
    git(repo, 'remote', 'add', 'origin', remote);
    git(repo, 'push', '-q', '-u', 'origin', 'main');

    const t = await tracks.ensureTrackBranch(project(), 'Alpha');
    commitFile(t.worktreePath, 'src/a.ts', 'export const a = 1;\n', 'work');
    write(repo, 'PROJECT.md', read(repo).replace('`f-cccccc` Unrelated', '`f-cccccc` Unrelated, a backlog edit'));
    write(repo, 'project/backlog.md', '# Backlog idea\n');

    const result = await tracks.landTrack(project(), 'Alpha', NO_SESSIONS);
    expect(result.pushed).toBe(true);

    expect(read(repo)).toContain('a backlog edit');
    expect(read(repo)).toContain('`f-aaaaaa`');
    expect(read(repo, 'project/backlog.md')).toBe('# Backlog idea\n');
    expect(git(repo, 'status', '--porcelain', '--untracked-files=all').split('\n').map((l) => l.trim()).sort()).toEqual([
      '?? project/backlog.md',
      'M PROJECT.md',
    ]);
    expect(git(repo, 'diff', '--cached', '--name-only')).toBe(''); // modified, not staged
    const pushed = git(remote, 'show', 'main:PROJECT.md');
    expect(pushed).toContain('`f-aaaaaa`');
    expect(pushed).not.toContain('a backlog edit');
    rmSync(remote, { recursive: true, force: true });
  });

  it('keeps a line written on main for the track after it branched', async () => {
    const t = await tracks.ensureTrackBranch(project(), 'Alpha');
    write(t.worktreePath, 'PROJECT.md', read(t.worktreePath).replace('- [ ] `f-bbbbbb`', '- [x] `f-bbbbbb`'));
    commitFile(repo, 'PROJECT.md', `${read(repo)}\n## Track: Alpha\n- [ ] \`f-eeeeee\` Added on main\n`, 'main line');

    await tracks.landTrack(project(), 'Alpha', NO_SESSIONS);
    const landed = read(repo);
    expect(landed.match(/## Track: Alpha/g)).toHaveLength(1);
    expect(landed).toContain('- [x] `f-bbbbbb`');
    expect(landed).toContain('`f-eeeeee` Added on main');
  });
});

describe('rebuild', () => {
  it('ticks the worktree copy for a job merged into a track branch, and commits it there', async () => {
    const t = await tracks.ensureTrackBranch(project(), 'Alpha');
    const mainHead = git(repo, 'rev-parse', 'HEAD');

    const result = await runRebuildStage({
      project: project(),
      featureId: 'f-aaaaaa',
      specPath: null,
      title: 'First step',
      baseBranch: t.branch,
    });
    expect(result).toMatchObject({ updated: true, committed: true, pushed: false });
    expect(git(t.worktreePath, 'show', 'HEAD:PROJECT.md')).toContain('- [x] `f-aaaaaa`');
    expect(git(repo, 'rev-parse', 'HEAD')).toBe(mainHead);
  });
});

describe('delete', () => {
  const deps = () => ({
    liveSessions: () => [] as { id: string; cwd: string }[],
    terminateSession: vi.fn(async () => true),
    cancelJob: vi.fn(async () => undefined),
    discardJob: vi.fn(async () => undefined),
  });

  it('leaves main untouched for an in-progress track', async () => {
    const t = await tracks.ensureTrackBranch(project(), 'Alpha');
    const head = git(repo, 'rev-parse', 'HEAD');
    const doc = read(repo);

    const plan = await planTrackDelete(project(), 'Alpha', []);
    expect(plan.features.map((f) => f.id)).toEqual(['f-aaaaaa', 'f-bbbbbb']);
    expect(plan.inDoc).toBe(false);
    await executeTrackDelete(project(), 'Alpha', { token: plan.token, revert: [], deleteSpecs: [] }, deps());

    expect(existsSync(t.worktreePath)).toBe(false);
    expect(git(repo, 'rev-parse', 'HEAD')).toBe(head);
    expect(read(repo)).toBe(doc);
    expect(existsSync(join(repo, 'project', 'shared.md'))).toBe(true);
  });

  it('removes the lines a "both copies" track has on main', async () => {
    await tracks.ensureTrackBranch(project(), 'Alpha');
    write(repo, 'PROJECT.md', `${read(repo)}\n## Track: Alpha\n- [ ] \`f-eeeeee\` Added on main\n`);

    const plan = await planTrackDelete(project(), 'Alpha', []);
    expect(plan.inDoc).toBe(true);
    expect(plan.mainLines).toBe(1);
    await executeTrackDelete(project(), 'Alpha', { token: plan.token, revert: [], deleteSpecs: [] }, deps());
    expect(read(repo)).not.toContain('## Track: Alpha');
    expect(read(repo)).toContain('`f-cccccc`');
  });
});

describe('migration', () => {
  /** A row as it was before plans moved into branches: the section still on main. */
  const asOldRow = async () => {
    const t = await tracks.ensureTrackBranch(project(), 'Alpha');
    getDatabase().prepare('UPDATE track_branches SET plan_in_branch = 0 WHERE id = ?').run(t.id);
    git(repo, 'reset', '-q', '--hard', 'HEAD~1'); // undo the move: the section is back on main
    return t;
  };
  const flag = (id: string) =>
    (getDatabase().prepare('SELECT plan_in_branch FROM track_branches WHERE id = ?').get(id) as {
      plan_in_branch: number;
    }).plan_in_branch;

  it('moves the section of a track branched before plans moved, keeping the worktree’s ticks', async () => {
    const t = await asOldRow();
    // The old model: ticks made only in the worktree, titles edited on main.
    commitFile(
      t.worktreePath,
      'PROJECT.md',
      read(t.worktreePath).replace('- [ ] `f-aaaaaa`', '- [x] `f-aaaaaa`'),
      'tick in the worktree'
    );
    commitFile(repo, 'PROJECT.md', read(repo).replace('First step', 'First step, renamed on main'), 'rename');

    await tracks.migrateBranchedPlans();

    expect(read(repo)).not.toContain('## Track: Alpha');
    expect(git(repo, 'status', '--porcelain')).toBe('');
    expect(read(t.worktreePath)).toContain('- [x] `f-aaaaaa` First step, renamed on main');
    expect(flag(t.id)).toBe(1);
  });

  it('moves a track only once, so a later line on main never wins over the worktree', async () => {
    const t = await asOldRow();
    await tracks.migrateBranchedPlans();
    // In the worktree, where the plan now lives: a title edit.
    write(t.worktreePath, 'PROJECT.md', read(t.worktreePath).replace('First step', 'First step, edited in the track'));
    // A session on main writes a stale copy of the section again.
    write(repo, 'PROJECT.md', `${read(repo)}\n## Track: Alpha\n- [ ] \`f-aaaaaa\` First step → project/alpha.md\n`);

    await tracks.migrateBranchedPlans(); // the next restart

    expect(read(t.worktreePath)).toContain('First step, edited in the track');
    expect(read(repo)).toContain('## Track: Alpha'); // left for Move into branch / Land
  });

  it('leaves a track branched under the current model alone', async () => {
    const t = await tracks.ensureTrackBranch(project(), 'Alpha');
    expect(flag(t.id)).toBe(1);
    write(repo, 'PROJECT.md', `${read(repo)}\n## Track: Alpha\n- [ ] \`f-eeeeee\` Added on main\n`);
    const worktreeDoc = read(t.worktreePath);

    await tracks.migrateBranchedPlans();

    expect(read(t.worktreePath)).toBe(worktreeDoc);
    expect(read(repo)).toContain('`f-eeeeee` Added on main');
  });
});

describe('review fixes', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    writeFileSync(getRegistryPath(), JSON.stringify({ projects: [{ cwd: repo }] }));
    app = Fastify();
    registerProjectRoutes(app);
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    rmSync(getRegistryPath(), { force: true });
  });

  const boardProject = () => getWorkspaceBoard().find((p) => pathKey(p.cwd) === pathKey(repo));
  const alphaOnMain = (lines: string) => write(repo, 'PROJECT.md', `${read(repo)}\n## Track: Alpha\n${lines}`);

  it('Move into branch keeps a spec on main whose copy differs from the track’s', async () => {
    const t = await tracks.ensureTrackBranch(project(), 'Alpha');
    commitFile(t.worktreePath, 'project/alpha.md', '# Alpha\n\nRevised in the track.\n', 'revise');
    // Main's own version: untracked, since the move took the file off main.
    write(repo, 'project/alpha.md', '# Alpha\n\nMain’s own notes.\n');
    alphaOnMain('- [ ] `f-eeeeee` Added on main → project/alpha.md\n');

    const moved = await tracks.moveIntoBranch(project(), 'Alpha');
    expect(moved.specsKept).toEqual(['project/alpha.md']);
    expect(moved.specsRemoved).toEqual([]);
    expect(read(repo, 'project/alpha.md')).toContain('Main’s own notes');
    expect(read(t.worktreePath, 'project/alpha.md')).toContain('Revised in the track');
    expect(read(t.worktreePath)).toContain('`f-eeeeee` Added on main');
  });

  it('refuses a write to a branched track’s file while the project is locked, but not main’s', async () => {
    await tracks.ensureTrackBranch(project(), 'Alpha');
    const before = boardProject();
    const alphaRev = before?.tracks.find((x) => x.name === 'Alpha')?.revision;
    let release: () => void = () => {};
    const held = withProjectLock(repo, 'landing "Alpha"', () => new Promise<void>((r) => (release = r)));
    try {
      const busy = await app.inject({
        method: 'PATCH',
        url: '/api/projects/feature',
        payload: { cwd: repo, revision: alphaRev, id: 'f-aaaaaa', status: 'done' },
      });
      expect(busy.statusCode).toBe(409);
      expect(busy.json()).toMatchObject({ error: expect.stringContaining('landing "Alpha"') });
      // Not a stale revision, so the client shows the reason instead.
      expect(busy.json().conflict).toBeUndefined();

      const mainWrite = await app.inject({
        method: 'PATCH',
        url: '/api/projects/feature',
        payload: { cwd: repo, revision: before?.revision, id: 'f-cccccc', status: 'done' },
      });
      expect(mainWrite.statusCode).toBe(200);
    } finally {
      release();
      await held;
    }
  });

  it('counts only the lines main has that the worktree lacks', async () => {
    await tracks.ensureTrackBranch(project(), 'Alpha');
    alphaOnMain('- [ ] `f-aaaaaa` First step → project/alpha.md\n- [ ] `f-eeeeee` Added on main\n');
    expect(boardProject()?.tracks.find((x) => x.name === 'Alpha')?.alsoOnMain).toBe(1);
  });

  it('says the worktree folder is missing, rather than that its section is', async () => {
    const t = await tracks.ensureTrackBranch(project(), 'Alpha');
    rmSync(t.worktreePath, { recursive: true, force: true });
    // Main has no heading either, so it is listed as an orphan branch.
    expect(boardProject()?.tracks.find((x) => x.name === 'Alpha')).toBeUndefined();
    alphaOnMain('- [ ] `f-eeeeee` Added on main\n');
    expect(boardProject()?.tracks.find((x) => x.name === 'Alpha')).toMatchObject({
      planMissing: true,
      worktreeMissing: true,
    });
  });
});

describe('land rollback', () => {
  it('leaves uncommitted backlog planning on main exactly as it was when the merge conflicts', async () => {
    commitFile(repo, 'shared.ts', 'one\n', 'shared');
    const t = await tracks.ensureTrackBranch(project(), 'Alpha');
    commitFile(t.worktreePath, 'shared.ts', 'track side\n', 'track edit');
    commitFile(repo, 'shared.ts', 'main side\n', 'main edit');
    const head = git(repo, 'rev-parse', 'HEAD');
    write(repo, 'PROJECT.md', read(repo).replace('`f-cccccc` Unrelated', '`f-cccccc` Unrelated, a backlog edit'));
    write(repo, 'project/backlog.md', '# Backlog idea\n');
    const docBefore = readFileSync(join(repo, 'PROJECT.md'));

    await expect(tracks.landTrack(project(), 'Alpha', NO_SESSIONS)).rejects.toMatchObject({ status: 409 });

    expect(git(repo, 'rev-parse', 'HEAD')).toBe(head);
    expect(readFileSync(join(repo, 'PROJECT.md')).equals(docBefore)).toBe(true);
    expect(read(repo, 'project/backlog.md')).toBe('# Backlog idea\n');
    // The spec Land put back for the merge came back off again.
    expect(existsSync(join(repo, 'project', 'alpha.md'))).toBe(false);
    expect(git(repo, 'diff', '--cached', '--name-only')).toBe('');
    const status = git(repo, 'status', '--porcelain', '--untracked-files=all');
    expect(status.split('\n').map((l) => l.trim()).sort()).toEqual(['?? project/backlog.md', 'M PROJECT.md']);
    expect(tracks.getActiveTrackBranch(repo, 'Alpha')).not.toBeNull();
  });

  it('refuses while anything is staged on main, naming it — the rollback relies on that', async () => {
    await tracks.ensureTrackBranch(project(), 'Alpha');
    write(repo, 'PROJECT.md', read(repo).replace('Unrelated', 'Unrelated, staged'));
    git(repo, 'add', 'PROJECT.md');
    await expect(tracks.landTrack(project(), 'Alpha', NO_SESSIONS)).rejects.toMatchObject({
      status: 409,
      message: expect.stringContaining('staged on main: PROJECT.md'),
    });
    expect(git(repo, 'diff', '--cached', '--name-only')).toBe('PROJECT.md');
  });
});
