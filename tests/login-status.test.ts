import { describe, it, expect, beforeEach } from 'vitest';
import {
  accountLoginInfo,
  clearLoginStatus,
  loginState,
  parseAuthStatus,
  refreshLoginStatus,
  setAuthStatusRunner,
  type AuthStatus,
} from '../src/server/usage/login-status.js';

/**
 * When an account's claude.ai login ends (project/login-expiry.md). The answer
 * comes from `claude auth status`; what matters is that the thresholds are right
 * and that a failed check never turns a working login into "logged out".
 */

const NOW = Date.parse('2026-11-25T12:00:00Z');
const H = 3600_000;
const D = 24 * H;
const endsIn = (ms: number): AuthStatus => ({ loggedIn: true, loginExpiresAt: new Date(NOW + ms).toISOString() });

describe('loginState', () => {
  it('maps the time left onto the chip states', () => {
    expect(loginState(endsIn(10 * D), NOW).state).toBe('ok');
    expect(loginState(endsIn(7 * D), NOW).state).toBe('ending');
    expect(loginState(endsIn(3 * D), NOW).state).toBe('ending');
    expect(loginState(endsIn(23 * H), NOW).state).toBe('ends-today');
    expect(loginState(endsIn(-1), NOW).state).toBe('logged-out');
  });

  it('is logged out when the CLI says so, and unknown before any answer', () => {
    expect(loginState({ loggedIn: false, loginExpiresAt: null }, NOW)).toEqual({ state: 'logged-out', endsAt: null });
    expect(loginState(null, NOW)).toEqual({ state: 'unknown', endsAt: null });
  });

  it('is ok with no end date to go on', () => {
    expect(loginState({ loggedIn: true, loginExpiresAt: null }, NOW)).toEqual({ state: 'ok', endsAt: null });
  });
});

describe('parseAuthStatus', () => {
  it('reads the JSON claude auth status prints, ignoring anything around it', () => {
    const out = 'warning: something\n{\n  "loggedIn": true,\n  "loginExpiresAt": "2026-12-05T16:47:36.940Z",\n  "email": "x"\n}\n';
    expect(parseAuthStatus(out)).toEqual({ loggedIn: true, loginExpiresAt: '2026-12-05T16:47:36.940Z' });
    expect(parseAuthStatus('{"loggedIn": false, "loginExpiresAt": null}')).toEqual({ loggedIn: false, loginExpiresAt: null });
  });

  it('refuses anything else', () => {
    expect(parseAuthStatus('')).toBeNull();
    expect(parseAuthStatus('Not logged in')).toBeNull();
    expect(parseAuthStatus('{"loggedIn": "yes"}')).toBeNull();
    expect(parseAuthStatus('{broken')).toBeNull();
  });
});

describe('the cached check', () => {
  beforeEach(() => clearLoginStatus());

  it('serves unknown until the first check answers, then its answer', async () => {
    let calls = 0;
    setAuthStatusRunner(async () => {
      calls++;
      return endsIn(3 * D);
    });
    expect(accountLoginInfo('work', NOW).state).toBe('unknown');
    await refreshLoginStatus('work', NOW);
    expect(accountLoginInfo('work', NOW).state).toBe('ending');
    expect(calls).toBe(1);
  });

  it('keeps the last answer when a check fails', async () => {
    let next: AuthStatus | null | Error = endsIn(10 * D);
    setAuthStatusRunner(async () => {
      if (next instanceof Error) throw next;
      return next;
    });
    await refreshLoginStatus('work', NOW);
    next = null; // no JSON, non-zero exit, timeout
    await refreshLoginStatus('work', NOW + 20 * 60_000);
    expect(accountLoginInfo('work', NOW + 20 * 60_000).state).toBe('ok');
    next = new Error('spawn ENOENT');
    await refreshLoginStatus('work', NOW + 40 * 60_000);
    expect(accountLoginInfo('work', NOW + 40 * 60_000).state).toBe('ok');
  });

  it('re-checks an ok login after 15 minutes, a logged-out one after a minute', async () => {
    const seen: string[] = [];
    setAuthStatusRunner(async (account) => {
      seen.push(account);
      return account === 'work' ? endsIn(10 * D) : { loggedIn: false, loginExpiresAt: null };
    });
    await refreshLoginStatus('work', NOW);
    await refreshLoginStatus('personal', NOW);
    seen.length = 0;

    accountLoginInfo('work', NOW + 2 * 60_000);
    accountLoginInfo('personal', NOW + 2 * 60_000);
    expect(seen).toEqual(['personal']);

    accountLoginInfo('work', NOW + 16 * 60_000);
    expect(seen).toContain('work');
  });

  it('runs one check at a time per account', async () => {
    let calls = 0;
    let release!: () => void;
    setAuthStatusRunner(
      () =>
        new Promise((resolve) => {
          calls++;
          release = () => resolve(endsIn(10 * D));
        })
    );
    const first = refreshLoginStatus('work', NOW);
    const second = refreshLoginStatus('work', NOW);
    accountLoginInfo('work', NOW);
    release();
    await Promise.all([first, second]);
    expect(calls).toBe(1);
  });
});
