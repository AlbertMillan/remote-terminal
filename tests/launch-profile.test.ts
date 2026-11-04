import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';

/**
 * launch-profile.ts: which MCP servers a started session may be given by name, the scoped
 * config file it gets, and the flags every launch of its `claude` types
 * (project/lean-started-sessions.md).
 */

const { dataDir } = await vi.hoisted(async () => {
  const { makeTmpDataDir } = await import('./helpers/tmp-data-dir.js');
  return { dataDir: makeTmpDataDir('launch-profile') };
});

vi.mock('../src/server/config.js', async () => {
  const actual = await vi.importActual<typeof import('../src/server/config.js')>('../src/server/config.js');
  return {
    ...actual,
    getConfig: () => {
      const base = actual.getConfig();
      return { ...base, persistence: { ...base.persistence, dataDir } };
    },
  };
});

// A worktree maps to its project, whose path keys the local-scope servers.
let trackProject: string | null = null;
// A read-only peer's track: its worktree and the id its notes folder is keyed by.
let trackBranch: { id: string; projectCwd: string; worktreePath: string; landedAt: string | null } | null = null;
vi.mock('../src/server/projects/track-store.js', () => ({
  trackBranchContaining: () => trackBranch ?? (trackProject ? { projectCwd: trackProject } : null),
}));

import {
  availableMcpServers,
  launchFlags,
  parseMcpServers,
  peerSettings,
  permissionModeFlag,
  permissionRulePath,
} from '../src/server/sessions/launch-profile.js';
import {
  deletePeerNotes,
  deletePromptFile,
  mcpConfigPathFor,
  peerNotesDirFor,
  peerSettingsPathFor,
  promptDirFor,
} from '../src/server/sessions/prompt-file.js';
import { existsSync } from 'fs';

const SESSION = '33333333-3333-4333-8333-333333333333';
let home: string;
/** The account's `.claude.json` (accounts.ts claudeJsonPath) under the stand-in home. */
const claudeJson = () => join(home, '.claude.json');
let project: string;
let worktree: string;

function writeJson(path: string, value: unknown) {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, JSON.stringify(value));
}

beforeEach(() => {
  trackProject = null;
  home = join(dataDir, `home-${Math.random().toString(36).slice(2)}`);
  project = join(home, 'NodeProjects', 'game');
  worktree = join(home, '.claude-remote', 'worktrees', 'tracks', 'abcd1234');
  mkdirSync(project, { recursive: true });
  mkdirSync(worktree, { recursive: true });
});

describe('availableMcpServers', () => {
  it('merges user scope, .mcp.json up from the cwd, and local scope, in that precedence', () => {
    trackProject = project;
    writeJson(join(home, '.claude.json'), {
      mcpServers: { playwright: { command: 'user-pw' }, everhour: { command: 'eh' }, slack: { command: 'user-slack' } },
      // Keyed with forward slashes, as Claude Code writes them; matched case-insensitively.
      projects: { [project.replace(/\\/g, '/').toUpperCase()]: { mcpServers: { playwright: { command: 'local-pw' } } } },
    });
    // ~/.mcp.json is found from a worktree under home, as Claude itself finds it.
    writeJson(join(home, '.mcp.json'), { mcpServers: { slack: { command: 'home-slack' }, github: { command: 'gh' } } });
    writeJson(join(worktree, '.mcp.json'), { mcpServers: { github: { command: 'wt-gh' } } });

    const servers = availableMcpServers(worktree, claudeJson());
    expect(servers.get('playwright')).toEqual({ command: 'local-pw' });
    expect(servers.get('slack')).toEqual({ command: 'home-slack' });
    expect(servers.get('github')).toEqual({ command: 'wt-gh' });
    expect(servers.get('everhour')).toEqual({ command: 'eh' });
  });

  it('finds a server in the main checkout\'s .mcp.json from its worktree, which never has it', () => {
    // A start checks names against the main checkout; the launch reads them from the worktree.
    trackProject = project;
    writeJson(join(project, '.mcp.json'), { mcpServers: { unity: { command: 'project-unity' } } });
    expect(availableMcpServers(project, claudeJson()).get('unity')).toEqual({ command: 'project-unity' });
    expect(availableMcpServers(worktree, claudeJson()).get('unity')).toEqual({ command: 'project-unity' });
  });

  it('lets the worktree\'s own .mcp.json win, and never lets a shared parent override the project', () => {
    trackProject = project;
    writeJson(join(home, '.mcp.json'), { mcpServers: { unity: { command: 'home' }, slack: { command: 'home-slack' } } });
    writeJson(join(project, '.mcp.json'), { mcpServers: { unity: { command: 'project' }, slack: { command: 'project-slack' } } });
    writeJson(join(worktree, '.mcp.json'), { mcpServers: { slack: { command: 'wt-slack' } } });
    const servers = availableMcpServers(worktree, claudeJson());
    // home is in both chains: read once, in the project's, so the project still wins over it.
    expect(servers.get('unity')).toEqual({ command: 'project' });
    expect(servers.get('slack')).toEqual({ command: 'wt-slack' });
  });

  it('never throws on a missing or unreadable ~/.claude.json, and reads it as empty', () => {
    // The walk up from a temp folder can reach a real .mcp.json above it, so compare
    // against that baseline rather than assume none.
    const baseline = [...availableMcpServers(worktree, claudeJson()).keys()];
    writeFileSync(join(home, '.claude.json'), '{ not json');
    expect([...availableMcpServers(worktree, claudeJson()).keys()]).toEqual(baseline);
  });
});

describe('parseMcpServers', () => {
  it('takes an absent list as none and drops duplicates', () => {
    expect(parseMcpServers(undefined)).toEqual([]);
    expect(parseMcpServers([' playwright', 'playwright', 'figma-rest'])).toEqual(['playwright', 'figma-rest']);
  });

  it.each([['playwright'], [['a b']], [[1]], [['$(rm)']], [Array.from({ length: 9 }, (_, i) => `s${i}`)]])(
    'refuses %j with a message',
    (value) => {
      expect(typeof parseMcpServers(value)).toBe('string');
    }
  );
});

describe('launchFlags', () => {
  it('gives the full profile only its permission mode', () => {
    expect(launchFlags(SESSION, worktree, { permissionMode: 'auto', mcpServers: null }, claudeJson())).toEqual({
      flags: '--permission-mode auto ',
      mcpServers: null,
    });
    expect(launchFlags(SESSION, worktree, { permissionMode: null, mcpServers: null }, claudeJson()).flags).toBe('');
  });

  it('gives no MCP servers for an empty list, and types no mode for manual or default', () => {
    expect(launchFlags(SESSION, worktree, { permissionMode: 'manual', mcpServers: [] }, claudeJson())).toEqual({
      flags: '--strict-mcp-config ',
      mcpServers: [],
    });
    expect(permissionModeFlag('default')).toBe('');
  });

  it.each(['bypassPermissions', 'auto; rm -rf ~', 'dontAsk'])('types no flag for a stored mode %j it does not know', (mode) => {
    // The mode reaches a shell line from the DB on revive and Resume.
    expect(permissionModeFlag(mode)).toBe('');
  });

  it('drops the --mcp-config flag when none of the opted-in servers is left', () => {
    expect(launchFlags(SESSION, worktree, { permissionMode: 'auto', mcpServers: ['gone'] }, claudeJson())).toEqual({
      flags: '--permission-mode auto --strict-mcp-config ',
      mcpServers: [],
    });
  });

  it('writes the opted-in servers’ current config beside the prompt folder, never in it or the worktree', () => {
    writeJson(join(home, '.claude.json'), { mcpServers: { playwright: { command: 'npx', env: { KEY: 'k1' } }, everhour: { command: 'eh' } } });

    const { flags, mcpServers } = launchFlags(SESSION, worktree, { permissionMode: 'auto', mcpServers: ['playwright', 'gone'] }, claudeJson());

    const path = mcpConfigPathFor(SESSION);
    // --add-dir opens the prompt folder to the session without asking; the keys stay out of it.
    expect(path.startsWith(promptDirFor(SESSION))).toBe(false);
    expect(flags).toBe(`--permission-mode auto --strict-mcp-config --mcp-config "${path.replace(/\\/g, '/')}" `);
    expect(flags).not.toContain('\\');
    expect(mcpServers).toEqual(['playwright']);
    // A server since removed from the config is left out rather than failing the launch.
    expect(JSON.parse(readFileSync(path, 'utf-8'))).toEqual({ mcpServers: { playwright: { command: 'npx', env: { KEY: 'k1' } } } });

    // Rewritten at the next launch, so a changed key applies.
    writeJson(join(home, '.claude.json'), { mcpServers: { playwright: { command: 'npx', env: { KEY: 'k2' } } } });
    launchFlags(SESSION, worktree, { permissionMode: 'auto', mcpServers: ['playwright'] }, claudeJson());
    expect(JSON.parse(readFileSync(path, 'utf-8')).mcpServers.playwright.env.KEY).toBe('k2');

    // Deleted with the session, like its prompt folder.
    deletePromptFile(SESSION);
    expect(existsSync(path)).toBe(false);
  });
});

describe('read-only peers (project/builder-critic-pairs.md)', () => {
  const TRACK = 'tb-0001';
  const slash = (p: string) => p.replace(/\\/g, '/');

  beforeEach(() => {
    trackBranch = { id: TRACK, projectCwd: 'C:\\p\\demo', worktreePath: worktree, landedAt: null };
  });
  afterEach(() => {
    trackBranch = null;
    deletePromptFile(SESSION);
    deletePeerNotes(TRACK);
  });

  it('writes an absolute path as a rule path Claude Code matches: // and the drive as a folder', () => {
    expect(permissionRulePath('C:\\Users\\a\\wt')).toBe('//c/Users/a/wt');
    expect(permissionRulePath('D:/x/y/')).toBe('//d/x/y');
    expect(permissionRulePath('/home/a/wt')).toBe('//home/a/wt');
    // No known rule form: a rule that matched nothing would leave the peer able to edit.
    expect(() => permissionRulePath('\\\\server\\share\\wt')).toThrow(/network path/);
    expect(() => permissionRulePath('relative/wt')).toThrow(/not an absolute path/);
  });

  it('denies edits in the worktree and allows them in the notes folder, with Edit rules only', () => {
    expect(peerSettings(['C:\\wt', 'C:\\p\\demo'], 'C:\\data\\peers\\t')).toEqual({
      permissions: { deny: ['Edit(//c/wt/**)', 'Edit(//c/p/demo/**)'], allow: ['Edit(//c/data/peers/t/**)'] },
    });
    expect(peerSettings(['C:\\wt', 'C:/wt/'], null)).toEqual({ permissions: { deny: ['Edit(//c/wt/**)'], allow: [] } });
  });

  it('adds the settings, the tools it never asks for and the notes folder, after the MCP flags', () => {
    const { flags } = launchFlags(SESSION, worktree, { permissionMode: 'auto', mcpServers: [], access: 'read' }, claudeJson());
    const settings = peerSettingsPathFor(SESSION);
    const notes = peerNotesDirFor(TRACK);
    expect(flags).toBe(
      `--permission-mode auto --strict-mcp-config --settings "${slash(settings)}" --allowedTools WebFetch WebSearch Read --add-dir "${slash(notes)}" `
    );
    expect(flags).not.toContain('\\');
    // Under the data dir: never in the worktree (commitAll) nor the prompt folder (the session could rewrite it).
    expect(settings.startsWith(dataDir)).toBe(true);
    expect(settings.startsWith(promptDirFor(SESSION))).toBe(false);
    // The main checkout is denied too: it's the other place a peer could break.
    expect(JSON.parse(readFileSync(settings, 'utf-8'))).toEqual(peerSettings([worktree, 'C:\\p\\demo'], slash(notes)));
    expect(existsSync(notes)).toBe(true);
  });

  it('applies to a full-roster profile too (a Resume of a peer with no stored servers)', () => {
    const { flags } = launchFlags(SESSION, worktree, { permissionMode: null, mcpServers: null, access: 'read' }, claudeJson());
    expect(flags).toMatch(/^--settings "[^"]+" --allowedTools WebFetch WebSearch Read --add-dir "[^"]+" $/);
  });

  it('gives a writer none of it', () => {
    for (const access of [null, undefined, 'write']) {
      const { flags } = launchFlags(SESSION, worktree, { permissionMode: 'auto', mcpServers: [], access }, claudeJson());
      expect(flags).toBe('--permission-mode auto --strict-mcp-config ');
    }
    expect(existsSync(peerSettingsPathFor(SESSION))).toBe(false);
  });

  it('never recreates the notes of a landed track', () => {
    trackBranch = { id: TRACK, projectCwd: 'C:\\p\\demo', worktreePath: worktree, landedAt: '2026-11-04T00:00:00Z' };
    const { flags } = launchFlags(SESSION, worktree, { permissionMode: 'auto', mcpServers: [], access: 'read' }, claudeJson());
    expect(flags).not.toContain('--add-dir');
    expect(existsSync(peerNotesDirFor(TRACK))).toBe(false);
    expect(JSON.parse(readFileSync(peerSettingsPathFor(SESSION), 'utf-8')).permissions.deny).toEqual([`Edit(${permissionRulePath(worktree)}/**)`]);
  });

  it('removes the settings with the session, and the notes with the track', () => {
    launchFlags(SESSION, worktree, { permissionMode: 'auto', mcpServers: [], access: 'read' }, claudeJson());
    deletePromptFile(SESSION);
    expect(existsSync(peerSettingsPathFor(SESSION))).toBe(false);
    expect(existsSync(peerNotesDirFor(TRACK))).toBe(true);
    deletePeerNotes(TRACK);
    expect(existsSync(peerNotesDirFor(TRACK))).toBe(false);
    // Never walks out of peers/.
    expect(() => deletePeerNotes('../..')).not.toThrow();
    expect(existsSync(dataDir)).toBe(true);
  });
});

describe('read-only peers: what the launch reports and how it degrades', () => {
  const TRACK = 'tb-0002';
  afterEach(() => {
    trackBranch = null;
    deletePromptFile(SESSION);
    deletePeerNotes(TRACK);
  });

  it('reports the notes folder it granted, and none for a writer', () => {
    trackBranch = { id: TRACK, projectCwd: 'C:\\p\\demo', worktreePath: worktree, landedAt: null };
    const peer = launchFlags(SESSION, worktree, { permissionMode: 'auto', mcpServers: [], access: 'read' }, claudeJson());
    expect(peer.notesDir).toBe(peerNotesDirFor(TRACK).replace(/\\/g, '/'));
    expect(launchFlags(SESSION, worktree, { permissionMode: 'auto', mcpServers: [] }, claudeJson())).not.toHaveProperty('notesDir');
  });

  it('disallows every file edit, and grants no notes, when a path has no rule form', () => {
    trackBranch = { id: TRACK, projectCwd: '\\\\server\\share\\demo', worktreePath: worktree, landedAt: null };
    const { flags, notesDir } = launchFlags(SESSION, worktree, { permissionMode: 'auto', mcpServers: [], access: 'read' }, claudeJson());
    expect(flags).toBe('--permission-mode auto --strict-mcp-config --disallowedTools Edit Write NotebookEdit --allowedTools WebFetch WebSearch Read ');
    expect(notesDir).toBeNull();
  });
});

describe('deletePeerNotes', () => {
  it('retries a busy folder in the background, and stops once it goes', () => {
    vi.useFakeTimers();
    try {
      const rm = vi.fn()
        .mockImplementationOnce(() => { throw Object.assign(new Error('busy'), { code: 'EBUSY' }); })
        .mockImplementationOnce(() => { throw Object.assign(new Error('busy'), { code: 'EPERM' }); })
        .mockImplementation(() => {});
      deletePeerNotes('tb-busy', { rm, retryMs: 1000, attempts: 5 });
      expect(rm).toHaveBeenCalledTimes(1);
      vi.advanceTimersByTime(1000);
      expect(rm).toHaveBeenCalledTimes(2);
      vi.advanceTimersByTime(1000);
      expect(rm).toHaveBeenCalledTimes(3);
      vi.advanceTimersByTime(10_000);
      expect(rm).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it('gives up after its attempts, and never retries another error', () => {
    vi.useFakeTimers();
    try {
      const busy = vi.fn(() => { throw Object.assign(new Error('busy'), { code: 'EBUSY' }); });
      deletePeerNotes('tb-busy', { rm: busy, retryMs: 1000, attempts: 3 });
      vi.advanceTimersByTime(10_000);
      expect(busy).toHaveBeenCalledTimes(3);
      const denied = vi.fn(() => { throw Object.assign(new Error('nope'), { code: 'EACCES' }); });
      deletePeerNotes('tb-busy', { rm: denied, retryMs: 1000, attempts: 3 });
      vi.advanceTimersByTime(10_000);
      expect(denied).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
