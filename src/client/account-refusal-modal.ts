import type { AccountIdentity, AccountRefusal } from './session-types.js';

/**
 * The dialog for a launch the account preflight refused (docs/accounts.md): who
 * is logged in to the account's folder against who is expected, with **Log in**
 * (an interactive `claude` in that folder, where the user runs `/login`) and,
 * for an account that expects no organization, **Clean up** (delete the
 * org-pushed settings first, then the same Log in session, where the user runs
 * `/logout` then `/login`). The original start is retried once that session exits.
 */

/**
 * The refused launch waiting on a Log in session: keyed by the `session.create`
 * message id until the server answers, then by the new session's id until
 * `session.loginEnded`. Each retry runs at most once.
 */
export class LoginRetries {
  private byMessage = new Map<string, () => void>();
  private bySession = new Map<string, () => void>();

  /** A Log in `session.create` went out as `messageId`. */
  requested(messageId: string, retry: () => void): void {
    this.byMessage.set(messageId, retry);
  }

  /** The server answered `messageId` with `sessionId`. A no-op for any other launch. */
  created(messageId: string, sessionId: string): void {
    const retry = this.byMessage.get(messageId);
    if (!retry) return;
    this.byMessage.delete(messageId);
    this.bySession.set(sessionId, retry);
  }

  /** `messageId` failed: no Log in session, nothing to retry. */
  failed(messageId: string): void {
    this.byMessage.delete(messageId);
  }

  /** The Log in session `sessionId` exited: run its retry, once. */
  ended(sessionId: string): void {
    const retry = this.bySession.get(sessionId);
    if (!retry) return;
    this.bySession.delete(sessionId);
    retry();
  }
}

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
  return refusal.reason !== 'unreadable' && !refusal.expected.organizationUuid;
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
    if (refusal.reason === 'unreadable') {
      // Its .claude.json was caught mid-write: the login is likely fine.
      button('Try again', 'btn-primary account-refusal-retry', () => {
        this.hide();
        retry();
      });
    } else {
      const login = button('Log in', 'btn-primary account-refusal-login', () => {
        this.hide();
        this.host.logIn(refusal.account, false, retry);
      });
      login.title = 'Open claude in this account’s folder: run /login, then exit; the start is tried again';
    }

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
