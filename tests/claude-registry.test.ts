import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { readClaudeNames } from '../src/server/sessions/claude-registry.js';
import { claudeNameFlag } from '../src/server/sessions/session-open.js';

describe('claudeNameFlag', () => {
  it('quotes a plain name', () => {
    expect(claudeNameFlag('planner')).toBe(' --name "planner"');
    expect(claudeNameFlag('  Fork: Split view ')).toBe(' --name "Fork: Split view"');
  });

  it('omits a name no shell quotes safely, rather than break the command', () => {
    for (const name of ['say "hi"', '$HOME', '100%', 'a`b', 'wow!', 'C:\\x', 'two\nlines']) {
      expect(claudeNameFlag(name)).toBe('');
    }
  });

  it('omits an empty name', () => {
    expect(claudeNameFlag('')).toBe('');
    expect(claudeNameFlag('   ')).toBe('');
    expect(claudeNameFlag(null)).toBe('');
  });
});

describe('readClaudeNames', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cr-claude-registry-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const entry = (pid: number, sessionId: string, name: string) =>
    writeFileSync(join(dir, `${pid}.json`), JSON.stringify({ pid, sessionId, name, nameSource: 'derived', status: 'idle' }));

  it('maps each live session id to its name', () => {
    entry(1, 'aaa', 'rimworldy-ae');
    entry(2, 'bbb', 'planner');
    const names = readClaudeNames(dir, () => true);
    expect(Object.fromEntries(names)).toEqual({ aaa: 'rimworldy-ae', bbb: 'planner' });
  });

  it('skips an entry whose process is gone', () => {
    entry(1, 'aaa', 'alive');
    entry(2, 'bbb', 'killed');
    expect([...readClaudeNames(dir, (pid) => pid === 1).values()]).toEqual(['alive']);
  });

  it('skips malformed files and other files, and never throws', () => {
    entry(1, 'aaa', 'ok');
    writeFileSync(join(dir, '2.json'), '{ half-written');
    writeFileSync(join(dir, '3.json'), JSON.stringify({ pid: '3', sessionId: 'ccc', name: 'bad pid' }));
    writeFileSync(join(dir, '4.json'), JSON.stringify({ pid: 4, sessionId: 'ddd' }));
    writeFileSync(join(dir, '5.abc.key'), '{"peerToken":"x"}');
    expect(Object.fromEntries(readClaudeNames(dir, () => true))).toEqual({ aaa: 'ok' });
  });

  it('returns nothing for a missing folder', () => {
    expect(readClaudeNames(join(dir, 'nope'), () => true).size).toBe(0);
  });
});
