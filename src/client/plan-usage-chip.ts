import { escapeHtml } from './html-utils.js';

/**
 * The plan-usage chip: how much of the Pro/Max plan's 5-hour and weekly
 * windows is used, relayed from Claude Code's status line. See
 * docs/plan-usage.md.
 *
 * The chip is a <details> element, so opening the breakdown needs no script;
 * polling re-renders only its contents, never the element, so an open popover
 * stays open across refreshes.
 */

/** Mirrors WindowReading in src/server/usage/plan-limits.ts. */
export interface WindowReading {
  usedPercentage: number;
  /** Unix seconds. */
  resetsAt: number;
  observedAt: string;
}

export interface PlanUsage {
  snapshot: { fiveHour: WindowReading | null; sevenDay: WindowReading | null } | null;
  /** When the relay last reached the server, limits or not; null if it never has. */
  relaySeenAt?: string | null;
  setup: { command: string | null };
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

/** "2h 14m", "3d 4h", "45m" — coarse on purpose; the exact time is beside it. */
export function formatCountdown(ms: number): string {
  const minutes = Math.max(0, Math.round(ms / 60000));
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${minutes % 60}m`;
  return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

function clock(ms: number, withDay: boolean): string {
  const d = new Date(ms);
  return withDay
    ? d.toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' })
    : d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

interface WindowView {
  label: string;
  short: string;
  reading: WindowReading;
  /** Past its reset time: the held percentage belongs to a window that is over. */
  reset: boolean;
  level: Level;
}

function viewOf(label: string, short: string, reading: WindowReading | null, now: number): WindowView | null {
  if (!reading) return null;
  const reset = reading.resetsAt * 1000 <= now;
  return { label, short, reading, reset, level: reset ? 'ok' : levelOf(reading.usedPercentage) };
}

const LEVEL_RANK: Record<Level, number> = { ok: 0, warn: 1, danger: 2 };

export interface Rendered {
  summary: string;
  body: string;
  level: Level;
  stale: boolean;
}

/** The chip's summary line and popover for `data` at time `now`. Pure, for tests. */
export function renderPlanUsage(data: PlanUsage, now: number): Rendered {
  const snap = data.snapshot;
  const windows = snap
    ? [viewOf('5-hour window', '5h', snap.fiveHour, now), viewOf('Weekly', 'wk', snap.sevenDay, now)].filter(
        (w): w is WindowView => w !== null
      )
    : [];

  // The relay has reported but carried no limits: it is installed, and asking
  // for the snippet again would send the user to fix what is not broken.
  if (windows.length === 0 && data.relaySeenAt) {
    const seen = Date.parse(data.relaySeenAt);
    return {
      summary: '<span class="pu-label">Plan usage</span> <span class="pu-muted">waiting</span>',
      body:
        `<p>The status line is set up (last heard from ${escapeHtml(clock(seen, now - seen > 20 * 3600_000))}) ` +
        'but has not reported limits yet. They arrive after a Claude Code session answers its ' +
        'first message, and only on a Pro or Max plan.</p>',
      level: 'ok',
      stale: false,
    };
  }

  if (windows.length === 0) {
    const command = data.setup.command;
    const snippet = command
      ? `<pre class="pu-snippet">${escapeHtml(
          JSON.stringify({ statusLine: { type: 'command', command } }, null, 2)
        )}</pre>`
      : '<p>See docs/plan-usage.md in the claude-remote repository.</p>';
    return {
      summary: '<span class="pu-label">Plan usage</span> <span class="pu-muted">not set up</span>',
      body:
        '<p>No reading yet. Add this to <code>~/.claude/settings.json</code>; the chip fills in ' +
        'once a Claude Code session has answered a message.</p>' +
        snippet +
        '<p class="pu-detail">Already added? Then the status line cannot reach this server — ' +
        'set <code>CLAUDE_REMOTE_URL</code> if it is not on http://localhost:4220.</p>',
      level: 'ok',
      stale: false,
    };
  }

  const level = windows.reduce<Level>((worst, w) => (LEVEL_RANK[w.level] > LEVEL_RANK[worst] ? w.level : worst), 'ok');
  const latest = Math.max(...windows.map((w) => Date.parse(w.reading.observedAt) || 0));
  const stale = now - latest > STALE_MS;

  const summary = windows
    .map(
      (w) =>
        `<span class="pu-window ${w.level}">${w.short} ${
          w.reset ? 'reset' : `${Math.round(w.reading.usedPercentage)}%`
        }</span>`
    )
    .join('<span class="pu-sep">·</span>');

  const rows = windows
    .map((w) => {
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
    })
    .join('');

  const age = formatCountdown(now - latest);
  const footer =
    `<p class="pu-foot${stale ? ' stale' : ''}">As of ${escapeHtml(clock(latest, false))}` +
    (stale ? ` (${escapeHtml(age)} ago)` : '') +
    '. Readings arrive while a Claude Code session is open; job runs do not send them.</p>';

  return { summary, body: rows + footer, level, stale };
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

  /** Wire up the static markup and start polling. Safe to call once. */
  attach(): void {
    if (!document.getElementById('plan-usage')) return;
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
    window.removeEventListener('focus', this.onFocus);
    document.removeEventListener('visibilitychange', this.onVisibility);
  }

  async refresh(): Promise<void> {
    try {
      const res = await fetch('/api/plan-usage');
      if (!res.ok) return;
      this.data = (await res.json()) as PlanUsage;
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
  }
}
