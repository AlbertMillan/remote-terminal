import { describe, it, expect } from 'vitest';
import {
  INHERITED_CLAUDE_SESSION_VARS,
  inheritedClaudeSessionVars,
  scrubProcessEnv,
  withoutInheritedClaudeSession,
} from '../src/server/utils/claude-env.js';

/**
 * A server started from inside a claude-remote terminal inherits that
 * conversation's environment. The env of this very session, as observed when the
 * bug was found.
 */
function inheritedEnv(): Record<string, string | undefined> {
  return {
    CLAUDE_CODE_CHILD_SESSION: '1',
    CLAUDECODE: '1',
    CLAUDE_CODE_SESSION_ID: '1fa051ae-1306-4524-bd57-7d8c7ce73cf5',
    CLAUDE_CODE_ENTRYPOINT: 'cli',
    CLAUDE_CODE_SESSION_ATTENDED: '1',
    CLAUDE_CODE_MESSAGING_SOCKET: '\\\\.\\pipe\\LOCAL\\cc-msg-37ca189e',
    CLAUDE_CODE_MESSAGING_TOKEN: 'c84e8b9293be35a5',
    CLAUDE_PID: '22976',
    CLAUDE_EFFORT: 'high',
    AI_AGENT: 'claude-code_2-1-270_agent',
    // Not markers: the user's own settings and PATH entries.
    CLAUDE: 'C:\\Users\\Albert\\.local\\bin',
    CLAUDE_CODE_EXECPATH: 'C:\\Users\\Albert\\.local\\bin\\claude.exe',
    ANTHROPIC_API_KEY: 'sk-test',
    CLAUDE_CONFIG_DIR: 'C:\\Users\\Albert\\.claude',
    PATH: '/usr/bin',
  };
}

describe('withoutInheritedClaudeSession', () => {
  it('drops the marker that turns transcript saving off', () => {
    const clean = withoutInheritedClaudeSession(inheritedEnv());
    expect(clean.CLAUDE_CODE_CHILD_SESSION).toBeUndefined();
    expect('CLAUDE_CODE_CHILD_SESSION' in clean).toBe(false);
  });

  it('drops every session-scoped marker', () => {
    const clean = withoutInheritedClaudeSession(inheritedEnv());
    for (const key of INHERITED_CLAUDE_SESSION_VARS) {
      expect(clean[key], `${key} should have been stripped`).toBeUndefined();
    }
  });

  it('keeps the user\'s own configuration', () => {
    const clean = withoutInheritedClaudeSession(inheritedEnv());
    expect(clean.CLAUDE).toBe('C:\\Users\\Albert\\.local\\bin');
    expect(clean.CLAUDE_CODE_EXECPATH).toBe('C:\\Users\\Albert\\.local\\bin\\claude.exe');
    expect(clean.ANTHROPIC_API_KEY).toBe('sk-test');
    expect(clean.CLAUDE_CONFIG_DIR).toBe('C:\\Users\\Albert\\.claude');
    expect(clean.PATH).toBe('/usr/bin');
  });

  it('does not mutate the environment it was given', () => {
    const env = inheritedEnv();
    withoutInheritedClaudeSession(env);
    expect(env.CLAUDE_CODE_CHILD_SESSION).toBe('1');
  });

  it('is a no-op on an environment that never saw a parent session', () => {
    const env = { PATH: '/usr/bin', HOME: '/home/albert' };
    expect(withoutInheritedClaudeSession(env)).toEqual(env);
  });
});

describe('scrubProcessEnv', () => {
  it('removes the markers in place and reports what was there', () => {
    const env = inheritedEnv() as NodeJS.ProcessEnv;
    const found = scrubProcessEnv(env);

    expect(found).toContain('CLAUDE_CODE_CHILD_SESSION');
    expect(found.sort()).toEqual([...INHERITED_CLAUDE_SESSION_VARS].sort());
    expect(env.CLAUDE_CODE_CHILD_SESSION).toBeUndefined();
    expect(env.PATH).toBe('/usr/bin');
  });

  it('reports nothing when the server was started cleanly', () => {
    // An empty result is what says "not launched from inside a session" -- the
    // server logs the difference, so it must not cry wolf.
    const env = { PATH: '/usr/bin' } as NodeJS.ProcessEnv;
    expect(scrubProcessEnv(env)).toEqual([]);
  });

  it('only reports markers that were actually set', () => {
    const env = { CLAUDE_CODE_CHILD_SESSION: '1', PATH: '/usr/bin' } as NodeJS.ProcessEnv;
    expect(inheritedClaudeSessionVars(env)).toEqual(['CLAUDE_CODE_CHILD_SESSION']);
    expect(scrubProcessEnv(env)).toEqual(['CLAUDE_CODE_CHILD_SESSION']);
  });
});
