import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { makeTmpDataDir } from './helpers/tmp-data-dir.js';

/**
 * Which project an agent-started session lands in is decided by the caller's
 * cwd (docs/session-orchestration.md, "Start"). Against a real database and
 * registry: a track worktree maps back to its project, the deepest project
 * wins, and a folder above the cwd counts only when it holds a plan.
 */

const dataDir = makeTmpDataDir('agent-resolve');
const configPath = join(dataDir, 'config.json');
writeFileSync(configPath, JSON.stringify({ persistence: { dataDir } }));
process.env.CLAUDE_REMOTE_CONFIG = configPath;

const { loadConfig } = await import('../src/server/config.js');
const { initDatabase, closeDatabase, getDatabase } = await import('../src/server/db/schema.js');
const { pathKey } = await import('../src/server/sessions/project-discovery.js');
const { trackBranchContaining, listAllTrackBranches } = await import('../src/server/projects/track-store.js');
const { projectForCwd } = await import('../src/server/agent/sessions-api.js');

const root = join(dataDir, 'work');
const project = join(root, 'demo');
const worktree = join(dataDir, 'worktrees', 'tracks', 'abcd1234');
const bare = join(root, 'bare'); // registered, no PROJECT.md
const outer = join(root, 'outer'); // registered with a plan, holding a nested project
const inner = join(outer, 'packages', 'inner');

function register(cwds: string[]): void {
  writeFileSync(
    join(dataDir, 'projects.json'),
    JSON.stringify({ projects: cwds.map((cwd) => ({ cwd })), splitChildren: [], favorites: [] })
  );
}

function addBranch(id: string, opts: { worktreePath: string; trackName: string; landed?: boolean; createdAt?: string }): void {
  getDatabase()
    .prepare(
      `INSERT INTO track_branches
         (id, project_cwd, project_key, track_name, branch, worktree_path, base_branch, created_at, plan_in_branch, landed_at, merge_sha)
       VALUES (?, ?, ?, ?, ?, ?, 'main', ?, 1, ?, ?)`
    )
    .run(
      id,
      project,
      pathKey(project),
      opts.trackName,
      `track/${id}`,
      opts.worktreePath,
      opts.createdAt ?? '2026-10-01T10:00:00.000Z',
      opts.landed ? '2026-10-02T10:00:00.000Z' : null,
      opts.landed ? 'deadbeef' : null
    );
}

beforeAll(() => {
  for (const dir of [project, join(project, 'src'), join(worktree, 'src'), join(bare, 'sub'), join(inner, 'src')]) {
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(join(project, 'PROJECT.md'), '## Track: Split view\n');
  writeFileSync(join(outer, 'PROJECT.md'), '## Track: Outer\n');
  writeFileSync(join(inner, 'PROJECT.md'), '## Track: Inner\n');
  loadConfig();
  initDatabase();
});

afterAll(() => {
  closeDatabase();
  rmSync(dataDir, { recursive: true, force: true });
});

beforeEach(() => {
  getDatabase().prepare('DELETE FROM track_branches').run();
  register([project, bare, outer, inner]);
});

describe('projectForCwd', () => {
  it('resolves the main checkout, and a folder below it', () => {
    expect(projectForCwd(project)?.cwd).toBe(project);
    expect(projectForCwd(join(project, 'src'))?.cwd).toBe(project);
  });

  it('maps a track worktree, and a folder below it, back to its project', () => {
    addBranch('b1', { worktreePath: worktree, trackName: 'Split view' });
    expect(projectForCwd(worktree)?.cwd).toBe(project);
    expect(projectForCwd(join(worktree, 'src'))?.cwd).toBe(project);
  });

  it('picks the deepest project when one is nested in another', () => {
    expect(projectForCwd(join(inner, 'src'))?.cwd).toBe(inner);
    expect(projectForCwd(outer)?.cwd).toBe(outer);
  });

  it('accepts a registered project exactly, plan or not', () => {
    expect(projectForCwd(bare)?.cwd).toBe(bare);
  });

  it('does not take a plan-less folder above the cwd as its project', () => {
    expect(projectForCwd(join(bare, 'sub'))).toBeNull();
  });

  it('returns null for a cwd in no project', () => {
    expect(projectForCwd(join(dataDir, 'elsewhere'))).toBeNull();
  });
});

describe('trackBranchContaining', () => {
  it('finds the branch whose worktree holds the cwd', () => {
    addBranch('b1', { worktreePath: worktree, trackName: 'Split view' });
    expect(trackBranchContaining(join(worktree, 'src'))?.trackName).toBe('Split view');
    expect(trackBranchContaining(project)).toBeNull();
  });

  it('prefers an unlanded row over a landed one that recorded the same folder', () => {
    addBranch('old', { worktreePath: worktree, trackName: 'Landed name', landed: true, createdAt: '2026-10-03T00:00:00.000Z' });
    addBranch('new', { worktreePath: worktree, trackName: 'Reopened', createdAt: '2026-10-01T00:00:00.000Z' });
    expect(trackBranchContaining(worktree)?.trackName).toBe('Reopened');
  });

  it('resolves many cwds against one read of the table', () => {
    addBranch('b1', { worktreePath: worktree, trackName: 'Split view' });
    const branches = listAllTrackBranches();
    expect(trackBranchContaining(worktree, branches)?.id).toBe('b1');
    expect(trackBranchContaining(project, branches)).toBeNull();
  });
});
