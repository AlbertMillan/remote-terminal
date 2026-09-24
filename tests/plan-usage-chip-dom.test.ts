// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  PlanUsageChip,
  formatCountdown,
  levelOf,
  renderPlanUsage,
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

const data = (five: WindowReading | null, seven: WindowReading | null): PlanUsage => ({
  snapshot: { fiveHour: five, sevenDay: seven },
  setup: { command: 'node "C:/repo/scripts/statusline.mjs"' },
});

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
    const text = view.summary.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    expect(text).toBe('5h 55% · wk 22%');
    expect(view.body).toContain('resets in 2h 0m');
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
    const view = renderPlanUsage({ snapshot: null, setup: { command: 'node "C:/repo/scripts/statusline.mjs"' } }, NOW);
    expect(view.summary).toContain('not set up');
    expect(view.body).toContain('~/.claude/settings.json');
    expect(view.body).toContain('"statusLine"');
    expect(view.body).toContain('C:/repo/scripts/statusline.mjs');
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
  afterEach(() => vi.unstubAllGlobals());

  it('appears on its first reading and keeps an open popover open across refreshes', async () => {
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

  it('stays hidden when the server cannot answer', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 500 })));
    await new PlanUsageChip().refresh();
    expect(document.getElementById('plan-usage')!.hidden).toBe(true);
  });
});
