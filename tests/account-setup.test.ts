import { describe, it, expect } from 'vitest';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { makeTmpDataDir } from './helpers/tmp-data-dir.js';
// @ts-expect-error -- a plain .mjs script with no type declarations
import { main, mergeSetup } from '../scripts/install-account-setup.mjs';

/**
 * Per-account setup (docs/accounts.md): each account's `claude` reads only its own
 * settings.json, so claude-remote's hooks and status line are copied into every
 * account's, and the server names any account that lacks them. Fixtures only.
 */

const SESSION_HOOK = {
  hooks: [{ type: 'command', command: '[ -n "$CLAUDE_REMOTE_SESSION_ID" ] && curl -s -X POST "http://localhost:4220/api/session/$CLAUDE_REMOTE_SESSION_ID/claude-session"' }],
};
const STOP_HOOK = {
  hooks: [{ type: 'command', command: '[ -n "$CLAUDE_REMOTE_SESSION_ID" ] && curl -s -X POST "http://localhost:4220/api/notify/$CLAUDE_REMOTE_SESSION_ID/completed"' }],
};
const NOTIFY_HOOK = {
  matcher: 'permission_prompt|idle_prompt',
  hooks: [{ type: 'command', command: '[ -n "$CLAUDE_REMOTE_SESSION_ID" ] && curl -s -X POST "http://localhost:4220/api/notify/$CLAUDE_REMOTE_SESSION_ID/needs-input"' }],
};
const MINE = { hooks: [{ type: 'command', command: 'node "$HOME/.claude/scripts/hooks/observe.js"' }] };
const STATUS = { type: 'command', command: 'node "C:/repo/scripts/statusline.mjs"' };
const WORK_SETTINGS = {
  model: 'opus',
  hooks: { SessionStart: [SESSION_HOOK, MINE], Stop: [SESSION_HOOK, STOP_HOOK], Notification: [NOTIFY_HOOK] },
  statusLine: STATUS,
};

describe('mergeSetup', () => {
  it("copies claude-remote's hooks and status line, and nothing of the user's own", () => {
    const { merged, added } = mergeSetup(WORK_SETTINGS, { theme: 'dark' });
    expect(merged).toEqual({
      theme: 'dark',
      hooks: { SessionStart: [SESSION_HOOK], Stop: [SESSION_HOOK, STOP_HOOK], Notification: [NOTIFY_HOOK] },
      statusLine: STATUS,
    });
    expect(added).toContain('statusLine');
    expect(merged).not.toHaveProperty('model');
  });

  it('adds nothing twice, keeps the target’s hooks, and never replaces its status line', () => {
    const target = { hooks: { SessionStart: [SESSION_HOOK, { hooks: [{ type: 'command', command: 'echo mine' }] }] }, statusLine: { type: 'command', command: 'my-line' } };
    const { merged, skipped } = mergeSetup(WORK_SETTINGS, target);
    expect(merged.hooks.SessionStart).toHaveLength(2);
    expect(merged.statusLine).toEqual({ type: 'command', command: 'my-line' });
    expect(skipped[0]).toMatch(/^statusLine/);
    expect(mergeSetup(WORK_SETTINGS, merged).added).toEqual([]);
  });
});

describe('install-account-setup.mjs', () => {
  it('writes the target, keeping a backup, and is a no-op the second time', () => {
    const dir = makeTmpDataDir('account-setup');
    const from = join(dir, 'work', 'settings.json');
    const to = join(dir, 'personal', 'settings.json');
    mkdirSync(join(dir, 'work'));
    mkdirSync(join(dir, 'personal'));
    writeFileSync(from, JSON.stringify(WORK_SETTINGS));
    writeFileSync(to, JSON.stringify({ theme: 'dark' }));
    const log: string[] = [];
    expect(main(['--from', from, '--to', to], (s: string) => log.push(s))).toBe(0);
    expect(JSON.parse(readFileSync(to, 'utf-8')).statusLine).toEqual(STATUS);
    expect(JSON.parse(readFileSync(`${to}.bak`, 'utf-8'))).toEqual({ theme: 'dark' });
    expect(main(['--from', from, '--to', to], (s: string) => log.push(s))).toBe(0);
    expect(log[log.length - 1]).toMatch(/already set up/);
  });

  it('changes nothing on --dry-run, and creates a missing target folder otherwise', () => {
    const dir = makeTmpDataDir('account-setup-dry');
    const from = join(dir, 'settings.json');
    writeFileSync(from, JSON.stringify(WORK_SETTINGS));
    const to = join(dir, 'new-account', 'settings.json');
    expect(main(['--from', from, '--to', to, '--dry-run'], () => {})).toBe(0);
    expect(existsSync(to)).toBe(false);
    expect(main(['--from', from, '--to', to], () => {})).toBe(0);
    expect(existsSync(to)).toBe(true);
  });

  it('prints usage without both paths', () => {
    const log: string[] = [];
    expect(main(['--from', 'x'], (s: string) => log.push(s))).toBe(2);
    expect(log[0]).toMatch(/^usage/);
  });
});

describe('accountSetupMissing', () => {
  it("names what an account's settings.json lacks, and nothing once it has it all", async () => {
    const dir = makeTmpDataDir('account-setup-check');
    const configPath = join(dir, 'config.json');
    const personal = join(dir, 'personal');
    writeFileSync(configPath, JSON.stringify({ persistence: { dataDir: dir }, accounts: { personal: { configDir: personal, accountUuid: 'a' } }, defaultAccount: 'personal' }));
    process.env.CLAUDE_REMOTE_CONFIG = configPath;
    const { loadConfig } = await import('../src/server/config.js');
    const { accountSetupMissing } = await import('../src/server/accounts.js');
    loadConfig();
    expect(accountSetupMissing('personal')).toEqual([
      'SessionStart claude-session hook',
      'Stop notification hook',
      'Notification hook',
      'plan-usage statusLine',
    ]);
    mkdirSync(personal);
    writeFileSync(join(personal, 'settings.json'), JSON.stringify(mergeSetup(WORK_SETTINGS, {}).merged));
    expect(accountSetupMissing('personal')).toEqual([]);
  });
});
