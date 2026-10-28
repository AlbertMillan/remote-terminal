// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  PlanUsageChip,
  formatCountdown,
  levelOf,
  renderPlanUsage,
  formatTokens,
  type AccountPlanUsage,
  type PlanUsage,
  type WindowReading,
} from '../src/client/plan-usage-chip.js';

/**
 * The sidebar's plan-usage chip. Its job is to be honest: a reading goes stale
 * when no session is open, a window that has reset no longer means its old
 * percentage, and "never set up" must say how to set it up.
 */

const NOW = Date.parse('2026-09-25T12:00:00Z');
const at = (msAgo: number) => new Date(NOW - msAgo).toISOString();

function reading(pct: number, resetsInH: number, observedMsAgo = 0): WindowReading {
  return { usedPercentage: pct, resetsAt: Math.round(NOW / 1000 + resetsInH * 3600), observedAt: at(observedMsAgo) };
}

const SETUP = { command: 'node "C:/repo/scripts/statusline.mjs"' };

/** One account's entry, as GET /api/plan-usage serves it. */
const account = (name: string, rest: Partial<AccountPlanUsage> = {}): AccountPlanUsage => ({
  account: name,
  verified: true,
  snapshot: null,
  relaySeenAt: null,
  setup: SETUP,
  ...rest,
});

/** A single account with these windows. */
const data = (five: WindowReading | null, seven: WindowReading | null): PlanUsage => ({
  accounts: [account('work', { snapshot: { fiveHour: five, sevenDay: seven } })],
});
const one = (rest: Partial<AccountPlanUsage>): PlanUsage => ({ accounts: [account('work', rest)] });
const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

describe('levels', () => {
  it('turns amber at 80 and red at 95', () => {
    expect(levelOf(79)).toBe('ok');
    expect(levelOf(80)).toBe('warn');
    expect(levelOf(94.9)).toBe('warn');
    expect(levelOf(95)).toBe('danger');
  });

  it('colours the chip by its worst window', () => {
    expect(renderPlanUsage(data(reading(40, 2), reading(96, 50)), NOW).level).toBe('danger');
  });
});

describe('rendering', () => {
  it('summarises both windows', () => {
    const view = renderPlanUsage(data(reading(55.4, 2), reading(22, 50)), NOW);
    expect(text(view.summary)).toBe('work 5h 55% · wk 22%');
    expect(view.body).toContain('resets in 2h 0m');
  });

  it('renders one line per account, the attached tag, and ? for a window with no verified reading', () => {
    const view = renderPlanUsage(
      {
        attached: 'personal',
        accounts: [
          account('personal', { plan: 'Max 5x', snapshot: { fiveHour: reading(4, 2), sevenDay: null }, relaySeenAt: at(0) }),
          account('work', { plan: 'Team', verified: false, snapshot: { fiveHour: reading(41, 3), sevenDay: reading(12, 50) } }),
        ],
      },
      NOW
    );
    const lines = [...view.summary.matchAll(/<span class="pu-line">(.*?)<\/span><\/span>(?=<span class="pu-line">|$)/g)].map((m) =>
      text(m[0])
    );
    expect(lines).toEqual(['personal 5h 4% · wk ? attached', 'work 5h 41% · wk 12%']);
    // The unknown window in amber, apart from the severity colours.
    expect(view.summary).toContain('<span class="pu-window unknown" title="No verified reading">wk ?</span>');
    // Each account in its own colour.
    expect(view.summary).toContain('pu-acct pu-acct-c0');
    expect(view.summary).toContain('pu-acct pu-acct-c1');
    // The popover: a section each, with plan and verified state.
    expect(view.body.match(/class="pu-section"/g)).toHaveLength(2);
    expect(view.body).toContain('Max 5x');
    expect(view.body).toContain('login not verified');
    expect(view.body).toContain('data-action="account-usage"');
  });

  it('escapes account names and plan labels', () => {
    const view = renderPlanUsage(
      { attached: '<img src=x>', accounts: [account('<img src=x>', { plan: '<b>Max</b>', relaySeenAt: at(0) })] },
      NOW
    );
    expect(view.summary).not.toContain('<img');
    expect(view.summary).toContain('&lt;img src=x&gt;');
    expect(view.body).not.toContain('<b>');
  });

  it("shows this 5-hour window's tokens, running sessions, and where jobs run", () => {
    const view = renderPlanUsage(
      one({
        snapshot: { fiveHour: reading(41, 3), sevenDay: reading(12, 50) },
        running: 2,
        jobs: true,
        held: 3,
        tokens: {
          fiveHour: {
            messages: 12,
            inputTokens: 3400,
            outputTokens: 21_000,
            cacheReadTokens: 1_200_000,
            cacheWriteTokens: 0,
            costUsd: 1,
            unpriced: false,
            sessions: 2,
            jobRuns: 0,
            elsewhere: 0,
            since: at(3600_000),
            sinceLogin: false,
          },
          sevenDay: null,
        },
      }),
      NOW
    );
    expect(text(view.body)).toContain('This 5h window: 12 msgs · 3.4k in · 21k out · 1.2M cache read');
    expect(view.body).toContain('2 running sessions');
    expect(view.body).toContain('jobs run here');
    expect(view.body).toContain('3 readings held back');
  });

  it('formats token counts compactly', () => {
    expect(formatTokens(950)).toBe('950');
    expect(formatTokens(3400)).toBe('3.4k');
    expect(formatTokens(21_000)).toBe('21k');
    expect(formatTokens(1_200_000)).toBe('1.2M');
  });

  it('says a window has reset instead of showing its old percentage', () => {
    const view = renderPlanUsage(data(reading(97, -1), reading(22, 50)), NOW);
    expect(view.summary).toContain('5h reset');
    expect(view.summary).not.toContain('97%');
    expect(view.body).toContain('no reading since');
    // A reset window no longer counts toward the warning colour.
    expect(view.level).toBe('ok');
  });

  it('shows the reading’s age once it is over ten minutes old', () => {
    const fresh = renderPlanUsage(data(reading(55, 2, 5 * 60_000), null), NOW);
    expect(fresh.stale).toBe(false);
    expect(fresh.body).not.toContain('ago');

    const stale = renderPlanUsage(data(reading(55, 2, 37 * 60_000), null), NOW);
    expect(stale.stale).toBe(true);
    expect(stale.body).toContain('(37m ago)');
  });

  it('shows the exact setup snippet when no reading has ever arrived', () => {
    const view = renderPlanUsage(one({ snapshot: null }), NOW);
    const personal = renderPlanUsage(
      one({ snapshot: null, setup: { command: 'x', settingsPath: 'C:\\Users\\me\\.claude-personal\\settings.json' } }),
      NOW
    );
    // The account's own settings file, not always ~/.claude's.
    expect(personal.body).toContain('C:\\Users\\me\\.claude-personal\\settings.json');
    expect(view.summary).toContain('not set up');
    expect(view.body).toContain('~/.claude/settings.json');
    expect(view.body).toContain('"statusLine"');
    expect(view.body).toContain('C:/repo/scripts/statusline.mjs');
  });

  it('shows ?, not "not set up", once the relay has reported without a verified reading', () => {
    // Asking for the snippet again would send the user to fix what is not broken.
    const view = renderPlanUsage(one({ snapshot: null, relaySeenAt: at(2 * 60_000) }), NOW);
    expect(text(view.summary)).toBe('work 5h ? · wk ?');
    expect(view.summary).not.toContain('not set up');
    expect(view.body).toContain('is set up');
    expect(view.body).not.toContain('statusLine');
  });

  it('tells a user who has added the snippet how to find a relay that cannot connect', () => {
    const view = renderPlanUsage(one({ snapshot: null, relaySeenAt: null, setup: { command: null } }), NOW);
    expect(view.body).toContain('CLAUDE_REMOTE_URL');
  });

  it('formats countdowns coarsely', () => {
    expect(formatCountdown(45 * 60_000)).toBe('45m');
    expect(formatCountdown((2 * 60 + 14) * 60_000)).toBe('2h 14m');
    expect(formatCountdown((3 * 24 + 4) * 3600_000)).toBe('3d 4h');
  });
});

describe('the chip in the sidebar', () => {
  beforeEach(() => {
    document.body.innerHTML = `
      <details id="plan-usage" class="plan-usage" hidden>
        <summary class="plan-usage-summary"></summary>
        <div class="plan-usage-body"></div>
      </details>`;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify(data(reading(85, 2), reading(22, 50)))))
    );
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('appears on its first reading and keeps an open popover open across refreshes', async () => {
    // refresh() renders at the real Date.now(); pin it to NOW, or the fixture's windows
    // are hours stale by the time the suite runs and the chip reads 'ok' instead of 'warn'.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
    const chip = new PlanUsageChip();
    const root = document.getElementById('plan-usage') as HTMLDetailsElement;
    await chip.refresh();
    expect(root.hidden).toBe(false);
    expect(root.dataset.level).toBe('warn');

    root.open = true;
    await chip.refresh();
    chip.render(NOW + 60_000);
    expect(root.open).toBe(true);
    expect(root.querySelector('.plan-usage-body')?.textContent).toContain('5-hour window');
  });

  it('skips polls while the tab is hidden and catches up when it is shown', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.mocked(fetch);
    let visibility: DocumentVisibilityState = 'hidden';
    vi.spyOn(document, 'visibilityState', 'get').mockImplementation(() => visibility);

    const chip = new PlanUsageChip();
    chip.attach(); // one refresh on attach, whatever the visibility
    const afterAttach = fetchMock.mock.calls.length;

    await vi.advanceTimersByTimeAsync(3 * 60_000);
    expect(fetchMock.mock.calls.length).toBe(afterAttach);

    visibility = 'visible';
    document.dispatchEvent(new Event('visibilitychange'));
    expect(fetchMock.mock.calls.length).toBe(afterAttach + 1);

    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetchMock.mock.calls.length).toBe(afterAttach + 2);

    chip.detach();
    vi.useRealTimers();
  });

  it('removes its listeners and timers on detach', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.mocked(fetch);
    const chip = new PlanUsageChip();
    chip.attach();
    chip.detach();
    const before = fetchMock.mock.calls.length;

    window.dispatchEvent(new Event('focus'));
    document.dispatchEvent(new Event('visibilitychange'));
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(fetchMock.mock.calls.length).toBe(before);
    vi.useRealTimers();
  });

  it('asks for the attached session and its folder, and opens the breakdown from its link', async () => {
    const fetchMock = vi.mocked(fetch);
    const chip = new PlanUsageChip();
    const opened = vi.fn();
    chip.openBreakdown = opened;
    chip.attach();
    chip.setAccount('work', 'C:\\p\\alpha');
    await vi.waitFor(() => expect(document.querySelector('[data-action="account-usage"]')).not.toBeNull());
    expect(String(fetchMock.mock.calls.at(-1)![0])).toBe('/api/plan-usage?account=work&cwd=C%3A%5Cp%5Calpha');
    (document.querySelector('[data-action="account-usage"]') as HTMLElement).click();
    expect(opened).toHaveBeenCalledTimes(1);
    chip.detach();
  });

  it("still renders a server's single-account answer from before every-account readings", async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ account: 'work', snapshot: { fiveHour: reading(30, 2), sevenDay: null }, setup: SETUP })))
    );
    await new PlanUsageChip().refresh();
    expect(document.querySelector('.plan-usage-summary')?.textContent).toContain('5h 30%');
  });

  it('stays hidden when the server cannot answer', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 500 })));
    await new PlanUsageChip().refresh();
    expect(document.getElementById('plan-usage')!.hidden).toBe(true);
  });
});
