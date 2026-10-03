import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { execFileSync, spawnSync } from 'child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

// Real repositories: every git spawn costs ~50-100ms on Windows, and the
// suites run in parallel, so the 5s default is too tight under load.
vi.setConfig({ testTimeout: 30_000 });

/**
 * Behind main, and Update from main, against real repositories.
 *
 * The trap these cover is a property of git: main holds the commit that took
 * the track's section and specs off it when the track branched, so a plain
 * `git merge main` in the worktree deletes a spec the branch never touched
 * without any conflict. A stub would never show that.
 */

const dataDir = mkdtempSync(join(tmpdir(), 'cr-update-data-'));
const configPath = join(dataDir, 'config.json');
writeFileSync(configPath, JSON.stringify({ persistence: { dataDir } }));
process.env.CLAUDE_REMOTE_CONFIG = configPath;

const { loadConfig } = await import('../src/server/config.js');
const { initDatabase, closeDatabase, getDatabase } = await import('../src/server/db/schema.js');
const tracks = await import('../src/server/projects/track-branches.js');
const NO_SESSIONS = { sessions: [], terminateSession: async () => true, removeSessions: async () => undefined };

// Two specs: alpha.md is revised in some tests, alpha-notes.md never is —
// the silent-delete case.
const DOC = `## Track: Alpha
- [ ] \`f-aaaaaa\` First step → project/alpha.md
- [ ] \`f-bbbbbb\` Second step → project/alpha-notes.md

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

const read = (cwd: string, rel: string) => readFileSync(join(cwd, rel), 'utf-8').replace(/\r\n/g, '\n');

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
  repo = mkdtempSync(join(tmpdir(), 'cr-update-repo-'));
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'config', 'user.email', 'test@example.com');
  git(repo, 'config', 'user.name', 'Test');
  git(repo, 'config', 'commit.gpgsign', 'false');
  writeFileSync(join(repo, 'PROJECT.md'), DOC);
  mkdirSync(join(repo, 'project'));
  writeFileSync(join(repo, 'project', 'alpha.md'), '# Alpha\n\nPlanned on main.\n');
  writeFileSync(join(repo, 'project', 'alpha-notes.md'), '# Alpha notes\n\nNever touched.\n');
  writeFileSync(join(repo, 'shared.ts'), 'one\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-q', '-m', 'plan');
});

const project = () => ({ cwd: repo });

/** The track's section as the worktree's PROJECT.md has it. */
function alphaSection(cwd: string): string {
  const text = read(cwd, 'PROJECT.md');
  const start = text.indexOf('## Track: Alpha');
  if (start === -1) return '';
  const next = text.indexOf('## Track:', start + 1);
  return text.slice(start, next === -1 ? undefined : next).trim();
}

describe('behindMain', () => {
  it('does not count the commit that moved the plan off main', async () => {
    const t = await tracks.ensureTrackBranch(project(), 'Alpha');
    expect(git(repo, 'log', '-1', '--format=%s')).toBe('Move "Alpha" plan into its track branch');
    expect(await tracks.behindMain(project(), t)).toEqual({ behind: 0, wouldConflict: [] });
  });

  it('lists a code file both sides changed, and recomputes once a sha moves', async () => {
    const t = await tracks.ensureTrackBranch(project(), 'Alpha');
    commitFile(t.worktreePath, 'shared.ts', 'track side\n', 'track edit');
    commitFile(repo, 'shared.ts', 'main side\n', 'main edit');
    expect(await tracks.behindMain(project(), t)).toEqual({ behind: 1, wouldConflict: ['shared.ts'] });

    commitFile(repo, 'other.ts', 'x\n', 'more on main');
    expect(await tracks.behindMain(project(), t)).toEqual({ behind: 2, wouldConflict: ['shared.ts'] });
  });

  it('leaves the plan doc and the track’s specs out of the conflicts', async () => {
    const t = await tracks.ensureTrackBranch(project(), 'Alpha');
    // The branch revises a spec main deleted (modify/delete) and ticks its
    // section next to a Beta line main renamed.
    commitFile(t.worktreePath, 'project/alpha.md', '# Alpha\n\nRevised in the track.\n', 'revise spec');
    const ticked = read(t.worktreePath, 'PROJECT.md')
      .replace('- [ ] `f-bbbbbb`', '- [x] `f-bbbbbb`')
      .replace('Unrelated', 'Unrelated, stale copy');
    commitFile(t.worktreePath, 'PROJECT.md', ticked, 'tick');
    commitFile(repo, 'PROJECT.md', read(repo, 'PROJECT.md').replace('Unrelated', 'Unrelated, renamed'), 'rename');
    commitFile(repo, 'src/main.ts', 'x\n', 'code on main');

    // Git does conflict on both; the filter is what drops them.
    const raw = spawnSync('git', ['merge-tree', '--write-tree', '--name-only', t.branch, 'main'], {
      cwd: repo,
      encoding: 'utf-8',
    });
    expect(raw.status).toBe(1);
    expect(raw.stdout).toContain('project/alpha.md');
    expect(raw.stdout).toContain('PROJECT.md');
    expect(await tracks.behindMain(project(), t)).toEqual({ behind: 1, wouldConflict: [] });
  });
});

describe('addBehindMain', () => {
  it('honours the registry’s doc override, so a plan-only commit there is not counted', async () => {
    git(repo, 'mv', 'PROJECT.md', 'PLAN.md');
    git(repo, 'commit', '-q', '-m', 'custom plan doc');
    const withDoc = { cwd: repo, doc: 'PLAN.md' };
    const t = await tracks.ensureTrackBranch(withDoc, 'Alpha');
    commitFile(repo, 'PLAN.md', read(repo, 'PLAN.md').replace('Unrelated', 'Unrelated, renamed'), 'plan only');

    const board = () =>
      [{ cwd: repo, tracks: [{ name: 'Alpha', branch: { name: t.branch }, worktreeMissing: false }] }] as unknown as Parameters<
        typeof tracks.addBehindMain
      >[0];
    const registryPath = join(dataDir, 'projects.json');
    try {
      // Unregistered, the board can only assume PROJECT.md, and counts both
      // plan-only commits: the branch's move and the rename.
      const [unregistered] = await tracks.addBehindMain(board());
      expect(unregistered.tracks[0]).toMatchObject({ behind: 2 });

      writeFileSync(registryPath, JSON.stringify({ projects: [withDoc] }));
      const [registered] = await tracks.addBehindMain(board());
      expect(registered.tracks[0]).toMatchObject({ behind: 0, wouldConflict: [] });
    } finally {
      rmSync(registryPath, { force: true });
    }
  });
});

describe('updateTrackFromMain', () => {
  it('brings main’s change in and keeps the section and every spec, including one the branch never touched', async () => {
    const t = await tracks.ensureTrackBranch(project(), 'Alpha');
    const sectionBefore = alphaSection(t.worktreePath);
    commitFile(repo, 'src/main.ts', 'export const m = 1;\n', 'unrelated change on main');
    expect(await tracks.behindMain(project(), t)).toEqual({ behind: 1, wouldConflict: [] });

    // What the trap looks like: a plain merge would delete the untouched spec.
    const plain = git(repo, 'merge-tree', '--write-tree', t.branch, 'main').split('\n')[0];
    expect(git(repo, 'ls-tree', '--name-only', plain, 'project/')).toBe('');

    const result = await tracks.updateTrackFromMain(project(), 'Alpha');

    expect(result.mergeSha).toBe(git(t.worktreePath, 'rev-parse', 'HEAD'));
    // The board's count, not the move commit as well.
    expect(result.detail).toContain('Merged 1 commit from main');
    expect(git(t.worktreePath, 'log', '-1', '--format=%s')).toBe('Merge main into track: Alpha');
    expect(git(t.worktreePath, 'rev-parse', 'HEAD^2')).toBe(git(repo, 'rev-parse', 'main'));
    expect(read(t.worktreePath, 'src/main.ts')).toBe('export const m = 1;\n');
    expect(alphaSection(t.worktreePath)).toBe(sectionBefore);
    expect(read(t.worktreePath, 'project/alpha.md')).toBe('# Alpha\n\nPlanned on main.\n');
    expect(read(t.worktreePath, 'project/alpha-notes.md')).toBe('# Alpha notes\n\nNever touched.\n');
    expect(git(t.worktreePath, 'status', '--porcelain')).toBe('');
    expect(await tracks.behindMain(project(), t)).toEqual({ behind: 0, wouldConflict: [] });

    // Main itself is untouched, and nothing was pushed or landed.
    expect(existsSync(join(repo, 'project', 'alpha-notes.md'))).toBe(false);
    expect(tracks.getActiveTrackBranch(repo, 'Alpha')?.landedAt).toBeNull();
  });

  it('keeps the branch’s version of a spec it revised (modify/delete)', async () => {
    const t = await tracks.ensureTrackBranch(project(), 'Alpha');
    commitFile(t.worktreePath, 'project/alpha.md', '# Alpha\n\nRevised in the track.\n', 'revise spec');
    commitFile(repo, 'src/main.ts', 'x\n', 'code on main');

    await tracks.updateTrackFromMain(project(), 'Alpha');

    expect(read(t.worktreePath, 'project/alpha.md')).toBe('# Alpha\n\nRevised in the track.\n');
    expect(read(t.worktreePath, 'project/alpha-notes.md')).toBe('# Alpha notes\n\nNever touched.\n');
    expect(git(t.worktreePath, 'status', '--porcelain')).toBe('');
  });

  it('refuses a code conflict naming the file, leaving HEAD, index and files as they were', async () => {
    const t = await tracks.ensureTrackBranch(project(), 'Alpha');
    commitFile(t.worktreePath, 'shared.ts', 'track side\n', 'track edit');
    commitFile(repo, 'shared.ts', 'main side\n', 'main edit');
    const head = git(t.worktreePath, 'rev-parse', 'HEAD');
    const doc = read(t.worktreePath, 'PROJECT.md');

    const refusal = tracks.updateTrackFromMain(project(), 'Alpha');
    await expect(refusal).rejects.toMatchObject({ status: 409, message: expect.stringContaining('shared.ts') });
    // The way out it names must not be the trap: a plain merge deletes specs.
    await expect(refusal).rejects.toThrow(/Update again. Don't run a plain `git merge main`/);

    expect(git(t.worktreePath, 'rev-parse', 'HEAD')).toBe(head);
    expect(git(t.worktreePath, 'status', '--porcelain')).toBe('');
    expect(read(t.worktreePath, 'shared.ts')).toBe('track side\n');
    expect(read(t.worktreePath, 'PROJECT.md')).toBe(doc);
    expect(existsSync(join(t.worktreePath, 'project', 'alpha-notes.md'))).toBe(true);
    expect(() => git(t.worktreePath, 'rev-parse', '-q', '--verify', 'MERGE_HEAD')).toThrow();
  });

  describe('a spec another section shares (main still has it)', () => {
    /** Beta links alpha.md too, so the move leaves it on main. */
    async function branchWithSharedSpec() {
      commitFile(repo, 'PROJECT.md', `${DOC}- [ ] \`f-eeeeee\` Shares Alpha's spec → project/alpha.md\n`, 'share');
      const t = await tracks.ensureTrackBranch(project(), 'Alpha');
      expect(existsSync(join(repo, 'project', 'alpha.md'))).toBe(true);
      return t;
    }

    it('is a real conflict when both sides edit it: listed, and Update refuses', async () => {
      const t = await branchWithSharedSpec();
      commitFile(t.worktreePath, 'project/alpha.md', '# Alpha\n\nTrack side.\n', 'track edits the spec');
      commitFile(repo, 'project/alpha.md', '# Alpha\n\nMain side.\n', 'main edits the spec');
      commitFile(repo, 'src/main.ts', 'x\n', 'code on main');
      const head = git(t.worktreePath, 'rev-parse', 'HEAD');

      expect(await tracks.behindMain(project(), t)).toEqual({ behind: 1, wouldConflict: ['project/alpha.md'] });
      await expect(tracks.updateTrackFromMain(project(), 'Alpha')).rejects.toMatchObject({
        status: 409,
        message: expect.stringContaining('project/alpha.md'),
      });
      expect(git(t.worktreePath, 'rev-parse', 'HEAD')).toBe(head);
      expect(git(t.worktreePath, 'status', '--porcelain')).toBe('');
    });

    it('takes main’s edit when only main changed it', async () => {
      const t = await branchWithSharedSpec();
      commitFile(repo, 'project/alpha.md', '# Alpha\n\nEdited on main.\n', 'main edits the spec');
      commitFile(repo, 'src/main.ts', 'x\n', 'code on main');

      await tracks.updateTrackFromMain(project(), 'Alpha');

      expect(read(t.worktreePath, 'project/alpha.md')).toBe('# Alpha\n\nEdited on main.\n');
      expect(read(t.worktreePath, 'project/alpha-notes.md')).toBe('# Alpha notes\n\nNever touched.\n');
    });
  });

  it('takes main’s other sections and keeps its own when main changed other tracks', async () => {
    const t = await tracks.ensureTrackBranch(project(), 'Alpha');
    const ticked = read(t.worktreePath, 'PROJECT.md')
      .replace('- [ ] `f-aaaaaa`', '- [x] `f-aaaaaa`')
      .replace('Unrelated', 'Unrelated, stale copy');
    commitFile(t.worktreePath, 'PROJECT.md', ticked, 'tick in the worktree');
    const mainDoc = `${read(repo, 'PROJECT.md').replace('Unrelated', 'Unrelated, renamed on main')}
## Track: Gamma
- [ ] \`f-dddddd\` Added on main
`;
    commitFile(repo, 'PROJECT.md', mainDoc, 'plan other tracks on main');
    commitFile(repo, 'src/main.ts', 'x\n', 'code on main');
    expect(await tracks.behindMain(project(), t)).toEqual({ behind: 1, wouldConflict: [] });

    await tracks.updateTrackFromMain(project(), 'Alpha');

    const doc = read(t.worktreePath, 'PROJECT.md');
    expect(doc).toContain('- [ ] `f-cccccc` Unrelated, renamed on main');
    expect(doc).not.toContain('stale copy');
    expect(doc).toContain('## Track: Gamma');
    expect(doc).toContain('- [x] `f-aaaaaa` First step');
    expect(doc).toContain('- [ ] `f-bbbbbb` Second step');
    expect(git(t.worktreePath, 'status', '--porcelain')).toBe('');
  });

  it('refuses uncommitted code in the worktree, naming it', async () => {
    const t = await tracks.ensureTrackBranch(project(), 'Alpha');
    commitFile(repo, 'src/main.ts', 'x\n', 'code on main');
    writeFileSync(join(t.worktreePath, 'scratch.ts'), 'wip\n');
    const head = git(t.worktreePath, 'rev-parse', 'HEAD');

    await expect(tracks.updateTrackFromMain(project(), 'Alpha')).rejects.toMatchObject({
      status: 409,
      message: expect.stringContaining('scratch.ts'),
    });
    expect(git(t.worktreePath, 'rev-parse', 'HEAD')).toBe(head);
  });

  it('commits uncommitted planning first, then updates', async () => {
    const t = await tracks.ensureTrackBranch(project(), 'Alpha');
    commitFile(repo, 'src/main.ts', 'x\n', 'code on main');
    writeFileSync(
      join(t.worktreePath, 'PROJECT.md'),
      read(t.worktreePath, 'PROJECT.md').replace('- [ ] `f-aaaaaa`', '- [x] `f-aaaaaa`')
    );
    writeFileSync(join(t.worktreePath, 'project', 'alpha.md'), '# Alpha\n\nEdited, uncommitted.\n');

    await tracks.updateTrackFromMain(project(), 'Alpha');

    expect(git(t.worktreePath, 'log', '-1', '--format=%s', 'HEAD^1')).toContain('planning before updating');
    expect(read(t.worktreePath, 'PROJECT.md')).toContain('- [x] `f-aaaaaa`');
    expect(read(t.worktreePath, 'project/alpha.md')).toBe('# Alpha\n\nEdited, uncommitted.\n');
    expect(existsSync(join(t.worktreePath, 'src', 'main.ts'))).toBe(true);
    expect(git(t.worktreePath, 'status', '--porcelain')).toBe('');
  });

  it('says so, and merges nothing, when already up to date', async () => {
    const t = await tracks.ensureTrackBranch(project(), 'Alpha');
    await tracks.updateTrackFromMain(project(), 'Alpha'); // takes in the move commit
    const head = git(t.worktreePath, 'rev-parse', 'HEAD');
    const again = await tracks.updateTrackFromMain(project(), 'Alpha');
    expect(again.mergeSha).toBeNull();
    expect(git(t.worktreePath, 'rev-parse', 'HEAD')).toBe(head);
  });

  it('leaves a Land afterwards clean: the section goes back and every spec is intact on main', async () => {
    const t = await tracks.ensureTrackBranch(project(), 'Alpha');
    commitFile(t.worktreePath, 'project/alpha.md', '# Alpha\n\nRevised in the track.\n', 'revise spec');
    commitFile(t.worktreePath, 'src/a.ts', 'export const a = 1;\n', 'implement a');
    const ticked = read(t.worktreePath, 'PROJECT.md').replace('- [ ] `f-aaaaaa`', '- [x] `f-aaaaaa`');
    commitFile(t.worktreePath, 'PROJECT.md', ticked, 'tick');
    commitFile(repo, 'src/main.ts', 'x\n', 'code on main');

    await tracks.updateTrackFromMain(project(), 'Alpha');
    commitFile(repo, 'src/later.ts', 'y\n', 'more on main after the update');
    const landed = await tracks.landTrack(project(), 'Alpha', NO_SESSIONS);

    expect(git(repo, 'log', '-1', '--format=%s', landed.mergeSha)).toBe('Merge track: Alpha');
    expect(landed.synced).toEqual(['f-aaaaaa', 'f-bbbbbb']);
    const doc = read(repo, 'PROJECT.md');
    expect(doc).toContain('- [x] `f-aaaaaa` First step');
    expect(doc).toContain('## Track: Beta');
    expect(doc.match(/## Track: Alpha/g)).toHaveLength(1);
    expect(read(repo, 'project/alpha.md')).toBe('# Alpha\n\nRevised in the track.\n');
    expect(read(repo, 'project/alpha-notes.md')).toBe('# Alpha notes\n\nNever touched.\n');
    for (const f of ['src/a.ts', 'src/main.ts', 'src/later.ts']) expect(existsSync(join(repo, f))).toBe(true);
    expect(git(repo, 'status', '--porcelain')).toBe('');
  });
});
