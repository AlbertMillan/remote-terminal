import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

/**
 * The New Session folder field (project/new-session-folder-picker.md): completion, project
 * search, and creating a missing folder, all held inside a stand-in home folder. Nothing
 * here reads the real home folder or ~/.claude.
 */

const dataDir = mkdtempSync(join(tmpdir(), 'cr-folder-picker-'));
const home = join(dataDir, 'home');
const projects = join(home, 'NodeProjects');
const outside = join(dataDir, 'outside');
const configPath = join(dataDir, 'config.json');
writeFileSync(configPath, JSON.stringify({ persistence: { dataDir }, sessions: { defaultCwd: projects } }));
process.env.CLAUDE_REMOTE_CONFIG = configPath;

let recent: { cwd: string; lastUsed: number }[] = [];
let discovered: { cwd: string; lastActivity: string | null }[] = [];
vi.mock('../src/server/sessions/recent-paths.js', () => ({ getRecentPaths: () => recent }));
vi.mock('../src/server/projects/project-discovery.js', async (orig) => ({
  ...(await orig<typeof import('../src/server/projects/project-discovery.js')>()),
  discoverProjects: () => discovered,
}));
vi.mock('../src/server/projects/registry.js', async (orig) => ({
  ...(await orig<typeof import('../src/server/projects/registry.js')>()),
  loadRegistry: () => ({ projects: [], splitChildren: [], favorites: [] }),
}));
// Which paths reached the disk: a refused path must reach none.
const touched: string[] = [];
vi.mock('fs/promises', async (orig) => {
  const real = await orig<typeof import('fs/promises')>();
  const watch =
    <A extends unknown[], R>(fn: (p: string, ...rest: A) => R) =>
    (p: string, ...rest: A): R => {
      touched.push(String(p));
      return fn(p, ...rest);
    };
  return { ...real, stat: watch(real.stat), realpath: watch(real.realpath), readdir: watch(real.readdir) };
});

const { loadConfig } = await import('../src/server/config.js');
const picker = await import('../src/server/sessions/folder-picker.js');
loadConfig();

afterAll(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

beforeEach(() => {
  rmSync(home, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
  mkdirSync(join(projects, 'market-analyzer', '.git'), { recursive: true });
  mkdirSync(join(projects, 'Market-Analyzer-client'), { recursive: true });
  mkdirSync(join(projects, 'mcps'), { recursive: true });
  mkdirSync(join(projects, '.hidden-thing'), { recursive: true });
  writeFileSync(join(projects, 'market-analyzer', 'PROJECT.md'), '# x\n');
  writeFileSync(join(projects, 'notes.txt'), 'a file');
  mkdirSync(outside, { recursive: true });
  recent = [];
  discovered = [];
  touched.length = 0;
});

describe('checkLexically', () => {
  it.each([
    ['\\\\host\\share\\x', 'Network'],
    ['//host/share', 'Network'],
    ['~/NodeProjects/../../x', '".."'],
    ['~/.ssh/keys', '.ssh'],
    ['~/AppData/Local/x', 'AppData'],
    ['~/NodeProjects/a:b', 'not a valid folder name'],
    ['~/NodeProjects/con', 'not a valid folder name'],
    ['~/NodeProjects/trailing.', 'not a valid folder name'],
  ])('refuses %s', (input, reason) => {
    const r = picker.checkLexically(input, home);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain(reason);
  });

  it('refuses a path outside the home folder', () => {
    const r = picker.checkLexically(outside, home);
    expect(r).toMatchObject({ ok: false });
  });

  it('reads ~ as the home folder and a relative path as under the default folder', () => {
    expect(picker.checkLexically('~/NodeProjects/a/b', home)).toEqual({ ok: true, path: join(projects, 'a', 'b') });
    expect(picker.checkLexically('steam', home)).toEqual({ ok: true, path: join(projects, 'steam') });
    expect(picker.checkLexically('~\\NodeProjects\\c', home)).toEqual({ ok: true, path: join(projects, 'c') });
  });
});

describe('checkFolder', () => {
  it('names the default folder for an empty field', async () => {
    expect(await picker.checkFolder('', home)).toEqual({ kind: 'empty', path: projects, display: '~/NodeProjects' });
  });

  it('touches no filesystem for a network path', async () => {
    const v = await picker.checkFolder('\\\\evil-host\\share\\x', home);
    expect(v.kind).toBe('refused');
    expect(touched).toEqual([]);
  });

  it('knows an existing folder and its project', async () => {
    expect(await picker.checkFolder('~/NodeProjects/market-analyzer', home)).toMatchObject({
      kind: 'exists',
      project: 'market-analyzer',
    });
    expect(await picker.checkFolder('~/NodeProjects/mcps', home)).toMatchObject({ kind: 'exists', project: null });
  });

  it('lists every missing level, outermost first', async () => {
    expect(await picker.checkFolder('~/NodeProjects/games/recipe-scaler', home)).toMatchObject({
      kind: 'creatable',
      existing: projects,
      create: ['games', 'recipe-scaler'],
      display: '~/NodeProjects/games/recipe-scaler',
    });
  });

  it('refuses a path through a file', async () => {
    expect((await picker.checkFolder('~/NodeProjects/notes.txt/x', home)).kind).toBe('refused');
  });

  it('refuses a junction under home that leads outside it', async () => {
    symlinkSync(outside, join(projects, 'escape'), 'junction');
    const v = await picker.checkFolder('~/NodeProjects/escape/new', home);
    expect(v).toMatchObject({ kind: 'refused' });
    if (v.kind === 'refused') expect(v.reason).toContain('outside your user folder');
  });
});

describe('existing folders open wherever they are', () => {
  // The user-folder rules are for creating: a track worktree lives under ~/.claude-remote.
  it.each([
    ['a track worktree under a hidden folder', () => join(home, '.claude-remote', 'worktrees', 'tracks', 'abc')],
    ['a folder under AppData', () => join(home, 'AppData', 'Local', 'proj')],
    ['a folder outside the home folder', () => outside],
  ])('%s', async (_label, at) => {
    const path = at();
    mkdirSync(path, { recursive: true });
    expect(await picker.checkFolder(path, home)).toMatchObject({ kind: 'exists', path });
    expect(await picker.createFolder(path, { git: true, projectDoc: true }, home)).toBe(path);
    expect(existsSync(join(path, '.git'))).toBe(false);
  });

  it('still refuses to create a folder under a hidden one that exists', async () => {
    mkdirSync(join(home, '.claude-remote'), { recursive: true });
    expect((await picker.checkFolder('~/.claude-remote/new', home)).kind).toBe('refused');
  });

  it('opens a junction that exists, wherever it leads', async () => {
    symlinkSync(outside, join(projects, 'escape'), 'junction');
    expect((await picker.checkFolder('~/NodeProjects/escape', home)).kind).toBe('exists');
  });

  it('still refuses a network path that might exist, before any disk access', async () => {
    expect((await picker.checkFolder('\\\\server\\share', home)).kind).toBe('refused');
    expect(touched).toEqual([]);
  });
});

describe('createFolder', () => {
  it('makes every level, then git and a starter PROJECT.md', async () => {
    const path = await picker.createFolder('~/NodeProjects/games/recipe-scaler', { git: true, projectDoc: true }, home);
    expect(path).toBe(join(projects, 'games', 'recipe-scaler'));
    expect(existsSync(join(path, '.git'))).toBe(true);
    const doc = readFileSync(join(path, 'PROJECT.md'), 'utf8');
    expect(doc).toContain('name: recipe-scaler');
    expect(doc).toContain('status: active');
    expect(existsSync(join(projects, 'games', '.git'))).toBe(false);
  });

  it('leaves out what was not asked for', async () => {
    const path = await picker.createFolder('~/NodeProjects/plain', { git: false, projectDoc: false }, home);
    expect(existsSync(path)).toBe(true);
    expect(existsSync(join(path, '.git'))).toBe(false);
    expect(existsSync(join(path, 'PROJECT.md'))).toBe(false);
  });

  it('opens an existing folder without changing it', async () => {
    const path = await picker.createFolder('~/NodeProjects/mcps', { git: true, projectDoc: true }, home);
    expect(path).toBe(join(projects, 'mcps'));
    expect(existsSync(join(path, '.git'))).toBe(false);
    expect(existsSync(join(path, 'PROJECT.md'))).toBe(false);
  });

  it('refuses, and creates nothing, outside the home folder', async () => {
    const target = join(outside, 'new');
    await expect(picker.createFolder(target, { git: true, projectDoc: true }, home)).rejects.toThrow(
      picker.FolderRefusedError
    );
    expect(existsSync(target)).toBe(false);
  });
});

describe('completeFolder', () => {
  it('lists the folders under the typed parent, case aside, hidden ones never', async () => {
    const c = await picker.completeFolder('~/NodeProjects/ma', home);
    expect(c.mode).toBe('path');
    expect(c.items.map((i) => i.name)).toEqual(['market-analyzer', 'Market-Analyzer-client']);
    expect(c.items[0]).toMatchObject({ git: true, projectDoc: true, display: '~/NodeProjects/market-analyzer' });
    const all = await picker.completeFolder('~/NodeProjects/', home);
    expect(all.items.map((i) => i.name)).not.toContain('.hidden-thing');
    expect(all.items.map((i) => i.name)).not.toContain('notes.txt');
  });

  it('ranks recently used folders first', async () => {
    recent = [{ cwd: join(projects, 'Market-Analyzer-client'), lastUsed: 5 }];
    const c = await picker.completeFolder('~/NodeProjects/ma', home);
    expect(c.items.map((i) => i.name)).toEqual(['Market-Analyzer-client', 'market-analyzer']);
    expect(c.items[0].recent).toBe(true);
  });

  it('never lists AppData, a link, or a file', async () => {
    mkdirSync(join(home, 'AppData'), { recursive: true });
    symlinkSync(outside, join(home, 'linked'), 'junction');
    const names = (await picker.completeFolder('~/', home)).items.map((i) => i.name);
    expect(names).toEqual(['NodeProjects']);
  });

  it('lists nothing under a refused parent', async () => {
    expect((await picker.completeFolder('~/.ssh/', home)).items).toEqual([]);
    expect((await picker.completeFolder('~/AppData/', home)).items).toEqual([]);
  });

  it('searches known projects by name, and offers a new folder for the word', async () => {
    discovered = [
      { cwd: join(projects, 'market-analyzer'), lastActivity: '2026-01-02T00:00:00Z' },
      { cwd: join(projects, 'mcps'), lastActivity: '2026-01-01T00:00:00Z' },
    ];
    const c = await picker.completeFolder('ANALY', home);
    expect(c.mode).toBe('search');
    // The known project first; the default folder's other match after it.
    expect(c.items.map((i) => i.name)).toEqual(['market-analyzer', 'Market-Analyzer-client']);
    expect(c.newFolder).toEqual({ path: join(projects, 'ANALY'), display: '~/NodeProjects/ANALY' });
    expect(c.verdict.kind).toBe('creatable');
  });

  it('also finds folders in the default folder no session has run in, after known ones', async () => {
    discovered = [{ cwd: join(projects, 'Market-Analyzer-client'), lastActivity: '2026-01-02T00:00:00Z' }];
    const c = await picker.completeFolder('market', home);
    expect(c.items.map((i) => i.name)).toEqual(['Market-Analyzer-client', 'market-analyzer']);
    expect((await picker.completeFolder('hidden', home)).items).toEqual([]);
  });

  it('offers no new folder for a name that exists', async () => {
    const c = await picker.completeFolder('mcps', home);
    expect(c.newFolder).toBeNull();
    expect(c.verdict.kind).toBe('exists');
  });

  it('names the home folder and the default folder for the client', async () => {
    const c = await picker.completeFolder('', home);
    expect(c.home).toBe(home);
    expect(c.defaultDisplay).toBe('~/NodeProjects');
    expect(c.verdict.kind).toBe('empty');
  });
});

describe('defaultCwd', () => {
  it('falls back to the home folder when the configured one is missing', () => {
    rmSync(projects, { recursive: true, force: true });
    expect(picker.defaultCwd(home)).toBe(home);
  });
});
