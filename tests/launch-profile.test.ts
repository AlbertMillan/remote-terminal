import { describe, it, expect, vi, beforeEach } from 'vitest';
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
vi.mock('../src/server/projects/track-store.js', () => ({
  trackBranchContaining: () => (trackProject ? { projectCwd: trackProject } : null),
}));

import {
  availableMcpServers,
  launchFlags,
  parseMcpServers,
  permissionModeFlag,
} from '../src/server/sessions/launch-profile.js';
import { deletePromptFile, mcpConfigPathFor, promptDirFor } from '../src/server/sessions/prompt-file.js';
import { existsSync } from 'fs';

const SESSION = '33333333-3333-4333-8333-333333333333';
let home: string;
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

    const servers = availableMcpServers(worktree, home);
    expect(servers.get('playwright')).toEqual({ command: 'local-pw' });
    expect(servers.get('slack')).toEqual({ command: 'home-slack' });
    expect(servers.get('github')).toEqual({ command: 'wt-gh' });
    expect(servers.get('everhour')).toEqual({ command: 'eh' });
  });

  it('finds a server in the main checkout\'s .mcp.json from its worktree, which never has it', () => {
    // A start checks names against the main checkout; the launch reads them from the worktree.
    trackProject = project;
    writeJson(join(project, '.mcp.json'), { mcpServers: { unity: { command: 'project-unity' } } });
    expect(availableMcpServers(project, home).get('unity')).toEqual({ command: 'project-unity' });
    expect(availableMcpServers(worktree, home).get('unity')).toEqual({ command: 'project-unity' });
  });

  it('lets the worktree\'s own .mcp.json win, and never lets a shared parent override the project', () => {
    trackProject = project;
    writeJson(join(home, '.mcp.json'), { mcpServers: { unity: { command: 'home' }, slack: { command: 'home-slack' } } });
    writeJson(join(project, '.mcp.json'), { mcpServers: { unity: { command: 'project' }, slack: { command: 'project-slack' } } });
    writeJson(join(worktree, '.mcp.json'), { mcpServers: { slack: { command: 'wt-slack' } } });
    const servers = availableMcpServers(worktree, home);
    // home is in both chains: read once, in the project's, so the project still wins over it.
    expect(servers.get('unity')).toEqual({ command: 'project' });
    expect(servers.get('slack')).toEqual({ command: 'wt-slack' });
  });

  it('never throws on a missing or unreadable ~/.claude.json, and reads it as empty', () => {
    // The walk up from a temp folder can reach a real .mcp.json above it, so compare
    // against that baseline rather than assume none.
    const baseline = [...availableMcpServers(worktree, home).keys()];
    writeFileSync(join(home, '.claude.json'), '{ not json');
    expect([...availableMcpServers(worktree, home).keys()]).toEqual(baseline);
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
    expect(launchFlags(SESSION, worktree, { permissionMode: 'auto', mcpServers: null }, home)).toEqual({
      flags: '--permission-mode auto ',
      mcpServers: null,
    });
    expect(launchFlags(SESSION, worktree, { permissionMode: null, mcpServers: null }, home).flags).toBe('');
  });

  it('gives no MCP servers for an empty list, and types no mode for manual or default', () => {
    expect(launchFlags(SESSION, worktree, { permissionMode: 'manual', mcpServers: [] }, home)).toEqual({
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
    expect(launchFlags(SESSION, worktree, { permissionMode: 'auto', mcpServers: ['gone'] }, home)).toEqual({
      flags: '--permission-mode auto --strict-mcp-config ',
      mcpServers: [],
    });
  });

  it('writes the opted-in servers’ current config beside the prompt folder, never in it or the worktree', () => {
    writeJson(join(home, '.claude.json'), { mcpServers: { playwright: { command: 'npx', env: { KEY: 'k1' } }, everhour: { command: 'eh' } } });

    const { flags, mcpServers } = launchFlags(SESSION, worktree, { permissionMode: 'auto', mcpServers: ['playwright', 'gone'] }, home);

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
    launchFlags(SESSION, worktree, { permissionMode: 'auto', mcpServers: ['playwright'] }, home);
    expect(JSON.parse(readFileSync(path, 'utf-8')).mcpServers.playwright.env.KEY).toBe('k2');

    // Deleted with the session, like its prompt folder.
    deletePromptFile(SESSION);
    expect(existsSync(path)).toBe(false);
  });
});
