import type { AccountIdentity, AccountRefusal } from './session-types.js';

/**
 * The dialog for a launch the account preflight refused (docs/accounts.md): who
 * is logged in to the account's folder against who is expected, with **Log in**
 * (an interactive `claude` in that folder, where the user runs `/login`) and,
 * for an account that expects no organization, **Clean up** (delete the
 * org-pushed settings first, then the same Log in session, where the user runs
 * `/logout` then `/login`). The original start is retried once that session exits.
 */

export interface AccountRefusalHost {
  /** Open the Log in session; `retry` runs once it exits. */
  logIn(account: string, cleanup: boolean, retry: () => void): void;
}

function describeIdentity(identity: AccountIdentity | null): string {
  if (!identity) return 'Nobody is logged in';
  const who = identity.emailAddress ?? identity.accountUuid ?? 'an unknown login';
  const org = identity.organizationName ?? identity.organizationUuid;
  return org ? `${who} — ${org}` : who;
}

function describeExpected(expected: AccountRefusal['expected']): string {
  if (expected.accountUuid) return `account ${expected.accountUuid}`;
  if (expected.organizationUuid) return `organization ${expected.organizationUuid}`;
  return 'nothing set — add accountUuid or organizationUuid to config.json';
}

/** Clean up applies only to an account that expects no organization (personal). */
export function canCleanUp(refusal: AccountRefusal): boolean {
  return !refusal.expected.organizationUuid;
}

export class AccountRefusalModal {
  private modal: HTMLElement | null = null;

  constructor(
    private readonly host: AccountRefusalHost,
    private readonly doc: Document = document
  ) {}

  show(refusal: AccountRefusal, retry: () => void): void {
    this.hide();
    const doc = this.doc;
    const modal = doc.createElement('div');
    modal.className = 'modal account-refusal-modal';
    const content = doc.createElement('div');
    content.className = 'modal-content';

    const title = doc.createElement('h3');
    title.textContent = `Not started: account "${refusal.account}"`;
    const message = doc.createElement('p');
    message.textContent = refusal.message;

    const detail = doc.createElement('dl');
    detail.className = 'account-refusal-detail';
    const row = (label: string, value: string) => {
      const dt = doc.createElement('dt');
      dt.textContent = label;
      const dd = doc.createElement('dd');
      dd.textContent = value;
      detail.append(dt, dd);
    };
    row('Logged in', describeIdentity(refusal.found));
    row('Expected', describeExpected(refusal.expected));
    row('Folder', refusal.configDir);
    if (refusal.remoteSettings?.length) row('Org-pushed settings', refusal.remoteSettings.join(', '));

    const actions = doc.createElement('div');
    actions.className = 'modal-actions';
    const button = (label: string, cls: string, onClick: () => void) => {
      const b = doc.createElement('button');
      b.type = 'button';
      b.className = cls;
      b.textContent = label;
      b.addEventListener('click', onClick);
      actions.append(b);
      return b;
    };
    button('Cancel', 'btn-secondary account-refusal-cancel', () => this.hide());
    if (canCleanUp(refusal)) {
      const cleanup = button('Clean up', 'btn-secondary account-refusal-cleanup', () => {
        this.hide();
        this.host.logIn(refusal.account, true, retry);
      });
      cleanup.title = 'Delete the org-pushed settings in this folder, then log in: run /logout, then /login with the right account';
    }
    const login = button('Log in', 'btn-primary account-refusal-login', () => {
      this.hide();
      this.host.logIn(refusal.account, false, retry);
    });
    login.title = 'Open claude in this account’s folder: run /login, then exit; the start is tried again';

    content.append(title, message, detail, actions);
    modal.append(content);
    modal.addEventListener('click', (e) => {
      if (e.target === modal) this.hide();
    });
    doc.body.append(modal);
    this.modal = modal;
  }

  hide(): void {
    this.modal?.remove();
    this.modal = null;
  }
}
