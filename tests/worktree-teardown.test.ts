import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { execFileSync } from 'child_process';
import * as realFs from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } = realFs;

// Real repositories: every git spawn costs ~50-100ms on Windows, and the
// suites run in parallel, so the 5s default is too tight under load.
vi.setConfig({ testTimeout: 30_000 });

// The one stand-in here: switches that make unlink, or reading one folder,
// fail — the cases a link cannot be removed or cannot be seen. The links
// themselves are real junctions.
const fails = vi.hoisted(() => ({ unlink: false, readdirOf: null as string | null }));
vi.mock('fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs/promises')>();
  const eperm = (): Error => Object.assign(new Error('EPERM: operation not permitted'), { code: 'EPERM' });
  return {
    ...actual,
    unlink: async (path: realFs.PathLike) => {
      if (fails.unlink) throw eperm();
      return actual.unlink(path);
    },
    readdir: (async (path: realFs.PathLike, ...rest: unknown[]) => {
      if (fails.readdirOf && String(path) === fails.readdirOf) throw eperm();
      return (actual.readdir as (...a: unknown[]) => Promise<unknown>)(path, ...rest);
    }) as typeof actual.readdir,
  };
});

/**
 * Worktree teardown against a real repository and real junctions.
 *
 * Git for Windows (2.39) deletes *through* a junction on `git worktree remove`:
 * a node_modules junction to the main checkout's copy emptied it
 * (docs/track-branches.md, "Dependencies"). What protects the target is a
 * property of the filesystem calls made before git runs, so only real links
 * can prove it.
 */

const dataDir = mkdtempSync(join(tmpdir(), 'cr-teardown-data-'));
const configPath = join(dataDir, 'config.json');
writeFileSync(configPath, JSON.stringify({ persistence: { dataDir } }));
process.env.CLAUDE_REMOTE_CONFIG = configPath;

const { loadConfig } = await import('../src/server/config.js');
const { createWorktree, removeWorktree, sweepLeftoverWorktrees, worktreeRoot } = await import(
  '../src/server/jobs/worktree.js'
);

let repo: string;
/** A folder outside every worktree, standing in for the main checkout's node_modules. */
let target: string;
const scratch: string[] = [];

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8' }).trim();
}

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  scratch.push(dir);
  return dir;
}

/** A target with enough in it that "emptied" and "intact" can't be confused. */
function makeTarget(): string {
  const dir = tempDir('cr-teardown-target-');
  mkdirSync(join(dir, 'some-package', 'lib'), { recursive: true });
  writeFileSync(join(dir, 'some-package', 'package.json'), '{"name":"some-package"}\n');
  writeFileSync(join(dir, 'some-package', 'lib', 'index.js'), 'module.exports = 1;\n');
  return dir;
}

function registered(path: string): boolean {
  return git(repo, 'worktree', 'list', '--porcelain')
    .split('\n')
    .some((l) => l.startsWith('worktree ') && l.slice('worktree '.length).toLowerCase() === path.replace(/\\/g, '/').toLowerCase());
}

beforeAll(() => {
  loadConfig();
});

afterAll(() => {
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
  rmSync(dataDir, { recursive: true, force: true });
});

beforeEach(() => {
  fails.unlink = false;
  fails.readdirOf = null;
  repo = tempDir('cr-teardown-repo-');
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'config', 'user.email', 'test@example.com');
  git(repo, 'config', 'user.name', 'Test');
  git(repo, 'config', 'commit.gpgsign', 'false');
  mkdirSync(join(repo, 'src'));
  writeFileSync(join(repo, 'src', 'index.ts'), 'export {};\n');
  writeFileSync(join(repo, '.gitignore'), 'node_modules\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-q', '-m', 'init');
  target = makeTarget();
});

async function newWorktree(name: string): Promise<string> {
  const path = join(worktreeRoot(), name);
  await createWorktree(repo, name, name, { path, branch: `job/${name}` });
  return path;
}

describe('removeWorktree never deletes through a link', () => {
  it('leaves a node_modules junction’s target intact and removes the worktree', async () => {
    const path = await newWorktree('nm-junction');
    symlinkSync(target, join(path, 'node_modules'), 'junction');
    // git sees nothing to warn about: the junction is ignored.
    expect(git(path, 'status', '--porcelain')).toBe('');

    const torn = await removeWorktree(repo, 'nm-junction', { path, deleteBranch: 'job/nm-junction' });

    expect(torn).toEqual({ removed: true, branchDeleted: true, linksLeft: [] });
    expect(existsSync(path)).toBe(false);
    expect(registered(path)).toBe(false);
    expect(readdirSync(target)).toEqual(['some-package']);
    expect(existsSync(join(target, 'some-package', 'lib', 'index.js'))).toBe(true);
  });

  it('leaves the target of a junction elsewhere in the tree intact', async () => {
    const path = await newWorktree('deep-junction');
    mkdirSync(join(path, 'src', 'vendor'), { recursive: true });
    symlinkSync(target, join(path, 'src', 'vendor', 'linked'), 'junction');

    const torn = await removeWorktree(repo, 'deep-junction', { path, deleteBranch: 'job/deep-junction' });

    expect(torn.removed).toBe(true);
    expect(existsSync(path)).toBe(false);
    expect(existsSync(join(target, 'some-package', 'lib', 'index.js'))).toBe(true);
  });

  it('removes a real node_modules with the worktree', async () => {
    const path = await newWorktree('nm-real');
    mkdirSync(join(path, 'node_modules', 'pkg', 'dist'), { recursive: true });
    writeFileSync(join(path, 'node_modules', 'pkg', 'dist', 'index.js'), '1;\n');

    const torn = await removeWorktree(repo, 'nm-real', { path, deleteBranch: 'job/nm-real' });

    expect(torn).toEqual({ removed: true, branchDeleted: true, linksLeft: [] });
    expect(existsSync(path)).toBe(false);
  });

  it('skips git and leaves the folder when a link cannot be unlinked, then finishes on the retry', async () => {
    const path = await newWorktree('stuck-link');
    symlinkSync(target, join(path, 'src', 'linked'), 'junction');

    fails.unlink = true;
    const torn = await removeWorktree(repo, 'stuck-link', { path });
    expect(torn.removed).toBe(false);
    expect(torn.linksLeft).toEqual([join(path, 'src', 'linked')]);
    // git never ran: still registered, folder and link in place, target whole.
    expect(registered(path)).toBe(true);
    expect(existsSync(join(path, 'src', 'index.ts'))).toBe(true);
    expect(existsSync(join(path, 'src', 'linked', 'some-package'))).toBe(true);
    expect(existsSync(join(target, 'some-package', 'lib', 'index.js'))).toBe(true);

    fails.unlink = false;
    const retried = await removeWorktree(repo, 'stuck-link', { path, deleteBranch: 'job/stuck-link' });
    expect(retried).toEqual({ removed: true, branchDeleted: true, linksLeft: [] });
    expect(existsSync(path)).toBe(false);
    expect(existsSync(join(target, 'some-package', 'lib', 'index.js'))).toBe(true);
  });

  it('fails closed on a folder it cannot read: git does not run, since a link could hide there', async () => {
    const path = await newWorktree('unreadable');
    mkdirSync(join(path, 'src', 'vendor'), { recursive: true });
    symlinkSync(target, join(path, 'src', 'vendor', 'linked'), 'junction');

    fails.readdirOf = join(path, 'src', 'vendor');
    const torn = await removeWorktree(repo, 'unreadable', { path });
    expect(torn.removed).toBe(false);
    expect(torn.linksLeft).toEqual([join(path, 'src', 'vendor')]);
    expect(registered(path)).toBe(true);
    expect(existsSync(join(target, 'some-package', 'lib', 'index.js'))).toBe(true);

    fails.readdirOf = null;
    const retried = await removeWorktree(repo, 'unreadable', { path, deleteBranch: 'job/unreadable' });
    expect(retried).toEqual({ removed: true, branchDeleted: true, linksLeft: [] });
    expect(existsSync(join(target, 'some-package', 'lib', 'index.js'))).toBe(true);
  });
});

describe('sweepLeftoverWorktrees and node_modules', () => {
  /** A former worktree git has deregistered: a folder with no `.git` link. */
  function leftover(name: string): string {
    const path = join(worktreeRoot(), name);
    mkdirSync(path, { recursive: true });
    return path;
  }

  it('sweeps a deregistered folder holding only node_modules (and stubs)', () => {
    const real = leftover('left-nm-real');
    mkdirSync(join(real, 'node_modules', 'pkg'), { recursive: true });
    writeFileSync(join(real, 'node_modules', 'pkg', 'index.js'), '1;\n');
    writeFileSync(join(real, 'SESSION-LOG.md'), 'stub\n');
    const linked = leftover('left-nm-junction');
    symlinkSync(target, join(linked, 'node_modules'), 'junction');

    const swept = sweepLeftoverWorktrees('SESSION-LOG.md');

    expect(swept).toEqual(expect.arrayContaining([real, linked]));
    expect(existsSync(real)).toBe(false);
    expect(existsSync(linked)).toBe(false);
    expect(existsSync(join(target, 'some-package', 'lib', 'index.js'))).toBe(true);
  });

  it('still leaves a folder holding anything else alone', () => {
    const kept = leftover('left-with-work');
    mkdirSync(join(kept, 'node_modules', 'pkg'), { recursive: true });
    writeFileSync(join(kept, 'notes.txt'), 'someone’s work\n');

    expect(sweepLeftoverWorktrees('SESSION-LOG.md')).not.toContain(kept);
    expect(existsSync(join(kept, 'notes.txt'))).toBe(true);
    expect(existsSync(join(kept, 'node_modules', 'pkg'))).toBe(true);
    rmSync(kept, { recursive: true, force: true });
  });
});
