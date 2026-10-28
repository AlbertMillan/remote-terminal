// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { AccountRefusalModal, LoginRetries } from '../src/client/account-refusal-modal.js';
import { accountOptionsHtml } from '../src/client/new-session-modal.js';
import type { AccountRefusal } from '../src/client/session-types.js';

/**
 * A launch refused by the account preflight (docs/accounts.md): the dialog says
 * who is logged in against who is expected, and offers Log in — and Clean up for
 * an account that expects no organization. The refused launch is handed on, to
 * be retried once the Log in session exits.
 */

const MISMATCH: AccountRefusal = {
  ok: false,
  account: 'personal',
  configDir: 'C:\\Users\\me\\.claude-personal',
  reason: 'mismatch',
  found: { emailAddress: 'me@work.example', organizationName: 'Digital Sun' },
  expected: { accountUuid: 'acc-personal' },
  message: 'Account "personal" is logged in as me@work.example (Digital Sun), but expects account acc-personal',
};

beforeEach(() => {
  document.body.innerHTML = '';
});

describe('AccountRefusalModal', () => {
  it('shows found against expected and the folder', () => {
    new AccountRefusalModal({ logIn: vi.fn() }).show(MISMATCH, vi.fn());
    const text = document.querySelector('.account-refusal-modal')!.textContent!;
    expect(text).toContain('me@work.example — Digital Sun');
    expect(text).toContain('account acc-personal');
    expect(text).toContain('C:\\Users\\me\\.claude-personal');
  });

  it('Log in opens the login session with the refused launch to retry, and closes', () => {
    const logIn = vi.fn();
    const retry = vi.fn();
    new AccountRefusalModal({ logIn }).show(MISMATCH, retry);
    (document.querySelector('.account-refusal-login') as HTMLButtonElement).click();
    expect(logIn).toHaveBeenCalledWith('personal', false, retry);
    expect(document.querySelector('.account-refusal-modal')).toBeNull();
  });

  it('Clean up logs in after deleting the org settings; an org account gets no Clean up', () => {
    const logIn = vi.fn();
    const modal = new AccountRefusalModal({ logIn });
    modal.show(MISMATCH, vi.fn());
    (document.querySelector('.account-refusal-cleanup') as HTMLButtonElement).click();
    expect(logIn).toHaveBeenCalledWith('personal', true, expect.any(Function));

    modal.show({ ...MISMATCH, account: 'work', expected: { organizationUuid: 'org-1' } }, vi.fn());
    expect(document.querySelector('.account-refusal-cleanup')).toBeNull();
  });

  it('says nobody is logged in for a folder without a login', () => {
    new AccountRefusalModal({ logIn: vi.fn() }).show({ ...MISMATCH, reason: 'no-login', found: null }, vi.fn());
    expect(document.querySelector('.account-refusal-modal')!.textContent).toContain('Nobody is logged in');
  });

  it('offers Try again, not Log in or Clean up, for a .claude.json caught mid-write', () => {
    const logIn = vi.fn();
    const retry = vi.fn();
    new AccountRefusalModal({ logIn }).show({ ...MISMATCH, reason: 'unreadable', found: null }, retry);
    expect(document.querySelector('.account-refusal-login')).toBeNull();
    expect(document.querySelector('.account-refusal-cleanup')).toBeNull();
    (document.querySelector('.account-refusal-retry') as HTMLButtonElement).click();
    expect(retry).toHaveBeenCalledOnce();
    expect(logIn).not.toHaveBeenCalled();
    expect(document.querySelector('.account-refusal-modal')).toBeNull();
  });
});

describe('LoginRetries', () => {
  it('retries the refused launch once its Log in session ends, whichever session is shown by then', () => {
    const retries = new LoginRetries();
    const retry = vi.fn();
    retries.requested('m1', retry);
    retries.ended('login-1'); // not known as a Log in session yet
    expect(retry).not.toHaveBeenCalled();

    retries.created('m1', 'login-1');
    retries.ended('login-1');
    expect(retry).toHaveBeenCalledOnce();
    retries.ended('login-1');
    expect(retry).toHaveBeenCalledOnce();
  });

  it('drops the retry when the Log in session could not be created', () => {
    const retries = new LoginRetries();
    const retry = vi.fn();
    retries.requested('m1', retry);
    retries.failed('m1');
    retries.created('m1', 'login-1');
    retries.ended('login-1');
    expect(retry).not.toHaveBeenCalled();
  });

  it('ignores the answer to any other launch', () => {
    const retries = new LoginRetries();
    retries.created('m-other', 's-other');
    expect(() => retries.ended('s-other')).not.toThrow();
  });
});

describe('account picker options', () => {
  it('lets the server pick by default, and marks an account on the wrong login', () => {
    const html = accountOptionsHtml({
      defaultAccount: 'personal',
      accounts: [
        { name: 'personal', configDir: 'a', ready: true },
        { name: 'work', configDir: 'b', ready: false },
      ],
    });
    document.body.innerHTML = `<select>${html}</select>`;
    const options = [...document.querySelectorAll('option')].map((o) => [o.value, o.textContent]);
    expect(options).toEqual([
      ['', "Default (project's, else personal)"],
      ['personal', 'personal'],
      ['work', 'work — not logged in as expected'],
    ]);
  });
});
