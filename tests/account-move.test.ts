import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

/**
 * Moving a session's conversation to another account (project/move-conversation-account.md):
 * the checks made before anything stops, and the transcript move itself, failures included.
 */

// Lets a test fail one rename or delete; every other call is the real one.
type Fs = typeof import('fs');
const fsHooks: { rename?: (from: string, to: string) => void; rm?: (path: string) => void } = {};
vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<Fs>();
  return {
    ...actual,
    renameSync: (from: string, to: string) => {
      fsHooks.rename?.(from, to);
      return actual.renameSync(from, to);
    },
    rmSync: (path: string, options?: Parameters<Fs['rmSync']>[1]) => {
      fsHooks.rm?.(path);
      return actual.rmSync(path, options);
    },
  };
});
const fail = (code: string) => Object.assign(new Error(code), { code });

const dataDir = mkdtempSync(join(tmpdir(), 'cr-account-move-'));
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

const { loadConfig } = await import('../src/server/config.js');
const { changeAccountRefusal, moveBlockedReason, moveTranscript } = await import('../src/server/sessions/account-move.js');
const { accountColourClass, nextMenuIndex } = await import('../src/client/account-menu.js');

const ID = '8d99bf6a-5e32-47cc-8273-7a0f9cb52220';
const cwd = join(dataDir, 'project');
// Claude's own folder name for a cwd, as findClaudeProjectDir computes it first.
const slug = cwd.replace(/[:\\/]/g, '-').replace(/^-+/, '');
const projectDir = (account: string) => join(dataDir, `claude-${account}`, 'projects', slug);

beforeAll(() => {
  loadConfig();
  mkdirSync(cwd, { recursive: true });
});

afterAll(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

describe('the checks before anything stops', () => {
  const row = { account: 'work', claudeSessionId: ID, isFork: false, spawnedBy: null };

  it('lets a plain session with a conversation move to another known account', () => {
    expect(moveBlockedReason(row)).toBeNull();
    expect(changeAccountRefusal(row, 'personal', 0)).toBeNull();
  });

  it('refuses an unknown account, or the one it already has', () => {
    expect(changeAccountRefusal(row, 'nope', 0)).toMatch(/Unknown account/);
    expect(changeAccountRefusal(row, 'work', 0)).toMatch(/already runs under work/);
  });

  it('never moves a fork, a started session, or a session with no conversation: the chip says why', () => {
    expect(moveBlockedReason({ ...row, isFork: true })).toMatch(/fork/);
    expect(moveBlockedReason({ ...row, spawnedBy: 'parent' })).toMatch(/started it/);
    expect(moveBlockedReason({ ...row, claudeSessionId: null })).toMatch(/No Claude conversation/);
    expect(changeAccountRefusal({ ...row, isFork: true }, 'personal', 0)).toMatch(/fork/);
  });

  it('refuses a parent with running started sessions at move time only', () => {
    expect(changeAccountRefusal(row, 'personal', 2)).toMatch(/2 running started sessions/);
  });
});

describe('moveTranscript', () => {
  beforeEach(() => {
    delete fsHooks.rename;
    delete fsHooks.rm;
    rmSync(join(dataDir, 'claude-personal'), { recursive: true, force: true });
    rmSync(join(dataDir, 'claude-work'), { recursive: true, force: true });
    mkdirSync(projectDir('work'), { recursive: true });
    writeFileSync(join(projectDir('work'), `${ID}.jsonl`), '{"type":"user"}\n');
  });

  it('moves the transcript and its subagent folder into the same project folder', async () => {
    mkdirSync(join(projectDir('work'), ID, 'subagents'), { recursive: true });
    writeFileSync(join(projectDir('work'), ID, 'subagents', 'a.jsonl'), 'sub');
    const moved = await moveTranscript(cwd, ID, 'work', 'personal');
    expect(moved).toEqual({ fromDir: projectDir('work'), toDir: projectDir('personal') });
    expect(readFileSync(join(projectDir('personal'), `${ID}.jsonl`), 'utf8')).toBe('{"type":"user"}\n');
    expect(readFileSync(join(projectDir('personal'), ID, 'subagents', 'a.jsonl'), 'utf8')).toBe('sub');
    expect(existsSync(join(projectDir('work'), `${ID}.jsonl`))).toBe(false);
    expect(existsSync(join(projectDir('work'), ID))).toBe(false);
  });

  it('only repoints when the transcript is already in the target', async () => {
    expect(await moveTranscript(cwd, ID, 'personal', 'work')).toBeNull();
    expect(existsSync(join(projectDir('work'), `${ID}.jsonl`))).toBe(true);
  });

  it('refuses anything but a conversation id, before touching a path', async () => {
    for (const bad of ['..', '../..', 'abc', `${ID}/..`]) {
      await expect(moveTranscript(cwd, bad, 'work', 'personal')).rejects.toThrow(/Not a conversation id/);
    }
    expect(existsSync(join(projectDir('work'), `${ID}.jsonl`))).toBe(true);
  });

  it('never overwrites, and puts the transcript back when its folder cannot follow', async () => {
    mkdirSync(join(projectDir('work'), ID), { recursive: true });
    mkdirSync(join(projectDir('personal'), ID), { recursive: true }); // in the way
    await expect(moveTranscript(cwd, ID, 'work', 'personal')).rejects.toThrow(/already exists/);
    expect(existsSync(join(projectDir('work'), `${ID}.jsonl`))).toBe(true);
    expect(existsSync(join(projectDir('personal'), `${ID}.jsonl`))).toBe(false);
  });

  it('names where the transcript is when putting it back fails too', async () => {
    mkdirSync(join(projectDir('work'), ID), { recursive: true });
    let renames = 0;
    fsHooks.rename = () => {
      renames++;
      if (renames === 2) throw fail('EIO'); // the subagent folder
      if (renames === 3) throw fail('EIO'); // the rollback
    };
    await expect(moveTranscript(cwd, ID, 'work', 'personal')).rejects.toThrow(
      /EIO; the transcript could not be put back and is at .*claude-personal/
    );
    expect(existsSync(join(projectDir('personal'), `${ID}.jsonl`))).toBe(true);
  });

  it('copies across volumes, then deletes the source', async () => {
    fsHooks.rename = () => {
      throw fail('EXDEV');
    };
    await moveTranscript(cwd, ID, 'work', 'personal');
    expect(readFileSync(join(projectDir('personal'), `${ID}.jsonl`), 'utf8')).toBe('{"type":"user"}\n');
    expect(existsSync(join(projectDir('work'), `${ID}.jsonl`))).toBe(false);
  });

  it('removes its copy when the source cannot be deleted, so the next move can run', async () => {
    fsHooks.rename = () => {
      throw fail('EXDEV');
    };
    const source = join(projectDir('work'), `${ID}.jsonl`);
    fsHooks.rm = (path) => {
      if (path === source) throw fail('EIO');
    };
    await expect(moveTranscript(cwd, ID, 'work', 'personal')).rejects.toThrow(/EIO/);
    expect(existsSync(source)).toBe(true);
    expect(existsSync(join(projectDir('personal'), `${ID}.jsonl`))).toBe(false);

    delete fsHooks.rm;
    await moveTranscript(cwd, ID, 'work', 'personal');
    expect(existsSync(join(projectDir('personal'), `${ID}.jsonl`))).toBe(true);
  });

  it('throws when no account has the transcript', async () => {
    await expect(moveTranscript(cwd, '00000000-0000-0000-0000-000000000000', 'work', 'personal')).rejects.toThrow(
      /not found/
    );
  });
});

describe('the header chip (client)', () => {
  it('colours the dot by the account’s place in the config', () => {
    expect(accountColourClass(['personal', 'work'], 'work')).toBe(' acct-c1');
    expect(accountColourClass(['personal', 'work'], 'gone')).toBe('');
  });

  it('moves through the menu with the arrow keys, wrapping', () => {
    expect(nextMenuIndex(-1, 3, 'ArrowDown')).toBe(0);
    expect(nextMenuIndex(-1, 3, 'ArrowUp')).toBe(2);
    expect(nextMenuIndex(2, 3, 'ArrowDown')).toBe(0);
    expect(nextMenuIndex(0, 3, 'ArrowUp')).toBe(2);
    expect(nextMenuIndex(1, 3, 'Home')).toBe(0);
    expect(nextMenuIndex(1, 3, 'End')).toBe(2);
    expect(nextMenuIndex(0, 0, 'ArrowDown')).toBe(-1);
  });
});
