import { escapeAttr, escapeHtml } from './html-utils.js';
import {
  accountColourClass,
  clock,
  formatCountdown,
  formatTokens,
  levelOf,
  type AccountPlanUsage,
  type PlanUsage,
  type WindowReading,
  type WindowTokens,
} from './plan-usage-chip.js';

/**
 * The account usage page, opened from the plan-usage chip's "Per-account
 * breakdown →" (docs/plan-usage.md): one card per Claude login with both
 * windows, its ledger tokens for this 5-hour window and this week, and the
 * readings held back because they could not be verified as that login's, each
 * with Discard. The structure is static in index.html (`#account-usage-modal`);
 * this fills its cards and table.
 */

/** Mirrors HeldReading in src/server/usage/plan-limits.ts. */
export interface HeldReading {
  id: string;
  account: string | null;
  window: 'fiveHour' | 'sevenDay';
  usedPercentage: number;
  resetsAt: number;
  arrivedAt: string;
  reason: string;
}

/** Why a reading was held back, in plain words. */
export const HELD_REASONS: Record<string, string> = {
  'login-mismatch': 'its folder holds another login than this account expects',
  'session-flagged': 'its session started before a /login swap, so it may run the old login',
  'no-login': 'nobody to verify it against: no login, or no expected identity in config.json',
  'unknown-folder': 'sent from a folder no account uses',
  'unverified-legacy': 'saved before readings were verified',
};

function bigWindow(label: string, reading: WindowReading | null, now: number): string {
  if (!reading) {
    return `<div class="au-window"><div class="au-window-label">${label}</div><div class="au-window-pct unknown">?</div><div class="pu-detail">no verified reading</div></div>`;
  }
  const resetsMs = reading.resetsAt * 1000;
  const reset = resetsMs <= now;
  const level = reset ? 'ok' : levelOf(reading.usedPercentage);
  const detail = reset ? `reset at ${clock(resetsMs, true)}` : `resets in ${formatCountdown(resetsMs - now)} (${clock(resetsMs, true)})`;
  const pct = reset ? 0 : Math.min(100, Math.max(0, reading.usedPercentage));
  return (
    `<div class="au-window"><div class="au-window-label">${label}</div>` +
    `<div class="au-window-pct ${level}">${reset ? '—' : `${Math.round(reading.usedPercentage)}%`}</div>` +
    `<div class="pu-bar"><div class="pu-fill ${level}" style="width: ${pct}%"></div></div>` +
    `<div class="pu-detail">${escapeHtml(detail)}</div></div>`
  );
}

/** The token table: this 5-hour window and this week (or since login), side by side. */
function tokenTable(five: WindowTokens | null | undefined, week: WindowTokens | null | undefined): string {
  if (!five && !week) return '<p class="pu-detail">No ledger usage for an open window.</p>';
  const weekLabel = week?.sinceLogin ? 'Since login' : 'This week';
  const cell = (t: WindowTokens | null | undefined, pick: (t: WindowTokens) => string) => `<td>${t ? escapeHtml(pick(t)) : '—'}</td>`;
  const row = (label: string, pick: (t: WindowTokens) => string) => `<tr><th>${label}</th>${cell(five, pick)}${cell(week, pick)}</tr>`;
  return (
    '<div class="account-usage-scroll"><table class="account-usage-table au-tokens">' +
    `<thead><tr><th></th><th>This 5h window</th><th>${weekLabel}</th></tr></thead><tbody>` +
    row('Messages', (t) => String(t.messages)) +
    row('Input', (t) => formatTokens(t.inputTokens)) +
    row('Output', (t) => formatTokens(t.outputTokens)) +
    row('Cache read', (t) => formatTokens(t.cacheReadTokens)) +
    row('Cache write', (t) => formatTokens(t.cacheWriteTokens)) +
    row('Est. cost', (t) => `$${t.costUsd.toFixed(2)}${t.unpriced ? '+' : ''}`) +
    row('Sessions', (t) => String(t.sessions)) +
    row('Job runs', (t) => String(t.jobRuns)) +
    '</tbody></table></div>' +
    '<p class="pu-detail">Est. at API list price; from the transcripts of projects with a PROJECT.md.</p>'
  );
}

function card(a: AccountPlanUsage, index: number, attached: string | undefined, now: number): string {
  const tags = [
    a.plan ? `<span class="pu-plan">${escapeHtml(a.plan)}</span>` : '',
    a.verified === false
      ? '<span class="pu-tag warn">login not verified</span>'
      : a.verified
        ? '<span class="pu-tag ok">verified</span>'
        : '',
    a.account === attached ? '<span class="pu-tag">attached</span>' : '',
    a.jobs ? '<span class="pu-tag">jobs run here</span>' : '',
  ].join('');
  const week = a.tokens?.sevenDay;
  const moved =
    week && week.elsewhere > 0
      ? `<p class="pu-detail">${week.elsewhere} of ${week.messages} messages ${week.sinceLogin ? 'since login' : 'this week'} sit in another account's folder (moved transcripts).</p>`
      : '';
  const running = a.running ?? 0;
  return (
    `<article class="au-card" data-account="${escapeAttr(a.account)}">` +
    `<div class="pu-section-head"><span class="pu-acct ${accountColourClass(index)}">${escapeHtml(a.account)}</span>${tags}</div>` +
    `<div class="au-windows">${bigWindow('5-hour window', a.snapshot?.fiveHour ?? null, now)}${bigWindow('Weekly', a.snapshot?.sevenDay ?? null, now)}</div>` +
    tokenTable(a.tokens?.fiveHour, week) +
    moved +
    `<p class="pu-detail">${running} running session${running === 1 ? '' : 's'}</p>` +
    '</article>'
  );
}

/** Every account's card. Pure, for tests. */
export function renderAccountCards(data: PlanUsage, now: number): string {
  if (data.accounts.length === 0) return '<p class="pu-detail">No accounts are configured.</p>';
  return data.accounts.map((a, i) => card(a, i, data.attached, now)).join('');
}

/** The held-back table's rows. Pure, for tests. */
export function renderHeldRows(held: HeldReading[]): string {
  return held
    .map((h) => {
      const window = h.window === 'fiveHour' ? '5h' : 'wk';
      const reset = clock(h.resetsAt * 1000, true);
      const arrived = Date.parse(h.arrivedAt);
      return (
        `<tr><td>${escapeHtml(Number.isNaN(arrived) ? '?' : clock(arrived, true))}</td>` +
        `<td>${h.account ? escapeHtml(h.account) : '<span class="pu-muted">no account</span>'}</td>` +
        `<td>${escapeHtml(`${window} → ${reset}`)}</td>` +
        `<td>${Math.round(h.usedPercentage)}%</td>` +
        `<td>${escapeHtml(HELD_REASONS[h.reason] ?? h.reason)}</td>` +
        `<td><button type="button" class="btn-secondary au-discard" data-held-id="${escapeAttr(h.id)}">Discard</button></td></tr>`
      );
    })
    .join('');
}

export class AccountUsageModal {
  private data: PlanUsage | null = null;
  private held: HeldReading[] = [];

  /** `onChange`: a held-back reading was discarded (the chip's counts moved). */
  constructor(
    private readonly onChange: () => void = () => {},
    private readonly doc: Document = document
  ) {}

  private get root(): HTMLElement | null {
    return this.doc.getElementById('account-usage-modal');
  }

  private wired = false;

  private wire(root: HTMLElement): void {
    if (this.wired) return;
    this.wired = true;
    root.addEventListener('click', (event: MouseEvent) => {
      const target = event.target as HTMLElement;
      if (target === root || target.closest('.account-usage-close')) {
        this.close();
        return;
      }
      const discard = target.closest('.au-discard') as HTMLElement | null;
      if (discard?.dataset.heldId) void this.discard(discard.dataset.heldId);
    });
    this.doc.addEventListener('keydown', (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !root.classList.contains('hidden')) this.close();
    });
  }

  /** Show the page for `data` (the chip's last answer), then load what is held back. */
  async open(data: PlanUsage | null): Promise<void> {
    const root = this.root;
    if (!root) return;
    this.wire(root);
    this.data = data;
    this.render();
    root.classList.remove('hidden');
    await this.loadHeld();
  }

  close(): void {
    this.root?.classList.add('hidden');
  }

  private isOpen(): boolean {
    const root = this.root;
    return !!root && !root.classList.contains('hidden');
  }

  /**
   * The chip's latest answer (every poll) or a countdown tick: refresh the cards
   * of an open page. The held-back table is left alone — it has its own source,
   * and rebuilding it under the pointer would swallow a Discard click.
   */
  update(data: PlanUsage, now = Date.now()): void {
    if (!this.isOpen()) return;
    this.data = data;
    this.renderCards(now);
  }

  private async loadHeld(): Promise<void> {
    try {
      const res = await fetch('/api/plan-usage/held');
      if (!res.ok) return;
      const body = (await res.json()) as { held?: HeldReading[] };
      this.held = Array.isArray(body.held) ? body.held : [];
      this.render();
    } catch {
      // Keep what is shown.
    }
  }

  private async discard(id: string): Promise<void> {
    try {
      await fetch('/api/plan-usage/held/discard', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id }),
      });
    } catch {
      // The reload below shows whether it went.
    }
    await this.loadHeld();
    this.onChange();
  }

  render(now = Date.now()): void {
    const root = this.root;
    if (!root) return;
    this.renderCards(now);
    const section = root.querySelector('.account-usage-held') as HTMLElement | null;
    const body = root.querySelector('.account-usage-held tbody');
    if (body) body.innerHTML = renderHeldRows(this.held);
    if (section) section.hidden = this.held.length === 0;
  }

  private renderCards(now: number): void {
    const cards = this.root?.querySelector('.account-usage-cards');
    if (cards) cards.innerHTML = this.data ? renderAccountCards(this.data, now) : '<p class="pu-detail">Loading…</p>';
  }
}
