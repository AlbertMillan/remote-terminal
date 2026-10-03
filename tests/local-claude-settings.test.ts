import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { execFileSync } from 'child_process';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { ensureLocalClaudeSettings } from '../src/server/projects/local-claude-settings.js';

vi.setConfig({ testTimeout: 30_000 });

/**
 * A track worktree gets a copy of the main checkout's gitignored
 * `.claude/settings.local.json` (project/unattended-started-sessions.md), so
 * its sessions don't ask again for every MCP server and command the user
 * already approved. A real repository with a real worktree.
 */

let root: string;
let repo: string;
let wt: string;

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8' }).trim();
}

const SETTINGS = JSON.stringify({ enableAllProjectMcpServers: true, permissions: { allow: ['Bash(npm test)'] } });

function writeMainSettings(): void {
  mkdirSync(join(repo, '.claude'), { recursive: true });
  writeFileSync(join(repo, '.claude', 'settings.local.json'), SETTINGS);
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'cr-local-settings-'));
  repo = join(root, 'repo');
  wt = join(root, 'wt');
  mkdirSync(repo);
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'config', 'user.email', 't@example.com');
  git(repo, 'config', 'user.name', 'T');
  // The machine's own global ignore (~/.config/git/ignore) may already cover
  // the path; the exclude case needs a repository where nothing does.
  git(repo, 'config', 'core.excludesFile', join(root, 'no-global-ignore'));
  writeFileSync(join(repo, 'README.md'), 'hi\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-q', '-m', 'init');
  git(repo, 'worktree', 'add', '-q', '-b', 'track/x', wt);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('ensureLocalClaudeSettings', () => {
  it('copies the file when the worktree lacks it, as a regular file and not a link', async () => {
    writeMainSettings();
    expect(await ensureLocalClaudeSettings(repo, wt)).toBe(true);
    const target = join(wt, '.claude', 'settings.local.json');
    expect(readFileSync(target, 'utf-8')).toBe(SETTINGS);
    const stat = lstatSync(target);
    expect(stat.isFile()).toBe(true);
    expect(stat.isSymbolicLink()).toBe(false);
  });

  it('leaves an existing copy alone', async () => {
    writeMainSettings();
    mkdirSync(join(wt, '.claude'), { recursive: true });
    writeFileSync(join(wt, '.claude', 'settings.local.json'), '{"mine":true}');
    expect(await ensureLocalClaudeSettings(repo, wt)).toBe(false);
    expect(readFileSync(join(wt, '.claude', 'settings.local.json'), 'utf-8')).toBe('{"mine":true}');
  });

  it('does nothing when the main checkout has none', async () => {
    expect(await ensureLocalClaudeSettings(repo, wt)).toBe(false);
    expect(existsSync(join(wt, '.claude'))).toBe(false);
  });

  it('adds the shared exclude entry when the path is not ignored, so the copy never shows in git status', async () => {
    writeMainSettings();
    expect(git(wt, 'status', '--porcelain', '--untracked-files=all')).toBe('');
    expect(await ensureLocalClaudeSettings(repo, wt)).toBe(true);
    const exclude = readFileSync(join(repo, '.git', 'info', 'exclude'), 'utf-8');
    expect(exclude).toContain('/.claude/settings.local.json');
    expect(git(wt, 'status', '--porcelain', '--untracked-files=all')).toBe('');
    // Shared by every worktree, the main checkout included.
    expect(git(repo, 'status', '--porcelain', '--untracked-files=all')).toBe('');
  });

  it('leaves info/exclude alone when a .gitignore already covers the path', async () => {
    writeFileSync(join(wt, '.gitignore'), '.claude/settings.local.json\n');
    git(wt, 'add', '.gitignore');
    git(wt, 'commit', '-q', '-m', 'ignore');
    writeMainSettings();
    const before = existsSync(join(repo, '.git', 'info', 'exclude')) ? readFileSync(join(repo, '.git', 'info', 'exclude'), 'utf-8') : '';
    expect(await ensureLocalClaudeSettings(repo, wt)).toBe(true);
    const after = existsSync(join(repo, '.git', 'info', 'exclude')) ? readFileSync(join(repo, '.git', 'info', 'exclude'), 'utf-8') : '';
    expect(after).toBe(before);
  });
});
