import { describe, it, expect, afterAll, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

// A temp HOME (for ~/.claude/projects) and a temp TMP (for Claude Code's
// `<tmp>/claude` scratchpads), so the board's sources can be faked on disk.
let fakeTmp: string | undefined;
const FAKE_HOME = mkdtempSync(join(tmpdir(), 'cr-home-'));
fakeTmp = mkdtempSync(join(tmpdir(), 'cr-tmp-'));
let discovered: string[] = [];

vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>();
  return { ...actual, homedir: () => FAKE_HOME, tmpdir: () => fakeTmp ?? actual.tmpdir() };
});

vi.mock('../src/server/utils/logger.js', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

vi.mock('../src/server/jobs/worktree.js', () => ({
  worktreeRoot: () => join(FAKE_HOME, '.claude-remote', 'worktrees'),
}));

vi.mock('../src/server/sessions/project-discovery.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/server/sessions/project-discovery.js')>();
  return { ...actual, discoverProjects: () => discovered.map((cwd) => ({ cwd })) };
});

const { listBoardCwds, invalidateSlugCache } = await import('../src/server/projects/workspace.js');

/** How Claude Code names a cwd's transcript directory. */
const slugOf = (cwd: string) => cwd.replace(/[^A-Za-z0-9]/g, '-');

function addTranscriptDir(cwd: string): void {
  mkdirSync(join(FAKE_HOME, '.claude', 'projects', slugOf(cwd)), { recursive: true });
}

afterAll(() => {
  rmSync(FAKE_HOME, { recursive: true, force: true });
  rmSync(fakeTmp as string, { recursive: true, force: true });
});

describe('board membership', () => {
  it('leaves Claude Code scratchpads off the board, from discovery and from slugs', () => {
    const project = join(fakeTmp as string, 'my-project');
    const nearby = join(fakeTmp as string, 'claude-notes');
    const scratch = join(fakeTmp as string, 'claude', 'C--Users-me-proj', 'abc', 'scratchpad');
    const slugOnly = join(fakeTmp as string, 'claude', 'C--Users-me-proj', 'def', 'scratchpad');
    for (const dir of [project, nearby, scratch, slugOnly]) mkdirSync(dir, { recursive: true });
    for (const dir of [project, nearby, slugOnly]) addTranscriptDir(dir);
    discovered = [scratch];
    invalidateSlugCache();

    const cwds = listBoardCwds({ projects: [], splitChildren: [], favorites: [] });

    expect(cwds).toContain(project);
    // A sibling whose name merely starts with "claude" is not under the root.
    expect(cwds).toContain(nearby);
    expect(cwds).not.toContain(scratch);
    expect(cwds).not.toContain(slugOnly);
  });
});
