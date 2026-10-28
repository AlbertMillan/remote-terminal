import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

/**
 * Claude accounts (project/accounts.md, docs/accounts.md): the config that
 * defines them, which account a new session gets, and the migration that makes
 * every session from before accounts `personal`.
 */

const dataDir = mkdtempSync(join(tmpdir(), 'cr-accounts-'));
const configPath = join(dataDir, 'config.json');
writeFileSync(
  configPath,
  JSON.stringify({
    persistence: { dataDir },
    accounts: {
      personal: { configDir: join(dataDir, 'claude-personal'), accountUuid: 'acc-personal' },
      work: { configDir: join(dataDir, 'claude-work'), organizationUuid: 'org-work' },
    },
    defaultAccount: 'personal',
  })
);
process.env.CLAUDE_REMOTE_CONFIG = configPath;

const { loadConfig, getConfig, accountConfigProblems } = await import('../src/server/config.js');
const accounts = await import('../src/server/accounts.js');
const { initDatabase, closeDatabase, getDatabase } = await import('../src/server/db/schema.js');
const { accountForTranscript, getSession } = await import('../src/server/db/queries.js');

beforeAll(() => {
  loadConfig();
});

afterAll(() => {
  closeDatabase();
  rmSync(dataDir, { recursive: true, force: true });
});

describe('config', () => {
  it('takes the accounts as written, not merged with the defaults', () => {
    expect(Object.keys(getConfig().accounts)).toEqual(['personal', 'work']);
    expect(getConfig().accounts.work.configDir).toBe(join(dataDir, 'claude-work'));
  });

  it('accepts accounts with exactly one identity field and a known default', () => {
    expect(accountConfigProblems(getConfig())).toEqual([]);
  });

  it('names a configDir that is a file, or whose parent is missing', () => {
    writeFileSync(join(dataDir, 'claude-personal'), 'not a folder');
    try {
      expect(accounts.accountProblems()).toEqual([expect.stringContaining('accounts.personal: configDir')]);
    } finally {
      rmSync(join(dataDir, 'claude-personal'), { force: true });
    }
    // claude-work doesn't exist yet but could be created: fine.
    expect(accounts.accountProblems()).toEqual([]);
  });

  it('names an account with no identity, or both, and an unknown default', () => {
    const problems = accountConfigProblems({
      accounts: {
        a: { configDir: '~/.a' },
        b: { configDir: '~/.b', accountUuid: 'x', organizationUuid: 'y' },
        c: { configDir: '' },
      },
      defaultAccount: 'z',
    });
    expect(problems).toEqual([
      expect.stringContaining('accounts.a: set exactly one'),
      expect.stringContaining('accounts.b: set exactly one'),
      'accounts.c: configDir is required',
      expect.stringContaining('defaultAccount "z"'),
    ]);
  });
});

describe('which account a session starts under', () => {
  const registry = join(dataDir, 'projects.json');
  beforeEach(() => rmSync(registry, { force: true }));

  it('is personal by default', () => {
    expect(accounts.defaultAccount()).toBe('personal');
    expect(accounts.resolveStartAccount(undefined, 'C:\\p\\demo')).toBe('personal');
  });

  it('is the one the start names', () => {
    expect(accounts.resolveStartAccount('work', 'C:\\p\\demo')).toBe('work');
  });

  it('refuses an account the config does not define, rather than using another', () => {
    expect(() => accounts.resolveStartAccount('nobody')).toThrow(accounts.UnknownAccountError);
  });

  it("is the project's stored default when the start names none, most specific project first", () => {
    writeFileSync(
      registry,
      JSON.stringify({
        projects: [
          { cwd: 'C:\\p', account: 'personal' },
          { cwd: 'C:\\p\\demo', account: 'work' },
          { cwd: 'C:\\q', account: 'nobody' },
        ],
      })
    );
    expect(accounts.resolveStartAccount(undefined, 'c:\\p\\demo\\sub')).toBe('work');
    expect(accounts.resolveStartAccount(undefined, 'C:\\p\\other')).toBe('personal');
    // An unknown name in projects.json is ignored, not fatal.
    expect(accounts.resolveStartAccount(undefined, 'C:\\q')).toBe('personal');
    // The start still wins over the project.
    expect(accounts.resolveStartAccount('personal', 'C:\\p\\demo')).toBe('personal');
  });

  it('expands ~ against the home folder', () => {
    expect(accounts.expandHome('~/.claude-personal', 'C:\\Users\\me')).toBe(join('C:\\Users\\me', '.claude-personal'));
    expect(accounts.expandHome('~', 'C:\\Users\\me')).toBe('C:\\Users\\me');
  });
});

describe('migration 019_session_account', () => {
  it('backfills every session from before accounts to personal', () => {
    initDatabase();
    const db = getDatabase();
    // Wind the schema back to before the migration, with rows of that era.
    db.exec(`ALTER TABLE sessions DROP COLUMN account; DELETE FROM migrations WHERE name = '019_session_account';`);
    const insert = db.prepare(
      `INSERT INTO sessions (id, name, shell, cwd, created_at, last_accessed_at, status, cols, rows, sort_order, claude_session_id)
       VALUES (?, ?, 'pwsh', 'C:\\p', '2026-10-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z', 'idle', 80, 24, 0, ?)`
    );
    insert.run('old-1', 'one', 'T1');
    insert.run('old-2', 'two', null);
    closeDatabase();

    initDatabase();
    expect(getSession('old-1')!.account).toBe('personal');
    expect(getSession('old-2')!.account).toBe('personal');
    expect(accountForTranscript('T1')).toBe('personal');
    expect(accountForTranscript('never-ran')).toBeNull();
    // Not null after the migration.
    expect(() => getDatabase().prepare(`UPDATE sessions SET account = NULL WHERE id = 'old-1'`).run()).toThrow(/NOT NULL/);
  });
});
