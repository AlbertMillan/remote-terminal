import { escapeHtml } from './html-utils.js';

/**
 * The plan-usage chip: how much of each Claude login's 5-hour and weekly
 * windows is used, relayed from Claude Code's status line and verified against
 * the login that sent it. See docs/plan-usage.md.
 *
 * Every configured account gets a line, so one login's numbers are never read
 * as another's. The chip is a <details> element, so opening the breakdown needs
 * no script; polling re-renders only its contents, never the element, so an
 * open popover stays open across refreshes.
 */

/** Mirrors the served window in src/server/usage/plan-routes.ts. */
export interface WindowReading {
  usedPercentage: number;
  /** Unix seconds. */
  resetsAt: number;
  observedAt: string;
}

/** Mirrors WindowTokens in plan-routes.ts: one login's ledger usage in a window. */
export interface WindowTokens {
  messages: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costUsd: number;
  unpriced: boolean;
  sessions: number;
  jobRuns: number;
  elsewhere: number;
  since: string;
  sinceLogin: boolean;
}

/** Mirrors AccountPlanUsage in plan-routes.ts. */
export interface AccountPlanUsage {
  account: string;
  plan?: string | null;
  /** Whether the account's folder holds its expected login now. */
  verified?: boolean;
  snapshot: { fiveHour: WindowReading | null; sevenDay: WindowReading | null } | null;
  /** When the relay last reached the server, limits or not; null if it never has. */
  relaySeenAt?: string | null;
  held?: number;
  running?: number;
  tokens?: { fiveHour: WindowTokens | null; sevenDay: WindowTokens | null } | null;
  /** The current project's jobs run under this account. */
  jobs?: boolean;
  /** `settingsPath`: that account's settings.json, where the status line goes. */
  setup: { command: string | null; settingsPath?: string };
}

export interface PlanUsage {
  /** The attached session's account. */
  attached?: string;
  accounts: AccountPlanUsage[];
}

export type Level = 'ok' | 'warn' | 'danger';

/** Amber from 80 %, red from 95 %: the status line gives no severity of its own. */
export function levelOf(pct: number): Level {
  if (pct >= 95) return 'danger';
  if (pct >= 80) return 'warn';
  return 'ok';
}

/** A reading older than this is shown with its age: usage may have grown since. */
export const STALE_MS = 10 * 60 * 1000;
const POLL_MS = 60 * 1000;
const TICK_MS = 30 * 1000;
/** Account colours (styles.css `--account-0…3`), by position in the config. */
const ACCOUNT_COLOURS = 4;

/** "2h 14m", "3d 4h", "45m" — coarse on purpose; the exact time is beside it. */
export function formatCountdown(ms: number): string {
  const minutes = Math.max(0, Math.round(ms / 60000));
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${minutes % 60}m`;
  return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

/** "950", "12.4k", "3.1M": token counts at a glance. */
export function formatTokens(n: number): string {
  if (n < 1000) return String(Math.round(n));
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
  return `${(n / 1_000_000).toFixed(n < 10_000_000 ? 1 : 0)}M`;
}

export function clock(ms: number, withDay: boolean): string {
  const d = new Date(ms);
  return withDay
    ? d.toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' })
    : d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

/** The class giving an account its colour, by its position in the list. */
export function accountColourClass(index: number): string {
  return `pu-acct-c${index % ACCOUNT_COLOURS}`;
}

interface WindowView {
  label: string;
  short: string;
  /** Null: no verified reading for this window. */
  reading: WindowReading | null;
  /** Past its reset time: the held percentage belongs to a window that is over. */
  reset: boolean;
  level: Level;
}

function viewOf(label: string, short: string, reading: WindowReading | null, now: number): WindowView {
  if (!reading) return { label, short, reading: null, reset: false, level: 'ok' };
  const reset = reading.resetsAt * 1000 <= now;
  return { label, short, reading, reset, level: reset ? 'ok' : levelOf(reading.usedPercentage) };
}

const LEVEL_RANK: Record<Level, number> = { ok: 0, warn: 1, danger: 2 };
const worst = (levels: Level[]): Level => levels.reduce<Level>((w, l) => (LEVEL_RANK[l] > LEVEL_RANK[w] ? l : w), 'ok');

export interface Rendered {
  summary: string;
  body: string;
  level: Level;
  stale: boolean;
}

/** What one account's line and section are made of. */
interface AccountView {
  data: AccountPlanUsage;
  colour: string;
  attached: boolean;
  windows: WindowView[];
  /** Newest observation over its readings, or null without any. */
  latest: number | null;
  state: 'readings' | 'waiting' | 'not-set-up';
}

function accountView(data: AccountPlanUsage, index: number, attached: string | undefined, now: number): AccountView {
  const snap = data.snapshot;
  const windows = [viewOf('5-hour window', '5h', snap?.fiveHour ?? null, now), viewOf('Weekly', 'wk', snap?.sevenDay ?? null, now)];
  const observed = windows.filter((w) => w.reading).map((w) => Date.parse(w.reading!.observedAt) || 0);
  const state = observed.length > 0 ? 'readings' : data.relaySeenAt ? 'waiting' : 'not-set-up';
  return {
    data,
    colour: accountColourClass(index),
    attached: data.account === attached,
    windows,
    latest: observed.length > 0 ? Math.max(...observed) : null,
    state,
  };
}

function windowChip(w: WindowView): string {
  if (!w.reading) return `<span class="pu-window unknown" title="No verified reading">${w.short} ?</span>`;
  return `<span class="pu-window ${w.level}">${w.short} ${w.reset ? 'reset' : `${Math.round(w.reading.usedPercentage)}%`}</span>`;
}

/** One summary line: name, both windows, and whether it is the attached session's. */
function summaryLine(v: AccountView): string {
  const name = `<span class="pu-acct ${v.colour}">${escapeHtml(v.data.account)}</span>`;
  const figures =
    v.state === 'not-set-up'
      ? '<span class="pu-muted">not set up</span>'
      : v.windows.map(windowChip).join('<span class="pu-sep">·</span>');
  const tag = v.attached ? '<span class="pu-tag">attached</span>' : '';
  return `<span class="pu-line">${name}${figures}${tag}</span>`;
}

function windowRow(w: WindowView, now: number): string {
  if (!w.reading) {
    return `
        <div class="pu-row">
          <div class="pu-row-head">
            <span>${escapeHtml(w.label)}</span>
            <span class="pu-pct unknown">?</span>
          </div>
          <div class="pu-bar"></div>
          <div class="pu-detail">No verified reading for this login yet.</div>
        </div>`;
  }
  const resetsMs = w.reading.resetsAt * 1000;
  const weekly = w.short === 'wk';
  const detail = w.reset
    ? `reset at ${clock(resetsMs, weekly)} — no reading since`
    : `resets in ${formatCountdown(resetsMs - now)} (${clock(resetsMs, weekly)})`;
  const pct = w.reset ? 0 : Math.min(100, Math.max(0, w.reading.usedPercentage));
  return `
        <div class="pu-row">
          <div class="pu-row-head">
            <span>${escapeHtml(w.label)}</span>
            <span class="pu-pct ${w.level}">${w.reset ? '—' : `${Math.round(w.reading.usedPercentage)}%`}</span>
          </div>
          <div class="pu-bar"><div class="pu-fill ${w.level}" style="width: ${pct}%"></div></div>
          <div class="pu-detail">${escapeHtml(detail)}</div>
        </div>`;
}

/** "This 5h window: 12 msgs · 3.4k in · 21k out · 1.2M cache read", from the ledger. */
export function tokensLine(t: WindowTokens | null | undefined, label: string): string {
  if (!t) return '';
  const parts = [
    `${t.messages} msg${t.messages === 1 ? '' : 's'}`,
    `${formatTokens(t.inputTokens)} in`,
    `${formatTokens(t.outputTokens)} out`,
    `${formatTokens(t.cacheReadTokens)} cache read`,
  ];
  return `<p class="pu-detail pu-tokens">${escapeHtml(`${label}: ${parts.join(' · ')}`)}</p>`;
}

function setupHint(data: AccountPlanUsage, now: number): string {
  if (data.relaySeenAt) {
    const seen = Date.parse(data.relaySeenAt);
    return (
      `<p class="pu-detail">The status line is set up (last heard from ${escapeHtml(clock(seen, now - seen > 20 * 3600_000))}) ` +
      'but has not sent a verified reading yet. Limits arrive after a Claude Code session answers its ' +
      'first message, and only on a Pro or Max plan.</p>'
    );
  }
  const command = data.setup.command;
  const snippet = command
    ? `<pre class="pu-snippet">${escapeHtml(JSON.stringify({ statusLine: { type: 'command', command } }, null, 2))}</pre>`
    : '<p class="pu-detail">See docs/plan-usage.md in the claude-remote repository.</p>';
  return (
    `<p class="pu-detail">No reading yet. Add this to <code>${escapeHtml(data.setup.settingsPath ?? '~/.claude/settings.json')}</code>; ` +
    'the chip fills in once a Claude Code session has answered a message.</p>' +
    snippet +
    '<p class="pu-detail">Already added? Then the status line cannot reach this server — ' +
    'set <code>CLAUDE_REMOTE_URL</code> if it is not on http://localhost:4220.</p>'
  );
}

/** One account's popover section: plan, verified state, bars, this window's tokens, freshness. */
function section(v: AccountView, now: number): string {
  const d = v.data;
  const tags = [
    d.plan ? `<span class="pu-plan">${escapeHtml(d.plan)}</span>` : '',
    d.verified === false
      ? '<span class="pu-tag warn" title="Its folder does not hold the expected login">login not verified</span>'
      : d.verified
        ? '<span class="pu-tag ok">verified</span>'
        : '',
    v.attached ? '<span class="pu-tag">attached</span>' : '',
    d.jobs ? '<span class="pu-tag" title="This project\'s jobs run under this account">jobs run here</span>' : '',
  ].join('');
  const head = `<div class="pu-section-head"><span class="pu-acct ${v.colour}">${escapeHtml(d.account)}</span>${tags}</div>`;

  let content: string;
  if (v.state === 'readings') {
    const stale = now - (v.latest ?? 0) > STALE_MS;
    const running = d.running ?? 0;
    const asOf =
      `As of ${clock(v.latest ?? now, false)}` +
      (stale ? ` (${formatCountdown(now - (v.latest ?? now))} ago)` : '') +
      ` · ${running} running session${running === 1 ? '' : 's'}`;
    content =
      v.windows.map((w) => windowRow(w, now)).join('') +
      tokensLine(d.tokens?.fiveHour, 'This 5h window') +
      `<p class="pu-foot${stale ? ' stale' : ''}">${escapeHtml(asOf)}</p>`;
  } else {
    content = setupHint(d, now);
  }
  const held = d.held
    ? `<p class="pu-detail pu-held">${d.held} reading${d.held === 1 ? '' : 's'} held back (not this login's, or unverified)</p>`
    : '';
  return `<section class="pu-section">${head}${content}${held}</section>`;
}

/** The chip's summary lines and popover for `data` at time `now`. Pure, for tests. */
export function renderPlanUsage(data: PlanUsage, now: number): Rendered {
  const views = data.accounts.map((a, i) => accountView(a, i, data.attached, now));
  const level = worst(views.flatMap((v) => v.windows.map((w) => w.level)));
  // Dimmed only when every account with readings is stale: one fresh line is news.
  const withReadings = views.filter((v) => v.latest !== null);
  const stale = withReadings.length > 0 && withReadings.every((v) => now - (v.latest ?? 0) > STALE_MS);

  const summary =
    views.length > 0 ? views.map(summaryLine).join('') : '<span class="pu-label">Plan usage</span> <span class="pu-muted">no accounts</span>';
  const body =
    views.map((v) => section(v, now)).join('') +
    '<p class="pu-foot">Readings arrive while a Claude Code session is open; job runs do not send them.</p>' +
    '<button type="button" class="pu-breakdown" data-action="account-usage">Per-account breakdown →</button>';
  return { summary, body, level, stale };
}

/**
 * A response from a server that predates every-account readings: one account's
 * fields at the top level. Read as a one-account list, so a stale tab and a new
 * server (or the reverse, during a restart) still show something true.
 */
function normalise(raw: unknown): PlanUsage | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Partial<PlanUsage> & Partial<AccountPlanUsage>;
  if (Array.isArray(r.accounts)) return { attached: r.attached, accounts: r.accounts };
  if (!r.setup) return null;
  return {
    attached: r.account,
    accounts: [{ account: r.account ?? 'default', snapshot: r.snapshot ?? null, relaySeenAt: r.relaySeenAt, setup: r.setup }],
  };
}

/** Polls the server and keeps the sidebar chip current. */
export class PlanUsageChip {
  private data: PlanUsage | null = null;
  private pollTimer: number | null = null;
  private tickTimer: number | null = null;
  /** Kept so detach() can remove exactly what attach() added. */
  private readonly onFocus = () => void this.refresh();
  private readonly onVisibility = () => {
    if (document.visibilityState === 'visible') void this.refresh();
  };
  private readonly onClick = (event: MouseEvent) => {
    const target = (event.target as HTMLElement | null)?.closest?.('[data-action="account-usage"]');
    if (!target) return;
    event.preventDefault();
    this.openBreakdown?.();
  };

  /** Opens the per-account usage page; set by the owner (session-manager). */
  openBreakdown: (() => void) | null = null;
  /** Called after every render — a poll or a countdown tick — so an open usage page keeps up. */
  onRender: ((data: PlanUsage, now: number) => void) | null = null;

  /** Wire up the static markup and start polling. Safe to call once. */
  attach(): void {
    const root = document.getElementById('plan-usage');
    if (!root) return;
    root.addEventListener('click', this.onClick);
    void this.refresh();
    // A hidden tab skips its polls and catches up the moment it is shown.
    this.pollTimer = window.setInterval(() => {
      if (document.visibilityState !== 'hidden') void this.refresh();
    }, POLL_MS);
    // Countdowns and staleness move without a new reading.
    this.tickTimer = window.setInterval(() => this.render(), TICK_MS);
    window.addEventListener('focus', this.onFocus);
    document.addEventListener('visibilitychange', this.onVisibility);
  }

  detach(): void {
    if (this.pollTimer !== null) window.clearInterval(this.pollTimer);
    if (this.tickTimer !== null) window.clearInterval(this.tickTimer);
    this.pollTimer = this.tickTimer = null;
    document.getElementById('plan-usage')?.removeEventListener('click', this.onClick);
    window.removeEventListener('focus', this.onFocus);
    document.removeEventListener('visibilitychange', this.onVisibility);
  }

  /** The attached session's account and folder: tagged "attached", and whose project's jobs to mark. */
  private account: string | null = null;
  private cwd: string | null = null;

  setAccount(account: string | null | undefined, cwd?: string | null): void {
    const next = account ?? null;
    const nextCwd = cwd ?? null;
    if (next === this.account && nextCwd === this.cwd) return;
    this.account = next;
    this.cwd = nextCwd;
    void this.refresh();
  }

  /** The last data fetched, for the usage page to open with. */
  latest(): PlanUsage | null {
    return this.data;
  }

  async refresh(): Promise<void> {
    try {
      const query = [
        this.account ? `account=${encodeURIComponent(this.account)}` : '',
        this.cwd ? `cwd=${encodeURIComponent(this.cwd)}` : '',
      ]
        .filter(Boolean)
        .join('&');
      const res = await fetch(query ? `/api/plan-usage?${query}` : '/api/plan-usage');
      if (!res.ok) return;
      const data = normalise(await res.json());
      if (!data) return;
      this.data = data;
      this.render();
    } catch {
      // Keep the last rendering; the next poll tries again.
    }
  }

  render(now = Date.now()): void {
    const root = document.getElementById('plan-usage');
    if (!root || !this.data) return;
    const view = renderPlanUsage(this.data, now);
    const summary = root.querySelector('.plan-usage-summary');
    const body = root.querySelector('.plan-usage-body');
    if (summary) summary.innerHTML = view.summary;
    if (body) body.innerHTML = view.body;
    root.dataset.level = view.level;
    root.classList.toggle('stale', view.stale);
    root.hidden = false;
    this.onRender?.(this.data, now);
  }
}
