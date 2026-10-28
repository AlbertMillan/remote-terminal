import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

/**
 * Launching under the right login (project/accounts.md, docs/accounts.md): the
 * environment every launch gets, the identity preflight that refuses the wrong
 * login, Clean up, and the watch that flags a session whose login changed.
 * Every folder here is a fixture: nothing reads the real ~/.claude.
 */

const dataDir = mkdtempSync(join(tmpdir(), 'cr-account-launch-'));
// The stand-in home: `work` lives on its default ~/.claude, `personal` on a folder of its own.
const home = join(dataDir, 'home');
const personalDir = join(home, '.claude-personal');
const workDir = join(home, '.claude');
const configPath = join(dataDir, 'config.json');
writeFileSync(
  configPath,
  JSON.stringify({
    persistence: { dataDir },
    accounts: {
      personal: { configDir: personalDir, accountUuid: 'acc-personal' },
      work: { configDir: workDir, organizationUuid: 'org-work' },
      unset: { configDir: join(home, '.claude-unset') },
    },
    defaultAccount: 'personal',
  })
);
process.env.CLAUDE_REMOTE_CONFIG = configPath;

const spawned: { env: Record<string, string> }[] = [];
vi.mock('node-pty', () => ({
  spawn: vi.fn((_shell: string, _args: string[], opts: { env: Record<string, string> }) => {
    spawned.push({ env: opts.env });
    return { pid: 1, onData: vi.fn(), onExit: vi.fn(), write: vi.fn(), resize: vi.fn(), kill: vi.fn() };
  }),
}));

const { loadConfig } = await import('../src/server/config.js');
const accounts = await import('../src/server/accounts.js');
const { createPty } = await import('../src/server/sessions/pty-handler.js');
const { checkSessionAccounts, stopAccountWatch } = await import('../src/server/sessions/account-watch.js');
const { sessionErrorPayload } = await import('../src/server/websocket/handlers/sessions.js');
loadConfig();

afterAll(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

function login(dir: string, oauthAccount: Record<string, string> | null, file = join(dir, '.claude.json')): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(file, JSON.stringify(oauthAccount ? { oauthAccount, projects: {} } : { projects: {} }));
}

beforeEach(() => {
  rmSync(home, { recursive: true, force: true });
  mkdirSync(home, { recursive: true });
  stopAccountWatch();
  accounts.clearIdentityCache();
});

describe('preflight', () => {
  it('passes the expected personal login', () => {
    login(personalDir, { accountUuid: 'acc-personal', organizationUuid: 'org-personal', emailAddress: 'me@home.example' });
    const r = accounts.preflight('personal', home);
    expect(r.ok).toBe(true);
  });

  it('passes the expected org login, read from ~/.claude.json beside the default folder', () => {
    mkdirSync(workDir, { recursive: true });
    login(home, { accountUuid: 'acc-me-at-work', organizationUuid: 'org-work' });
    expect(accounts.preflight('work', home).ok).toBe(true);
  });

  it('refuses a mismatch, naming who is logged in and who is expected', () => {
    login(personalDir, { accountUuid: 'acc-other', organizationUuid: 'org-work', emailAddress: 'me@work.example', organizationName: 'Digital Sun' });
    const r = accounts.preflight('personal', home);
    expect(r).toMatchObject({ ok: false, reason: 'mismatch', found: { emailAddress: 'me@work.example' }, expected: { accountUuid: 'acc-personal' } });
    if (!r.ok) {
      expect(r.message).toContain('me@work.example');
      expect(r.message).toContain('acc-personal');
    }
  });

  it('refuses a folder nobody is logged in to', () => {
    login(personalDir, null);
    expect(accounts.preflight('personal', home)).toMatchObject({ ok: false, reason: 'no-login', found: null });
    rmSync(personalDir, { recursive: true, force: true });
    expect(accounts.preflight('personal', home)).toMatchObject({ ok: false, reason: 'no-login' });
  });

  it('refuses an account with no expected identity configured', () => {
    expect(accounts.preflight('unset', home)).toMatchObject({ ok: false, reason: 'no-expected-identity' });
  });

  it('refuses a personal folder an org login pushed settings into, but not the org account itself', () => {
    login(personalDir, { accountUuid: 'acc-personal' });
    writeFileSync(join(personalDir, 'remote-settings.json'), '{"env":{"CLAUDE_CODE_ENABLE_TELEMETRY":"1"}}');
    const r = accounts.preflight('personal', home);
    expect(r).toMatchObject({ ok: false, reason: 'org-settings', remoteSettings: [join(personalDir, 'remote-settings.json')] });

    mkdirSync(workDir, { recursive: true });
    login(home, { organizationUuid: 'org-work' });
    writeFileSync(join(workDir, 'remote-settings.json'), '{}');
    expect(accounts.preflight('work', home).ok).toBe(true);
  });

  it('reads a .claude.json caught mid-write as the last good login, not as a logout', () => {
    login(personalDir, { accountUuid: 'acc-personal' });
    expect(accounts.preflight('personal', home).ok).toBe(true);
    // Claude Code rewrites the file in place: a read can see half of it.
    writeFileSync(join(personalDir, '.claude.json'), '{"oauthAccount":{"accountUu');
    expect(accounts.preflight('personal', home).ok).toBe(true);
  });

  it('refuses as unreadable, never as no-login, when there is no earlier reading to fall back on', () => {
    mkdirSync(personalDir, { recursive: true });
    writeFileSync(join(personalDir, '.claude.json'), '{"oauthAccount":{"accountUu');
    expect(accounts.preflight('personal', home)).toMatchObject({ ok: false, reason: 'unreadable', found: null });
    expect(() => accounts.readIdentity('personal', home)).toThrow(accounts.IdentityUnreadableError);
  });

  it('parses .claude.json once until it changes', () => {
    login(personalDir, { accountUuid: 'acc-personal' });
    const file = join(personalDir, '.claude.json');
    // A whole-second mtime, so it can be put back exactly.
    const at = new Date('2026-01-01T00:00:00Z');
    utimesSync(file, at, at);
    expect(accounts.readIdentity('personal', home)?.accountUuid).toBe('acc-personal');
    // Same size and mtime: the cached reading answers, the content is not read again.
    writeFileSync(file, JSON.stringify({ oauthAccount: { accountUuid: 'acc-xxxxxxxx' }, projects: {} }));
    utimesSync(file, at, at);
    expect(accounts.readIdentity('personal', home)?.accountUuid).toBe('acc-personal');
    // A real change (here the size) is read.
    login(personalDir, { accountUuid: 'acc-someone-else' });
    expect(accounts.readIdentity('personal', home)?.accountUuid).toBe('acc-someone-else');
  });

  it('assertAccountReady throws the refusal, with status 409', () => {
    login(personalDir, null);
    try {
      accounts.assertAccountReady('personal', home);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(accounts.AccountRefusedError);
      expect((error as InstanceType<typeof accounts.AccountRefusedError>).status).toBe(409);
      expect(sessionErrorPayload(error, 'x')).toMatchObject({ refusal: { reason: 'no-login', account: 'personal' } });
    }
    expect(sessionErrorPayload(new Error('boom'), 'x')).toEqual({ message: 'boom' });
  });
});

describe('Clean up', () => {
  it("deletes the org-pushed settings in a personal folder, and nothing else", () => {
    login(personalDir, { accountUuid: 'acc-personal' });
    writeFileSync(join(personalDir, 'remote-settings.json'), '{}');
    writeFileSync(join(personalDir, 'remote-settings-cache.json'), '{}');
    writeFileSync(join(personalDir, 'settings.json'), '{}');
    expect(accounts.cleanupAccount('personal', home).sort()).toEqual(
      [join(personalDir, 'remote-settings-cache.json'), join(personalDir, 'remote-settings.json')].sort()
    );
    expect(existsSync(join(personalDir, 'settings.json'))).toBe(true);
    expect(accounts.preflight('personal', home).ok).toBe(true);
  });

  it('refuses an org account: its remote settings are its own', () => {
    expect(() => accounts.cleanupAccount('work', home)).toThrow(/organization login/);
  });
});

describe('launch environment', () => {
  const inherited = {
    PATH: 'C:\\bin',
    ANTHROPIC_API_KEY: 'sk-x',
    ANTHROPIC_AUTH_TOKEN: 'tok',
    CLAUDE_CODE_OAUTH_TOKEN: 'oauth',
    CLAUDE_CODE_ENABLE_TELEMETRY: '1',
    OTEL_EXPORTER_OTLP_ENDPOINT: 'https://collector.example',
    Otel_Metrics_Exporter: 'otlp',
    CLAUDE_CONFIG_DIR: 'C:\\elsewhere',
    CLAUDE_CODE_FORCE_SESSION_PERSISTENCE: '1',
  };

  it("strips auth and telemetry overrides and sets the account's CLAUDE_CONFIG_DIR", () => {
    const env = accounts.accountEnv(inherited, 'personal', home);
    expect(env).toEqual({
      PATH: 'C:\\bin',
      CLAUDE_CODE_FORCE_SESSION_PERSISTENCE: '1',
      CLAUDE_CONFIG_DIR: personalDir,
    });
    // Never mutates its input.
    expect(inherited.ANTHROPIC_API_KEY).toBe('sk-x');
  });

  it('leaves CLAUDE_CONFIG_DIR unset for the default ~/.claude, so ~/.claude.json is still read', () => {
    const env = accounts.accountEnv(inherited, 'work', home);
    expect(env).not.toHaveProperty('CLAUDE_CONFIG_DIR');
    expect(env).not.toHaveProperty('OTEL_EXPORTER_OTLP_ENDPOINT');
  });

  it('is what every PTY gets', () => {
    const saved = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = 'sk-inherited';
    try {
      spawned.length = 0;
      createPty({ cwd: dataDir, account: 'personal', env: { CLAUDE_REMOTE_SESSION_ID: 's1' } });
      const env = spawned[0].env;
      expect(env.CLAUDE_CONFIG_DIR).toBe(accounts.configDir('personal'));
      expect(env.ANTHROPIC_API_KEY).toBeUndefined();
      expect(env.CLAUDE_REMOTE_SESSION_ID).toBe('s1');
      expect(env.TERM).toBe('xterm-256color');
    } finally {
      if (saved === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = saved;
    }
  });
});

describe('GET /api/accounts', () => {
  it('says which accounts are ready, without naming a folder or a login', () => {
    login(personalDir, { accountUuid: 'acc-personal', emailAddress: 'me@home.example' });
    const summary = accounts.accountsSummary(home);
    expect(summary.defaultAccount).toBe('personal');
    expect(summary.accounts.map((a) => [a.name, a.ready])).toEqual([
      ['personal', true],
      ['work', false],
      ['unset', false],
    ]);
    const text = JSON.stringify(summary);
    expect(text).not.toContain('.claude');
    expect(text).not.toContain('me@home.example');
    expect(text).not.toContain('acc-personal');
  });
});

describe('the identity watch', () => {
  const sessions = [
    { id: 's1', name: 'one', account: 'personal' },
    { id: 's2', name: 'two', account: 'personal' },
    { id: 's3', name: 'three', account: 'work' },
  ];
  const check = (home_: string) => (account: string) => accounts.preflight(account, home_);

  it('flags every running session on an account whose login changed, once', () => {
    login(personalDir, { accountUuid: 'acc-personal' });
    mkdirSync(workDir, { recursive: true });
    login(home, { organizationUuid: 'org-work' });
    expect(checkSessionAccounts(sessions, check(home))).toEqual({ warnings: {}, flagged: [], changed: false });

    // A `/login` in some session swaps the personal folder's login.
    login(personalDir, { accountUuid: 'acc-other', emailAddress: 'me@work.example' });
    const first = checkSessionAccounts(sessions, check(home));
    expect(first.changed).toBe(true);
    expect(first.flagged.map((f) => f.id)).toEqual(['s1', 's2']);
    expect(Object.keys(first.warnings)).toEqual(['s1', 's2']);
    expect(first.warnings.s1).toContain('me@work.example');

    // Still wrong: no new notification.
    const second = checkSessionAccounts(sessions, check(home));
    expect(second).toMatchObject({ flagged: [], changed: false });

    // Logged back in: the warnings clear.
    login(personalDir, { accountUuid: 'acc-personal' });
    expect(checkSessionAccounts(sessions, check(home))).toEqual({ warnings: {}, flagged: [], changed: true });
  });

  it('neither flags nor clears a session while its account\'s .claude.json cannot be read', () => {
    mkdirSync(personalDir, { recursive: true });
    writeFileSync(join(personalDir, '.claude.json'), '{"oauthAc');
    const personalOnly = sessions.slice(0, 1);
    expect(checkSessionAccounts(personalOnly, check(home))).toEqual({ warnings: {}, flagged: [], changed: false });

    // A real mismatch is flagged, and an unreadable moment after it keeps the warning.
    login(personalDir, { accountUuid: 'acc-other' });
    expect(checkSessionAccounts(personalOnly, check(home)).flagged).toHaveLength(1);
    accounts.clearIdentityCache();
    writeFileSync(join(personalDir, '.claude.json'), '{"oauthAc');
    const during = checkSessionAccounts(personalOnly, check(home));
    expect(during).toMatchObject({ flagged: [], changed: false });
    expect(Object.keys(during.warnings)).toEqual(['s1']);
  });

  it('skips a session whose account was removed from the config', () => {
    const r = checkSessionAccounts([{ id: 'x', name: 'x', account: 'gone' }], check(home));
    expect(r).toEqual({ warnings: {}, flagged: [], changed: false });
  });
});
