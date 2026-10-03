import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { execFileSync, spawn } from 'child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

// Real repositories: every git spawn costs ~50-100ms on Windows, and the
// suites run in parallel, so the 5s default is too tight under load.
vi.setConfig({ testTimeout: 30_000 });

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

  it('adds the heading in the worktree, never on main, for a track that does not exist yet', async () => {
    const t = await tracks.ensureTrackBranch(project(), 'Gamma');
    expect(readFileSync(join(t.worktreePath, 'PROJECT.md'), 'utf-8')).toContain('## Track: Gamma');
    expect(readFileSync(join(repo, 'PROJECT.md'), 'utf-8')).not.toContain('## Track: Gamma');
    expect(git(repo, 'status', '--porcelain')).toBe('');
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

describe('worktree creation', () => {
  // Git on Windows (2.39) refuses a worktree whose own path passes about 210
  // characters, whatever core.longpaths says.
  it.skipIf(process.platform !== 'win32')(
    'leaves no branch and no folder behind when git refuses the worktree, and says why',
    async () => {
      const { createWorktree } = await import('../src/server/jobs/worktree.js');
      const parent = mkdtempSync(join(tmpdir(), 'cr-deep-'));
      const deep = join(parent, 'd'.repeat(230 - parent.length - 38));
      const path = join(deep, '0123456789abcdef-0123-4567-89ab-0123456789ab');
      try {
        await expect(createWorktree(repo, 'job-deep', 'Deep', { path, branch: 'job/deep' })).rejects.toThrow(
          /too long for git on Windows/
        );
        expect(git(repo, 'branch', '--list', 'job/deep')).toBe('');
        expect(existsSync(path)).toBe(false);
        expect(git(repo, 'worktree', 'list').split('\n')).toHaveLength(1);
      } finally {
        rmSync(parent, { recursive: true, force: true });
      }
    }
  );

  it('keeps an existing branch when attaching to it fails', async () => {
    const { createWorktree } = await import('../src/server/jobs/worktree.js');
    git(repo, 'branch', 'job/kept');
    // The branch is checked out here already, so a second worktree of it fails.
    git(repo, 'checkout', '-q', 'job/kept');
    const path = join(dataDir, 'worktrees', 'kept');
    await expect(createWorktree(repo, 'job-kept', 'Kept', { path, branch: 'job/kept' })).rejects.toThrow();
    expect(git(repo, 'branch', '--list', 'job/kept')).toContain('job/kept');
    expect(existsSync(path)).toBe(false);
  });

  it.skipIf(process.platform !== 'win32')(
    'still deletes the branch when a process holds the folder, and the sweep takes the leftover',
    async () => {
      const { createWorktree, removeWorktree, sweepLeftoverWorktrees } = await import(
        '../src/server/jobs/worktree.js'
      );
      const path = join(dataDir, 'worktrees', 'held');
      await createWorktree(repo, 'job-held', 'Held', { path, branch: 'job/held' });
      // What a session-log run does: a process whose cwd is the worktree.
      const holder = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 20000)'], { cwd: path });
      await new Promise((r) => setTimeout(r, 300));
      try {
        const torn = await removeWorktree(repo, 'job-held', { path, deleteBranch: 'job/held' });
        expect(torn).toEqual({ removed: false, branchDeleted: true, linksLeft: [] });
        expect(git(repo, 'branch', '--list', 'job/held')).toBe('');
        expect(git(repo, 'worktree', 'list').split('\n')).toHaveLength(1);
      } finally {
        holder.kill();
        await new Promise((r) => holder.once('exit', r));
      }
      writeFileSync(join(path, 'SESSION-LOG.md'), 'written after the teardown\n');
      const kept = join(dataDir, 'worktrees', 'not-a-stub');
      mkdirSync(kept, { recursive: true });
      writeFileSync(join(kept, 'notes.txt'), 'someone’s work\n');

      expect(sweepLeftoverWorktrees('SESSION-LOG.md')).toEqual([path]);
      expect(existsSync(path)).toBe(false);
      expect(existsSync(kept)).toBe(true);
      rmSync(kept, { recursive: true, force: true });
    }
  );

  it('names a track worktree by 8 characters of its id, leaving room under the limit', async () => {
    const t = await tracks.ensureTrackBranch(project(), 'Alpha');
    expect(t.worktreePath).toBe(join(dataDir, 'worktrees', 'tracks', t.id.slice(0, 8)));
    expect(git(t.worktreePath, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe(t.branch);
  });
});

describe('landTrack', () => {
  it('merges the code once, puts the section back on main, and never merges PROJECT.md', async () => {
    const t = await tracks.ensureTrackBranch(project(), 'Alpha');

    // Implementation in the worktree: code, plus edits to the worktree's copy.
    commitFile(t.worktreePath, 'src/a.ts', 'export const a = 1;\n', 'implement a');
    const wtDoc = readFileSync(join(t.worktreePath, 'PROJECT.md'), 'utf-8')
      .replace('- [ ] `f-aaaaaa` First step', '- [x] `f-aaaaaa` First step, renamed in the track')
      .replace('- [ ] `f-cccccc`', '- [x] `f-cccccc`'); // Beta's stale copy: must not reach main
    commitFile(t.worktreePath, 'PROJECT.md', wtDoc, 'tick in the worktree');

    // Meanwhile main's PROJECT.md moves on in a way that would conflict.
    const mainDoc = readFileSync(join(repo, 'PROJECT.md'), 'utf-8').replace(
      '- [ ] `f-cccccc` Unrelated',
      '- [ ] `f-cccccc` Unrelated, renamed on main'
    );
    commitFile(repo, 'PROJECT.md', mainDoc, 'rename on main');

    const result = await tracks.landTrack(project(), 'Alpha', []);

    expect(existsSync(join(repo, 'src', 'a.ts'))).toBe(true);
    expect(git(repo, 'log', '-1', '--format=%s', result.mergeSha)).toBe('Merge track: Alpha');
    expect(result.synced).toEqual(['f-aaaaaa', 'f-bbbbbb']);

    const landedDoc = readFileSync(join(repo, 'PROJECT.md'), 'utf-8');
    expect(landedDoc).toContain('- [x] `f-aaaaaa` First step, renamed in the track');
    expect(landedDoc).toContain('- [ ] `f-bbbbbb`');
    expect(landedDoc).toContain('- [ ] `f-cccccc` Unrelated, renamed on main');
    // The spec the move took off main came back with the land.
    expect(readFileSync(join(repo, 'project', 'alpha.md'), 'utf-8')).toContain('Planned on main');
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

  it('keeps the worktree’s ticks when the merge conflicts, so a retry still carries them', async () => {
    writeFileSync(join(repo, 'shared.ts'), 'one\n');
    git(repo, 'add', 'shared.ts');
    git(repo, 'commit', '-q', '-m', 'shared');
    const t = await tracks.ensureTrackBranch(project(), 'Alpha');
    commitFile(t.worktreePath, 'shared.ts', 'track side\n', 'track edit');
    const ticked = readFileSync(join(t.worktreePath, 'PROJECT.md'), 'utf-8').replace(
      '- [ ] `f-aaaaaa`',
      '- [x] `f-aaaaaa`'
    );
    commitFile(t.worktreePath, 'PROJECT.md', ticked, 'tick in the worktree');
    const worktreeHead = git(t.worktreePath, 'rev-parse', 'HEAD');
    commitFile(repo, 'shared.ts', 'main side\n', 'main edit');
    const mainHead = git(repo, 'rev-parse', 'HEAD');

    await expect(tracks.landTrack(project(), 'Alpha', [])).rejects.toMatchObject({ status: 409 });

    // The reset commit is taken back off: the tick is still on the track branch.
    expect(git(t.worktreePath, 'rev-parse', 'HEAD')).toBe(worktreeHead);
    expect(readFileSync(join(t.worktreePath, 'PROJECT.md'), 'utf-8')).toContain('- [x] `f-aaaaaa`');
    expect(git(repo, 'rev-parse', 'HEAD')).toBe(mainHead);
    expect(git(repo, 'status', '--porcelain')).toBe('');
    expect(tracks.getActiveTrackBranch(repo, 'Alpha')).not.toBeNull();
  });

  it('re-attaches a missing worktree before landing instead of failing', async () => {
    const t = await tracks.ensureTrackBranch(project(), 'Alpha');
    commitFile(t.worktreePath, 'src/a.ts', 'export const a = 1;\n', 'work');
    rmSync(t.worktreePath, { recursive: true, force: true });

    const result = await tracks.landTrack(project(), 'Alpha', []);
    expect(existsSync(join(repo, 'src', 'a.ts'))).toBe(true);
    expect(result.mergeSha).toBe(git(repo, 'rev-parse', 'HEAD~0'));
  });

  it('refuses while the worktree has uncommitted code, naming the file', async () => {
    const t = await tracks.ensureTrackBranch(project(), 'Alpha');
    writeFileSync(join(t.worktreePath, 'scratch.ts'), 'wip\n');
    await expect(tracks.landTrack(project(), 'Alpha', [])).rejects.toMatchObject({
      status: 409,
      message: expect.stringContaining('scratch.ts'),
    });
    expect(existsSync(t.worktreePath)).toBe(true);
  });

  it('refuses while a session is open inside the worktree', async () => {
    const t = await tracks.ensureTrackBranch(project(), 'Alpha');
    await expect(
      tracks.landTrack(project(), 'Alpha', [join(t.worktreePath, 'src')])
    ).rejects.toMatchObject({ status: 409 });
  });

  it('refuses while dependencies are installing in the worktree', async () => {
    // Open session waits on the install before any session exists, so the
    // session check can't see it; the teardown would delete under npm.
    const { installDependencies } = await import('../src/server/projects/project-deps.js');
    const t = await tracks.ensureTrackBranch(project(), 'Alpha');
    writeFileSync(join(t.worktreePath, 'package.json'), '{"name":"x","version":"1.0.0"}');
    writeFileSync(join(t.worktreePath, 'package-lock.json'), '{ not json');
    const installing = installDependencies(t.worktreePath);
    try {
      await expect(tracks.landTrack(project(), 'Alpha', [])).rejects.toMatchObject({
        status: 409,
        message: expect.stringMatching(/still installing/),
      });
    } finally {
      await installing;
    }
  });

  it('refuses when the project is not on the branch the track came from', async () => {
    await tracks.ensureTrackBranch(project(), 'Alpha');
    git(repo, 'checkout', '-q', '-b', 'elsewhere');
    await expect(tracks.landTrack(project(), 'Alpha', [])).rejects.toMatchObject({ status: 409 });
  });
});

describe('deleteTrackBranchRows', () => {
  it('keeps the unlanded row when asked, and drops the landed ones', async () => {
    await tracks.ensureTrackBranch(project(), 'Alpha');
    await tracks.landTrack(project(), 'Alpha', []);
    const reopened = await tracks.ensureTrackBranch(project(), 'Alpha');

    tracks.deleteTrackBranchRows(repo, 'Alpha', { keepUnlanded: true });
    expect(tracks.listTrackBranches(repo).map((r) => r.id)).toEqual([reopened.id]);

    tracks.deleteTrackBranchRows(repo, 'Alpha');
    expect(tracks.listTrackBranches(repo)).toEqual([]);
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
      jobId: 'job-1',
      featureId: 'f-aaaaaa',
      mergeCwd: t.worktreePath,
    });

    expect(result.merged).toBe(true);
    expect(result.pushed).toBe(false);
    expect(result.pushSkippedReason).toBe('track-branch');
    expect(result.mergeSha).toBe(git(t.worktreePath, 'rev-parse', 'HEAD'));
    expect(existsSync(join(t.worktreePath, 'src', 'b.ts'))).toBe(true);
    expect(git(repo, 'rev-parse', 'main')).toBe(mainBefore);
    expect(git(t.worktreePath, 'log', '-1', '--format=%B')).toBe(
      'Merge job: First step\n\nJob-Id: job-1\nFeature: f-aaaaaa'
    );
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
        jobId: 'job-x',
        featureId: null,
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

  it('refuses a spec that is a symlink to somewhere outside the worktree', async () => {
    const t = await tracks.ensureTrackBranch(project(), 'Alpha');
    const outside = mkdtempSync(join(tmpdir(), 'cr-outside-'));
    writeFileSync(join(outside, 'secret.md'), 'not yours');
    const link = join(t.worktreePath, 'project', 'linked.md');
    try {
      symlinkSync(join(outside, 'secret.md'), link, 'file');
    } catch {
      return; // Windows without developer mode: nothing to assert.
    }
    try {
      expect(tracks.readSpecForTrack(project(), 'Alpha', 'project/linked.md')).toBeNull();
    } finally {
      rmSync(link, { force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });
});
