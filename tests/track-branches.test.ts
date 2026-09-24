import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { execFileSync } from 'child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

/**
 * Track branches against a real repository and a real database.
 *
 * Everything that matters here is a property of git: that a track's worktree
 * is a separate checkout of its own branch, that a land merge leaves
 * PROJECT.md alone however both sides edited it, that a job merged into a
 * track never reaches main. A stub would prove none of it.
 */

const dataDir = mkdtempSync(join(tmpdir(), 'cr-tracks-data-'));
const configPath = join(dataDir, 'config.json');
writeFileSync(configPath, JSON.stringify({ persistence: { dataDir } }));
process.env.CLAUDE_REMOTE_CONFIG = configPath;

const { loadConfig } = await import('../src/server/config.js');
const { initDatabase, closeDatabase, getDatabase } = await import('../src/server/db/schema.js');
const tracks = await import('../src/server/projects/track-branches.js');
const { runMergeStage } = await import('../src/server/jobs/stages/merge.js');

const DOC = `## Track: Alpha
- [ ] \`f-aaaaaa\` First step → project/alpha.md
- [ ] \`f-bbbbbb\` Second step → project/alpha.md

## Track: Beta
- [ ] \`f-cccccc\` Unrelated
`;

let repo: string;

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

beforeEach(() => {
  getDatabase().exec('DELETE FROM track_branches');
  repo = mkdtempSync(join(tmpdir(), 'cr-tracks-repo-'));
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'config', 'user.email', 'test@example.com');
  git(repo, 'config', 'user.name', 'Test');
  git(repo, 'config', 'commit.gpgsign', 'false');
  writeFileSync(join(repo, 'PROJECT.md'), DOC);
  mkdirSync(join(repo, 'project'));
  writeFileSync(join(repo, 'project', 'alpha.md'), '# Alpha\n\nPlanned on main.\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-q', '-m', 'plan');
});

const project = () => ({ cwd: repo });

describe('ensureTrackBranch', () => {
  it('creates a branch and worktree on first use, and returns the same one after', async () => {
    const first = await tracks.ensureTrackBranch(project(), 'Alpha');
    expect(first.branch).toMatch(/^track\/alpha-[0-9a-f]{8}$/);
    expect(first.baseBranch).toBe('main');
    expect(first.worktreePath.startsWith(join(dataDir, 'worktrees', 'tracks'))).toBe(true);
    expect(git(first.worktreePath, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe(first.branch);

    const again = await tracks.ensureTrackBranch(project(), 'Alpha');
    expect(again.id).toBe(first.id);
  });

  it('settles two concurrent first uses on one branch, leaving no orphan', async () => {
    const [a, b] = await Promise.all([
      tracks.ensureTrackBranch(project(), 'Alpha'),
      tracks.ensureTrackBranch(project(), 'Alpha'),
    ]);
    expect(a.id).toBe(b.id);
    expect(tracks.listTrackBranches(repo)).toHaveLength(1);
    expect(git(repo, 'branch', '--list', 'track/*').split('\n').filter(Boolean)).toHaveLength(1);
  });

  it('adds the heading on main for a track that does not exist yet', async () => {
    await tracks.ensureTrackBranch(project(), 'Gamma');
    expect(readFileSync(join(repo, 'PROJECT.md'), 'utf-8')).toContain('## Track: Gamma');
  });

  it('re-attaches a worktree whose directory went missing, keeping its commits', async () => {
    const t = await tracks.ensureTrackBranch(project(), 'Alpha');
    commitFile(t.worktreePath, 'src/a.ts', 'export const a = 1;\n', 'work');
    rmSync(t.worktreePath, { recursive: true, force: true });
    git(repo, 'worktree', 'prune');

    const back = await tracks.ensureTrackBranch(project(), 'Alpha');
    expect(back.id).toBe(t.id);
    expect(existsSync(join(back.worktreePath, 'src', 'a.ts'))).toBe(true);
  });
});

describe('landTrack', () => {
  it('merges the code once, carries worktree ticks to main, and never merges PROJECT.md', async () => {
    const t = await tracks.ensureTrackBranch(project(), 'Alpha');

    // Implementation in the worktree: code, plus a tick in the worktree's copy.
    commitFile(t.worktreePath, 'src/a.ts', 'export const a = 1;\n', 'implement a');
    const wtDoc = readFileSync(join(t.worktreePath, 'PROJECT.md'), 'utf-8').replace(
      '- [ ] `f-aaaaaa`',
      '- [x] `f-aaaaaa`'
    );
    commitFile(t.worktreePath, 'PROJECT.md', wtDoc, 'tick in the worktree');

    // Meanwhile main's PROJECT.md moves on in a way that would conflict.
    const mainDoc = readFileSync(join(repo, 'PROJECT.md'), 'utf-8').replace(
      '- [ ] `f-aaaaaa` First step',
      '- [ ] `f-aaaaaa` First step, renamed on main'
    );
    commitFile(repo, 'PROJECT.md', mainDoc, 'rename on main');

    const result = await tracks.landTrack(project(), 'Alpha', []);

    expect(existsSync(join(repo, 'src', 'a.ts'))).toBe(true);
    expect(git(repo, 'log', '-1', '--format=%s', result.mergeSha)).toBe('Merge track: Alpha');
    expect(result.synced).toEqual(['f-aaaaaa']);

    const landedDoc = readFileSync(join(repo, 'PROJECT.md'), 'utf-8');
    expect(landedDoc).toContain('- [x] `f-aaaaaa` First step, renamed on main');
    expect(landedDoc).toContain('- [ ] `f-bbbbbb`');
    expect(git(repo, 'status', '--porcelain')).toBe('');

    expect(existsSync(t.worktreePath)).toBe(false);
    expect(git(repo, 'branch', '--list', t.branch)).toBe('');
    const [row] = tracks.listTrackBranches(repo);
    expect(row.landedAt).not.toBeNull();
    expect(row.mergeSha).toBe(result.mergeSha);
  });

  it('keeps the landed row and starts a new one when the track is reopened', async () => {
    await tracks.ensureTrackBranch(project(), 'Alpha');
    await tracks.landTrack(project(), 'Alpha', []);
    const reopened = await tracks.ensureTrackBranch(project(), 'Alpha');

    const rows = tracks.listTrackBranches(repo);
    expect(rows).toHaveLength(2);
    expect(rows[1].id).toBe(reopened.id);
    expect(rows[1].landedAt).toBeNull();
  });

  it('refuses while the worktree has uncommitted changes', async () => {
    const t = await tracks.ensureTrackBranch(project(), 'Alpha');
    writeFileSync(join(t.worktreePath, 'scratch.ts'), 'wip\n');
    await expect(tracks.landTrack(project(), 'Alpha', [])).rejects.toMatchObject({ status: 409 });
    expect(existsSync(t.worktreePath)).toBe(true);
  });

  it('refuses while a session is open inside the worktree', async () => {
    const t = await tracks.ensureTrackBranch(project(), 'Alpha');
    await expect(
      tracks.landTrack(project(), 'Alpha', [join(t.worktreePath, 'src')])
    ).rejects.toMatchObject({ status: 409 });
  });

  it('refuses when the project is not on the branch the track came from', async () => {
    await tracks.ensureTrackBranch(project(), 'Alpha');
    git(repo, 'checkout', '-q', '-b', 'elsewhere');
    await expect(tracks.landTrack(project(), 'Alpha', [])).rejects.toMatchObject({ status: 409 });
  });
});

describe('merge stage into a track', () => {
  it('merges a job branch into the track worktree, records the sha, and leaves main alone', async () => {
    const t = await tracks.ensureTrackBranch(project(), 'Alpha');
    const mainBefore = git(repo, 'rev-parse', 'main');

    const jobWt = join(dataDir, 'worktrees', 'job-1');
    git(repo, 'worktree', 'add', '-q', '-b', 'job/first-step', jobWt, t.branch);
    commitFile(jobWt, 'src/b.ts', 'export const b = 2;\n', 'job work');

    const result = await runMergeStage({
      projectCwd: repo,
      branch: 'job/first-step',
      baseBranch: t.branch,
      title: 'First step',
      mergeCwd: t.worktreePath,
    });

    expect(result.merged).toBe(true);
    expect(result.pushed).toBe(false);
    expect(result.pushSkippedReason).toBe('track-branch');
    expect(result.mergeSha).toBe(git(t.worktreePath, 'rev-parse', 'HEAD'));
    expect(existsSync(join(t.worktreePath, 'src', 'b.ts'))).toBe(true);
    expect(git(repo, 'rev-parse', 'main')).toBe(mainBefore);
  });

  it('refuses when the track worktree is dirty, naming the worktree', async () => {
    const t = await tracks.ensureTrackBranch(project(), 'Alpha');
    writeFileSync(join(t.worktreePath, 'scratch.ts'), 'wip\n');
    await expect(
      runMergeStage({
        projectCwd: repo,
        branch: t.branch,
        baseBranch: t.branch,
        title: 'x',
        mergeCwd: t.worktreePath,
      })
    ).rejects.toThrow(t.worktreePath);
  });
});

describe('readSpecForTrack', () => {
  it('prefers the track worktree copy of a spec, and refuses paths outside it', async () => {
    const t = await tracks.ensureTrackBranch(project(), 'Alpha');
    writeFileSync(join(t.worktreePath, 'project', 'alpha.md'), '# Alpha\n\nRevised in the track.\n');

    expect(tracks.readSpecForTrack(project(), 'Alpha', 'project/alpha.md')).toContain(
      'Revised in the track'
    );
    expect(tracks.readSpecForTrack(project(), 'Beta', 'project/alpha.md')).toBeNull();
    expect(tracks.readSpecForTrack(project(), 'Alpha', '../outside.md')).toBeNull();
  });
});
