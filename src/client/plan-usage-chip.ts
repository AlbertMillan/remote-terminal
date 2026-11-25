import { html, joinHtml, setHtml, type SafeHtml } from './html-utils.js';
import { formatTokens } from './format.js';
import { openDialog } from './dialog.js';
import { BrowserNotifier } from './browser-notifier.js';

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
  /** When its claude.ai login ends (src/server/usage/login-status.ts); absent from an older server. */
  login?: LoginInfo;
}

/** Mirrors LoginInfo in src/server/usage/login-status.ts. */
export interface LoginInfo {
  state: 'ok' | 'ending' | 'ends-today' | 'logged-out' | 'unknown';
  endsAt: string | null;
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
  summary: SafeHtml;
  body: SafeHtml;
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

function windowChip(w: WindowView): SafeHtml {
  if (!w.reading) return html`<span class="pu-window unknown" title="No verified reading">${w.short} ?</span>`;
  return html`<span class="pu-window ${w.level}">${w.short} ${w.reset ? 'reset' : `${Math.round(w.reading.usedPercentage)}%`}</span>`;
}

const DAY_MS = 24 * 3600_000;
/** The one reminder fires this long before a login ends (project/login-expiry.md). */
export const REMINDER_MS = 3 * DAY_MS;

/** A login's colour: amber within 7 days, red under a day or logged out. */
export function loginLevel(login: LoginInfo | undefined): Level {
  if (login?.state === 'ending') return 'warn';
  if (login?.state === 'ends-today' || login?.state === 'logged-out') return 'danger';
  return 'ok';
}

/** "3d", "5h", "40m": the largest whole unit left, for a tag. */
export function shortLeft(ms: number): string {
  const minutes = Math.max(0, Math.floor(ms / 60000));
  if (minutes >= 24 * 60) return `${Math.floor(minutes / (24 * 60))}d`;
  if (minutes >= 60) return `${Math.floor(minutes / 60)}h`;
  return `${minutes}m`;
}

function endDate(ms: number): string {
  return new Date(ms).toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' });
}

/** The summary line's login tag, only when it needs attention. */
function loginTag(login: LoginInfo | undefined, now: number): SafeHtml | '' {
  const level = loginLevel(login);
  if (level === 'ok' || !login) return '';
  if (login.state === 'logged-out') return html`<span class="pu-tag danger">logged out</span>`;
  const left = login.endsAt ? shortLeft(Date.parse(login.endsAt) - now) : '?';
  return html`<span class="pu-tag ${level}" title="Its claude.ai login ends soon">login ${left}</span>`;
}

/** One summary line: name, both windows, and whether it is the attached session's. */
function summaryLine(v: AccountView, now: number): SafeHtml {
  const name = html`<span class="pu-acct ${v.colour}">${v.data.account}</span>`;
  const figures =
    v.state === 'not-set-up'
      ? html`<span class="pu-muted">not set up</span>`
      : joinHtml(v.windows.map(windowChip), html`<span class="pu-sep">·</span>`);
  const tag = v.attached ? html`<span class="pu-tag">attached</span>` : '';
  return html`<span class="pu-line">${name}${figures}${loginTag(v.data.login, now)}${tag}</span>`;
}

/** The popover's Login row: the state, then one muted line ending in a small link. */
function loginRow(data: AccountPlanUsage, now: number): SafeHtml | '' {
  const login = data.login;
  if (!login || login.state === 'unknown') return '';
  const link = (label: string) =>
    html`<button type="button" class="pu-link" data-action="login" data-account="${data.account}">${label}</button>`;
  if (login.state === 'logged-out') {
    return html`
        <div class="pu-row pu-login">
          <div class="pu-row-head"><span>Login</span><span class="pu-pct danger">not logged in</span></div>
          <p class="pu-detail">Its sessions and jobs can't reach Claude. ${link('Log in →')}</p>
        </div>`;
  }
  const ends = login.endsAt ? Date.parse(login.endsAt) : NaN;
  const when = Number.isFinite(ends) ? `ends ${endDate(ends)} · ${shortLeft(ends - now)}` : 'logged in';
  return html`
        <div class="pu-row pu-login">
          <div class="pu-row-head"><span>Login</span><span class="pu-pct ${loginLevel(login)}">${when}</span></div>
          <p class="pu-detail">Using Claude doesn't extend it. ${link('Renew now')}</p>
        </div>`;
}

/** Accounts whose one reminder is due now: within REMINDER_MS of the end, not yet past it. */
export function remindersDue(data: PlanUsage, now: number): { account: string; endsAt: string }[] {
  return data.accounts.flatMap((a) => {
    const login = a.login;
    if (!login?.endsAt || (login.state !== 'ending' && login.state !== 'ends-today')) return [];
    const left = Date.parse(login.endsAt) - now;
    return left > 0 && left <= REMINDER_MS ? [{ account: a.account, endsAt: login.endsAt }] : [];
  });
}

function windowRow(w: WindowView, now: number): SafeHtml {
  if (!w.reading) {
    return html`
        <div class="pu-row">
          <div class="pu-row-head">
            <span>${w.label}</span>
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
  return html`
        <div class="pu-row">
          <div class="pu-row-head">
            <span>${w.label}</span>
            <span class="pu-pct ${w.level}">${w.reset ? '—' : `${Math.round(w.reading.usedPercentage)}%`}</span>
          </div>
          <div class="pu-bar"><div class="pu-fill ${w.level}" style="width: ${pct}%"></div></div>
          <div class="pu-detail">${detail}</div>
        </div>`;
}

/** "This 5h window: 12 msgs · 3.4k in · 21k out · 1.2M cache read", from the ledger. */
export function tokensLine(t: WindowTokens | null | undefined, label: string): SafeHtml {
  if (!t) return html``;
  const parts = [
    `${t.messages} msg${t.messages === 1 ? '' : 's'}`,
    `${formatTokens(t.inputTokens)} in`,
    `${formatTokens(t.outputTokens)} out`,
    `${formatTokens(t.cacheReadTokens)} cache read`,
  ];
  return html`<p class="pu-detail pu-tokens">${`${label}: ${parts.join(' · ')}`}</p>`;
}

function setupHint(data: AccountPlanUsage, now: number): SafeHtml {
  if (data.relaySeenAt) {
    const seen = Date.parse(data.relaySeenAt);
    return html`<p class="pu-detail">The status line is set up (last heard from ${clock(seen, now - seen > 20 * 3600_000)}) but has not sent a verified reading yet. Limits arrive after a Claude Code session answers its first message, and only on a Pro or Max plan.</p>`;
  }
  const command = data.setup.command;
  const snippet = command
    ? html`<pre class="pu-snippet">${JSON.stringify({ statusLine: { type: 'command', command } }, null, 2)}</pre>`
    : html`<p class="pu-detail">See docs/plan-usage.md in the claude-remote repository.</p>`;
  return html`<p class="pu-detail">No reading yet. Add this to <code>${data.setup.settingsPath ?? '~/.claude/settings.json'}</code>; the chip fills in once a Claude Code session has answered a message.</p>${snippet}<p class="pu-detail">Already added? Then the status line cannot reach this server — set <code>CLAUDE_REMOTE_URL</code> if it is not on http://localhost:4220.</p>`;
}

/** One account's popover section: plan, verified state, bars, this window's tokens, freshness. */
function section(v: AccountView, now: number): SafeHtml {
  const d = v.data;
  const tags = [
    d.plan ? html`<span class="pu-plan">${d.plan}</span>` : '',
    d.verified === false
      ? html`<span class="pu-tag warn" title="Its folder does not hold the expected login">login not verified</span>`
      : d.verified
        ? html`<span class="pu-tag ok">verified</span>`
        : '',
    v.attached ? html`<span class="pu-tag">attached</span>` : '',
    d.jobs ? html`<span class="pu-tag" title="This project's jobs run under this account">jobs run here</span>` : '',
  ];
  const head = html`<div class="pu-section-head"><span class="pu-acct ${v.colour}">${d.account}</span>${tags}</div>`;

  let content: SafeHtml;
  if (v.state === 'readings') {
    const stale = now - (v.latest ?? 0) > STALE_MS;
    const running = d.running ?? 0;
    const asOf =
      `As of ${clock(v.latest ?? now, false)}` +
      (stale ? ` (${formatCountdown(now - (v.latest ?? now))} ago)` : '') +
      ` · ${running} running session${running === 1 ? '' : 's'}`;
    content = html`${v.windows.map((w) => windowRow(w, now))}${tokensLine(d.tokens?.fiveHour, 'This 5h window')}<p class="pu-foot${stale ? ' stale' : ''}">${asOf}</p>`;
  } else {
    content = setupHint(d, now);
  }
  const held = d.held
    ? html`<p class="pu-detail pu-held">${d.held} reading${d.held === 1 ? '' : 's'} held back (not this login's, or unverified)</p>`
    : '';
  return html`<section class="pu-section">${head}${loginRow(d, now)}${content}${held}</section>`;
}

/** The chip's summary lines and popover for `data` at time `now`. Pure, for tests. */
export function renderPlanUsage(data: PlanUsage, now: number): Rendered {
  const views = data.accounts.map((a, i) => accountView(a, i, data.attached, now));
  const level = worst(views.flatMap((v) => [...v.windows.map((w) => w.level), loginLevel(v.data.login)]));
  // Dimmed only when every account with readings is stale: one fresh line is news.
  const withReadings = views.filter((v) => v.latest !== null);
  const stale = withReadings.length > 0 && withReadings.every((v) => now - (v.latest ?? 0) > STALE_MS);

  const summary =
    views.length > 0 ? joinHtml(views.map((v) => summaryLine(v, now))) : html`<span class="pu-label">Plan usage</span> <span class="pu-muted">no accounts</span>`;
  const body = html`${views.map((v) => section(v, now))}<p class="pu-foot">Readings arrive while a Claude Code session is open; job runs do not send them.</p><button type="button" class="pu-breakdown" data-action="account-usage">Per-account breakdown →</button>`;
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
    const el = (event.target as HTMLElement | null)?.closest?.<HTMLElement>('[data-action]');
    if (!el) return;
    if (el.dataset.action === 'account-usage') {
      event.preventDefault();
      this.openBreakdown?.();
    } else if (el.dataset.action === 'login' && el.dataset.account) {
      event.preventDefault();
      this.confirmLogin(el.dataset.account);
    }
  };
  private readonly notifier = new BrowserNotifier();
  private reminderToast: HTMLElement | null = null;

  /** Opens the per-account usage page; set by the owner (session-manager). */
  openBreakdown: (() => void) | null = null;
  /**
   * Starts a Log in session for an account (the refusal modal's flow, session-manager's
   * startLogin); null until the owner sets it, and then the links do nothing.
   */
  logIn: ((account: string) => void) | null = null;

  /** The steps, then the Log in session. The check after it is the server's, via refreshLogin. */
  confirmLogin(account: string): void {
    if (!this.logIn) return;
    const { modal, close } = openDialog<null>(
      'login-modal',
      html`
      <div class="modal-content login-modal-content" role="dialog" aria-modal="true" aria-labelledby="login-modal-title">
        <h3 id="login-modal-title">Log in to <span class="login-modal-account">${account}</span></h3>
        <ol class="login-modal-steps">
          <li>A terminal opens running <code>claude</code> with only this account's folder.</li>
          <li>Type <code>/login</code> and choose your Claude subscription. Approve it in the browser window that opens.</li>
          <li>Type <code>/exit</code>. claude-remote checks the login and clears the warning.</li>
        </ol>
        <p class="pu-detail">If you log in as a different account, you'll see the usual mismatch dialog instead.</p>
        <div class="modal-actions">
          <button type="button" class="btn-secondary" data-cancel>Cancel</button>
          <button type="button" class="btn-primary login-modal-go">Open login terminal</button>
        </div>
      </div>`,
      null
    );
    const go = modal.querySelector<HTMLButtonElement>('.login-modal-go');
    go?.addEventListener('click', () => {
      close(null);
      this.dismissReminder();
      this.logIn?.(account);
    });
    go?.focus();
  }

  /** Ask the server to re-check an account's login now (after a Log in session), then redraw. */
  async refreshLogin(account: string): Promise<void> {
    try {
      await fetch('/api/plan-usage/login/refresh', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ account }),
      });
    } catch {
      // The next poll picks it up within a minute: an urgent state is re-checked that often.
    }
    await this.refresh();
  }

  /**
   * The one reminder per account per login (keyed by its end, so a renewed login gets its
   * own): a toast, plus a browser notification when the tab is in the background.
   */
  private remind(data: PlanUsage, now: number): void {
    for (const due of remindersDue(data, now)) {
      const key = `cr.loginReminder.${due.account}`;
      try {
        if (localStorage.getItem(key) === due.endsAt) continue;
        localStorage.setItem(key, due.endsAt);
      } catch {
        // No storage: remind once per page load instead.
        if (this.reminded.has(key + due.endsAt)) continue;
      }
      this.reminded.add(key + due.endsAt);
      const ends = Date.parse(due.endsAt);
      const title = `${due.account} login ends in ${shortLeft(ends - now)}`;
      const body = `Ends ${endDate(ends)}. Using Claude won't extend it.`;
      this.showReminder(due.account, title, body);
      this.notifier.show(title, body, `login-${due.account}`);
    }
  }
  private reminded = new Set<string>();

  private showReminder(account: string, title: string, body: string): void {
    this.dismissReminder();
    const toast = document.createElement('div');
    toast.className = 'login-toast';
    toast.setAttribute('role', 'status');
    setHtml(
      toast,
      html`<p><strong>${title}.</strong> ${body}</p>
        <div class="login-toast-actions">
          <button type="button" class="btn-secondary" data-toast="dismiss">Dismiss</button>
          <button type="button" class="btn-secondary login-toast-go" data-toast="login">Log in →</button>
        </div>`
    );
    toast.addEventListener('click', (e) => {
      const action = (e.target as HTMLElement).closest<HTMLElement>('[data-toast]')?.dataset.toast;
      if (action === 'dismiss') this.dismissReminder();
      else if (action === 'login') this.confirmLogin(account);
    });
    document.body.appendChild(toast);
    this.reminderToast = toast;
  }

  private dismissReminder(): void {
    this.reminderToast?.remove();
    this.reminderToast = null;
  }
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
    if (summary) setHtml(summary, view.summary);
    if (body) setHtml(body, view.body);
    root.dataset.level = view.level;
    root.classList.toggle('stale', view.stale);
    root.hidden = false;
    this.remind(this.data, now);
    this.onRender?.(this.data, now);
  }
}
