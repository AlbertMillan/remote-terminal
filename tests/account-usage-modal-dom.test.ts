// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  AccountUsageModal,
  HELD_REASONS,
  renderAccountCards,
  renderHeldRows,
  type HeldReading,
} from '../src/client/account-usage-modal.js';
import type { AccountPlanUsage, PlanUsage, WindowTokens } from '../src/client/plan-usage-chip.js';

/**
 * The account usage page (f-7y1fcz): a card per login, its tokens for this
 * window and this week, and the readings held back with a Discard each.
 */

const NOW = Date.parse('2026-10-28T20:00:00Z');
const inH = (h: number) => Math.round(NOW / 1000 + h * 3600);

function tokens(rest: Partial<WindowTokens> = {}): WindowTokens {
  return {
    messages: 10,
    inputTokens: 1000,
    outputTokens: 20_000,
    cacheReadTokens: 3_000_000,
    cacheWriteTokens: 40_000,
    costUsd: 4.5,
    unpriced: false,
    sessions: 3,
    jobRuns: 2,
    elsewhere: 0,
    since: '2026-10-28T16:00:00.000Z',
    sinceLogin: false,
    ...rest,
  };
}

const account = (name: string, rest: Partial<AccountPlanUsage> = {}): AccountPlanUsage => ({
  account: name,
  verified: true,
  snapshot: null,
  relaySeenAt: null,
  setup: { command: null },
  ...rest,
});

const DATA: PlanUsage = {
  attached: 'personal',
  accounts: [
    account('personal', {
      plan: 'Max 5x',
      snapshot: {
        fiveHour: { usedPercentage: 4, resetsAt: inH(3), observedAt: new Date(NOW).toISOString() },
        sevenDay: { usedPercentage: 1, resetsAt: inH(140), observedAt: new Date(NOW).toISOString() },
      },
      tokens: { fiveHour: tokens(), sevenDay: tokens({ messages: 40, sinceLogin: true }) },
      running: 1,
    }),
    account('work', {
      plan: 'Team',
      verified: false,
      snapshot: { fiveHour: { usedPercentage: 85, resetsAt: inH(1), observedAt: new Date(NOW).toISOString() }, sevenDay: null },
      tokens: { fiveHour: tokens({ messages: 3 }), sevenDay: tokens({ messages: 819, elsewhere: 812 }) },
      jobs: true,
    }),
  ],
};

const HELD: HeldReading[] = [
  { id: 'h1', account: 'work', window: 'sevenDay', usedPercentage: 0, resetsAt: inH(30), arrivedAt: new Date(NOW).toISOString(), reason: 'unverified-legacy' },
  { id: 'h2', account: null, window: 'fiveHour', usedPercentage: 12, resetsAt: inH(2), arrivedAt: new Date(NOW).toISOString(), reason: 'unknown-folder' },
];

const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

describe('cards', () => {
  it('gives each account its windows, token table and counts', () => {
    const html = renderAccountCards(DATA, NOW);
    expect(html.match(/class="au-card"/g)).toHaveLength(2);
    const t = text(html);
    expect(t).toContain('personal Max 5x verified attached');
    expect(t).toContain('work Team login not verified jobs run here');
    // The week column says "since login" for a login younger than the week.
    expect(t).toContain('This 5h window Since login');
    expect(t).toContain('This 5h window This week');
    expect(t).toContain('Cache read 3.0M 3.0M');
    expect(t).toContain('Job runs 2 2');
    expect(t).toContain('Est. cost $4.50 $4.50');
    // Moved transcripts are named, and a window with no verified reading is a ?.
    expect(t).toContain("812 of 819 messages this week sit in another account's folder");
    expect(html).toContain('au-window-pct unknown">?</div>');
    expect(html).toContain('au-window-pct warn">85%');
  });

  it('escapes account names and plans', () => {
    const html = renderAccountCards({ accounts: [account('<img src=x>', { plan: '<b>x</b>' })] }, NOW);
    expect(html).not.toContain('<img');
    expect(html).not.toContain('<b>');
    expect(html).toContain('&lt;img src=x&gt;');
  });
});

describe('held-back readings', () => {
  it('lists each with its account, window, value and reason in plain words', () => {
    const t = text(renderHeldRows(HELD));
    expect(t).toContain('work');
    expect(t).toContain('no account');
    expect(t).toContain(HELD_REASONS['unverified-legacy']);
    expect(t).toContain(HELD_REASONS['unknown-folder']);
    expect(t).toMatch(/wk → .* 0%/);
    expect(renderHeldRows(HELD).match(/data-held-id="h\d"/g)).toEqual(['data-held-id="h1"', 'data-held-id="h2"']);
  });

  it('has a plain-words reason for every reason the server holds a reading for', () => {
    const src = readFileSync(join(__dirname, '..', 'src', 'server', 'usage', 'plan-limits.ts'), 'utf8');
    const union = /export type HeldReason = ([^;]+);/.exec(src)![1];
    const reasons = [...union.matchAll(/'([a-z-]+)'/g)].map((m) => m[1]);
    expect(reasons.length).toBeGreaterThan(0);
    for (const r of reasons) expect(HELD_REASONS[r]).toBeTruthy();
  });
});

describe('the page', () => {
  let held: HeldReading[];
  beforeEach(() => {
    const html = readFileSync(join(__dirname, '..', 'src', 'client', 'index.html'), 'utf8');
    const modal = /<div id="account-usage-modal"[\s\S]*?<\/table>\s*<\/div>\s*<\/section>\s*<div class="modal-actions">[\s\S]*?<\/div>\s*<\/div>\s*<\/div>/.exec(html)![0];
    document.body.innerHTML = modal;
    held = [...HELD];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: { body?: string }) => {
        if (url === '/api/plan-usage/held/discard') {
          const { id } = JSON.parse(init!.body!);
          held = held.filter((h) => h.id !== id);
          return new Response(JSON.stringify({ discarded: 1 }));
        }
        return new Response(JSON.stringify({ held }));
      })
    );
  });
  afterEach(() => vi.unstubAllGlobals());

  it('opens with the cards, loads what is held back, and discards a row', async () => {
    const changed = vi.fn();
    const modal = new AccountUsageModal(changed);
    await modal.open(DATA);
    const root = document.getElementById('account-usage-modal')!;
    expect(root.classList.contains('hidden')).toBe(false);
    expect(root.querySelectorAll('.au-card')).toHaveLength(2);
    const section = root.querySelector('.account-usage-held') as HTMLElement;
    expect(section.hidden).toBe(false);
    expect(root.querySelectorAll('.account-usage-held tbody tr')).toHaveLength(2);

    (root.querySelector('[data-held-id="h1"]') as HTMLElement).click();
    await vi.waitFor(() => expect(root.querySelectorAll('.account-usage-held tbody tr')).toHaveLength(1));
    expect(changed).toHaveBeenCalledTimes(1);

    (root.querySelector('[data-held-id="h2"]') as HTMLElement).click();
    await vi.waitFor(() => expect(section.hidden).toBe(true));
  });

  it('closes from its button and on Escape', async () => {
    const modal = new AccountUsageModal();
    const root = document.getElementById('account-usage-modal')!;
    await modal.open(DATA);
    (root.querySelector('.account-usage-close') as HTMLElement).click();
    expect(root.classList.contains('hidden')).toBe(true);
    await modal.open(DATA);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(root.classList.contains('hidden')).toBe(true);
  });
});
