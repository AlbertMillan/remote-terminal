import { html, setHtml, type SafeHtml } from './html-utils.js';
import type { SessionInfo } from './session-types.js';

/**
 * The session header's account chip and its dropdown: move the open session's conversation
 * to another Claude account (project/move-conversation-account.md). Whether a session can
 * move comes from the server (`SessionInfo.accountMoveBlocked`); this never re-derives it.
 */

/** One account, as GET /api/accounts lists it. */
export interface AccountChoice {
  name: string;
  /** Its folder holds the expected login (preflight passes). */
  ready: boolean;
}

/** A session with a live shell: moving it stops it and resumes it. */
export function isRunningSession(session: SessionInfo): boolean {
  return session.attachable && session.status !== 'terminated';
}

/** The account-dot colour class, by position in the config (as the sidebar's dots). */
export function accountColourClass(order: string[], account: string | undefined): string {
  const index = account ? order.indexOf(account) : -1;
  return index >= 0 ? ` acct-c${index % 4}` : '';
}

/** The next item for an arrow key, wrapping; -1 → the first. */
export function nextMenuIndex(current: number, count: number, key: 'ArrowDown' | 'ArrowUp' | 'Home' | 'End'): number {
  if (count === 0) return -1;
  if (key === 'Home') return 0;
  if (key === 'End') return count - 1;
  if (current < 0) return key === 'ArrowDown' ? 0 : count - 1;
  return (current + (key === 'ArrowDown' ? 1 : -1) + count) % count;
}

type Phase = { kind: 'closed' } | { kind: 'list' } | { kind: 'confirm'; target: string } | { kind: 'moving'; target: string };

export interface AccountMenuHost {
  /** The session on screen. */
  current(): SessionInfo | undefined;
  /** Send session.changeAccount. */
  move(sessionId: string, account: string): void;
}

export class AccountMenu {
  private accounts: AccountChoice[] = [];
  private phase: Phase = { kind: 'closed' };
  // What was last drawn: the sidebar re-renders on every broadcast (the name poll every 5 s),
  // and redrawing an unchanged menu would throw away the keyboard focus inside it.
  private chipHtml = '';
  private menuHtml = '';

  constructor(
    private host: AccountMenuHost,
    private chip: HTMLButtonElement,
    private menu: HTMLElement
  ) {
    chip.addEventListener('click', (e) => {
      e.stopPropagation();
      if (this.phase.kind === 'moving') return;
      this.setPhase(this.phase.kind === 'closed' ? { kind: 'list' } : { kind: 'closed' });
      if (this.phase.kind === 'list') {
        this.focusItem(0);
        void this.load();
      }
    });
    menu.addEventListener('click', (e) => {
      e.stopPropagation();
      const el = (e.target as HTMLElement).closest<HTMLElement>('[data-action]');
      if (!el) return;
      const session = this.host.current();
      const action = el.dataset.action;
      if (action === 'pick' && el.dataset.account) {
        this.setPhase({ kind: 'confirm', target: el.dataset.account });
        this.focusItem(-1);
      } else if (action === 'back') {
        this.setPhase({ kind: 'list' });
        this.focusItem(0);
      } else if (action === 'confirm' && session && this.phase.kind === 'confirm') {
        const target = this.phase.target;
        this.setPhase({ kind: 'moving', target });
        this.host.move(session.id, target);
      }
    });
    menu.addEventListener('keydown', (e) => {
      if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp' && e.key !== 'Home' && e.key !== 'End') return;
      e.preventDefault();
      const items = this.items();
      this.focusItem(nextMenuIndex(items.indexOf(document.activeElement as HTMLElement), items.length, e.key));
    });
    document.addEventListener('click', () => {
      if (this.phase.kind === 'list' || this.phase.kind === 'confirm') this.setPhase({ kind: 'closed' });
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && (this.phase.kind === 'list' || this.phase.kind === 'confirm')) {
        this.setPhase({ kind: 'closed' });
        this.chip.focus();
      }
    });
    void this.load();
  }

  /** Re-read the accounts (names, order, logged in): on open and on every reconnect. */
  async load(): Promise<void> {
    try {
      const res = await fetch('/api/accounts');
      if (!res.ok) return;
      const data = (await res.json()) as { accounts?: AccountChoice[] };
      this.accounts = (data.accounts ?? []).map((a) => ({ name: a.name, ready: !!a.ready }));
    } catch {
      return; // keep what we had: the chip still names the account
    }
    this.update();
  }

  /** The session on screen changed (switched, renamed, moved): redraw the chip. */
  update(): void {
    const session = this.host.current();
    const show = !!session?.account && this.accounts.length > 1;
    this.chip.classList.toggle('hidden', !show);
    if (!session || !show) {
      if (this.phase.kind !== 'moving') this.setPhase({ kind: 'closed' });
      return;
    }
    const blocked = session.accountMoveBlocked ?? null;
    const order = this.accounts.map((a) => a.name);
    const chip = html`<span class="session-account-dot${accountColourClass(order, session.account)}" aria-hidden="true"></span><span>${session.account ?? ''}</span>${!blocked && html`<span class="account-chip-caret" aria-hidden="true">▾</span>`}`;
    if (chip.value !== this.chipHtml) {
      this.chipHtml = chip.value;
      setHtml(this.chip, chip);
    }
    this.chip.disabled = !!blocked;
    this.chip.title = blocked ? `${session.account}: ${blocked}` : 'Claude account: move this conversation to another';
    if (blocked && this.phase.kind !== 'moving') this.setPhase({ kind: 'closed' });
    else this.render();
  }

  /** The move was answered (moved, refused, failed) or will never be (socket closed). */
  finished(): void {
    this.setPhase({ kind: 'closed' });
    this.update();
  }

  private setPhase(phase: Phase): void {
    this.phase = phase;
    this.chip.setAttribute('aria-expanded', String(phase.kind !== 'closed'));
    this.render();
  }

  private items(): HTMLElement[] {
    return [...this.menu.querySelectorAll<HTMLElement>('button:not(:disabled)')];
  }

  /** Focus the item at `index` (-1: the last, the confirm step's main button). */
  private focusItem(index: number): void {
    const items = this.items();
    items[index < 0 ? items.length - 1 : index]?.focus();
  }

  private render(): void {
    const session = this.host.current();
    const body = this.phase.kind === 'closed' || !session ? html`` : this.menuBody(session);
    if (body.value === this.menuHtml) return;
    this.menuHtml = body.value;
    this.menu.classList.toggle('hidden', !body.value);
    setHtml(this.menu, body);
  }

  private menuBody(session: SessionInfo): SafeHtml {
    const order = this.accounts.map((a) => a.name);
    const dot = (name: string) => html`<span class="session-account-dot${accountColourClass(order, name)}" aria-hidden="true"></span>`;
    const running = isRunningSession(session);
    let body = html``;
    if (this.phase.kind === 'list') {
      const items = this.accounts.map((a) => {
        if (a.name === session.account) {
          return html`<div class="account-menu-item current" role="menuitemradio" aria-checked="true" aria-disabled="true">${dot(a.name)}<span class="account-menu-name">${a.name}</span><span class="account-menu-note">current</span></div>`;
        }
        const note = a.ready ? 'logged in' : 'not logged in';
        return html`<button type="button" class="account-menu-item" role="menuitemradio" aria-checked="false" data-action="pick" data-account="${a.name}">${dot(a.name)}<span class="account-menu-name">Move to ${a.name}</span><span class="account-menu-note${a.ready ? ' ready' : ''}">${note}</span></button>`;
      });
      body = html`${items}<p class="account-menu-hint">The conversation goes with it: same session, same history, the other login.</p>`;
    } else if (this.phase.kind === 'confirm') {
      const t = this.phase.target;
      const explain = running
        ? html`The terminal stops, the transcript moves into ${t}’s folder, and the session resumes in place with <code>claude --resume</code>.`
        : html`The transcript moves into ${t}’s folder. The session stays stopped; Resume opens it under ${t}.`;
      body = html`<div class="account-menu-confirm"><strong>Move to ${t}?</strong><p>${explain}</p>${running && html`<p class="account-menu-warn">If Claude is in the middle of a turn, that turn is cut off.</p>`}<div class="account-menu-actions"><button type="button" class="btn btn-secondary" data-action="back">Back</button><button type="button" class="btn btn-primary" data-action="confirm">${running ? 'Move and resume' : 'Move'}</button></div></div>`;
    } else if (this.phase.kind === 'moving') {
      const t = this.phase.target;
      body = html`<div class="account-menu-moving" role="status"><span class="account-menu-spinner" aria-hidden="true"></span>${running ? `Stopping, moving to ${t} and resuming…` : `Moving to ${t}…`}</div>`;
    }
    return html`<div class="account-menu-title">Claude account</div>${body}`;
  }
}
