// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { FactoryOverlay, overlayUnits, newlyNeedingYou, cardStatus, DONE_LINGER_MS } from '../src/client/factory-overlay.js';
import type { FactorySummary, FactoryUnitSummary } from '../src/shared/protocol.js';

/**
 * The Factory overlay (project/code-factory.md, f-5clssc): the Jobs overlay's
 * place and placements, its counts and cards (status rails, a track's feature
 * strip), the footer to the board and Add work, and the amber flash and toast
 * when something newly waits for you.
 */

const DOM = `
  <main id="main-content">
    <div id="terminal-header" class="terminal-header hidden">
      <span id="session-name">Session</span>
      <div class="terminal-controls"><button id="terminate-session-btn"></button></div>
    </div>
    <div id="factory-overlay" class="factory-overlay jo-floating hidden">
      <div id="factory-overlay-bar" class="jo-bar"><span id="factory-overlay-counts"></span></div>
      <div class="jo-list"><div id="factory-overlay-list"></div><div id="factory-overlay-foot"></div></div>
    </div>
    <div id="factory-toast" class="factory-toast hidden"></div>
  </main>`;

function unit(key: string, over: Partial<FactoryUnitSummary> = {}): FactoryUnitSummary {
  return {
    key,
    projectCwd: 'C:\\p\\alpha',
    projectName: 'alpha',
    unitId: key,
    isTrack: false,
    trackName: 'Inbox',
    title: `Unit ${key}`,
    featureIds: [key],
    column: 'running',
    status: 'in_progress',
    step: 'implement',
    needsYou: false,
    reviewer: null,
    escalated: false,
    triage: false,
    reason: null,
    features: [],
    waitsFor: [],
    mergeId: null,
    mergeStatus: null,
    tokens: 0,
    modelTier: 'sonnet',
    stalled: null,
    heartbeatAt: null,
    updatedAt: new Date().toISOString(),
    ...over,
  };
}

function summary(units: FactoryUnitSummary[], counts: Partial<FactorySummary['counts']> = {}): FactorySummary {
  return {
    units,
    merges: [],
    counts: { running: 0, reviewing: 0, needsYou: 0, merging: 0, done: 0, ...counts },
    dispatch: { started: true, paused: null, capped: {}, seats: 3, running: 1 },
    tokensToday: 1_900_000,
    since: new Date().toISOString(),
  };
}

const root = () => document.getElementById('factory-overlay')!;
const cards = () => [...document.querySelectorAll<HTMLElement>('#factory-overlay-list [data-unit-key]')];

let host: { openBoard: ReturnType<typeof vi.fn>; addWork: ReturnType<typeof vi.fn> };
let overlay: FactoryOverlay;

beforeEach(() => {
  localStorage.clear();
  document.body.innerHTML = DOM;
  host = { openBoard: vi.fn(), addWork: vi.fn() };
  overlay = new FactoryOverlay(host);
  overlay.attach();
});

describe('the pill', () => {
  it('stays hidden until the server sent a summary, and while suppressed', () => {
    expect(root().classList.contains('hidden')).toBe(true);
    overlay.update(summary([]));
    expect(root().classList.contains('hidden')).toBe(false);
    overlay.setSuppressed(true);
    expect(root().classList.contains('hidden')).toBe(true);
  });

  it('counts running, agent reviewing, needs you, merging and done', () => {
    overlay.update(summary([unit('a')], { running: 4, reviewing: 1, needsYou: 2, merging: 1, done: 3 }));
    const counts = [...document.querySelectorAll('#factory-overlay-counts .jo-count')].map((c) => [c.className, c.textContent]);
    expect(counts).toEqual([
      ['jo-count running', '4'],
      ['jo-count review', '1 review'],
      ['jo-count waiting', '2 needs you'],
      ['jo-count merging', '1 merging'],
      ['jo-count done', '3'],
    ]);
  });

  it('says idle when nothing moves', () => {
    overlay.update(summary([]));
    expect(document.getElementById('factory-overlay-counts')!.textContent).toBe('idle');
  });

  it("reads the Jobs overlay's off switch as its default", () => {
    localStorage.setItem('jobOverlayEnabled', 'false');
    const again = new FactoryOverlay(host);
    expect(again.isEnabled()).toBe(false);
  });
});

describe('cards', () => {
  it('puts what needs you first, with an amber rail, and a track with its feature strip', () => {
    overlay.update(
      summary([
        unit('run', { updatedAt: new Date(Date.now() - 60_000).toISOString() }),
        unit('track:T', {
          isTrack: true,
          title: 'History search',
          features: [
            { id: 'f-1', title: 'A', state: 'done' },
            { id: 'f-2', title: 'B', state: 'now' },
            { id: 'f-3', title: 'C', state: 'todo' },
          ],
        }),
        unit('mine', { column: 'review', status: 'parked', needsYou: true, escalated: true, reason: 'review: escalated: touches auth/access-gate.ts' }),
      ])
    );
    expect(cards().map((c) => c.dataset.unitKey)).toEqual(['mine', 'track:T', 'run']);
    expect(cards()[0].classList.contains('you')).toBe(true);
    expect(cards()[0].textContent).toContain('escalated: touches auth/access-gate.ts');
    const strip = cards()[1].querySelectorAll('.fo-prog i');
    expect([...strip].map((i) => i.className)).toEqual(['d', 'n', '']);
    expect(cards()[1].textContent).toContain('feature 2 of 3');
  });

  it('opens the board on a card, and the footer opens the board or Add work', () => {
    overlay.update(summary([unit('a')]));
    cards()[0].click();
    expect(host.openBoard).toHaveBeenCalledWith('a');
    document.querySelector<HTMLElement>('[data-fo-board]')!.click();
    expect(host.openBoard).toHaveBeenLastCalledWith();
    document.querySelector<HTMLElement>('[data-fo-add]')!.click();
    expect(host.addWork).toHaveBeenCalled();
    expect(document.getElementById('factory-overlay-foot')!.textContent).toContain('today 1.9M tokens');
  });

  it('drops a done card after its linger, keeping it in the count', () => {
    const old = new Date(Date.now() - DONE_LINGER_MS - 1000).toISOString();
    const units = [unit('done-old', { column: 'done', updatedAt: old }), unit('done-new', { column: 'done' })];
    expect(overlayUnits(units, Date.now()).map((u) => u.key)).toEqual(['done-new']);
  });

  it('docks into the header in header placement, and floats when the header is hidden', () => {
    overlay.update(summary([unit('a')]));
    document.getElementById('terminal-header')!.classList.remove('hidden');
    overlay.setPreferences(true, 'header');
    expect(root().parentElement?.id).toBe('terminal-header');
    expect(root().nextElementSibling?.classList.contains('terminal-controls')).toBe(true);
    document.getElementById('terminal-header')!.classList.add('hidden');
    overlay.applyPlacement();
    expect(root().parentElement?.id).toBe('main-content');
    expect(localStorage.getItem('factoryOverlayPlacement')).toBe('header');
  });
});

describe('escalation', () => {
  it('stays quiet on the first summary, then flashes and toasts what newly needs you', () => {
    const waiting = unit('old', { needsYou: true, status: 'parked' });
    overlay.update(summary([waiting]));
    expect(document.getElementById('factory-toast')!.classList.contains('hidden')).toBe(true);

    const escalated = unit('esc', { column: 'review', needsYou: true, status: 'parked', escalated: true, title: 'Admit tailnet devices by tag', reason: 'review: escalated: touches auth/access-gate.ts' });
    overlay.update(summary([waiting, escalated]));
    const toast = document.getElementById('factory-toast')!;
    expect(toast.classList.contains('hidden')).toBe(false);
    expect(toast.textContent).toContain('Admit tailnet devices by tag needs you: escalated: touches auth/access-gate.ts');
    expect(document.getElementById('factory-overlay-bar')!.classList.contains('flash')).toBe(true);

    toast.querySelector<HTMLElement>('[data-unit-key]')!.click();
    expect(host.openBoard).toHaveBeenCalledWith('esc');
    expect(toast.classList.contains('hidden')).toBe(true);
  });

  it('starts quiet again after the socket drops', () => {
    overlay.update(summary([]));
    overlay.clear();
    expect(root().classList.contains('hidden')).toBe(true);
    overlay.update(summary([unit('esc', { needsYou: true })]));
    expect(document.getElementById('factory-toast')!.classList.contains('hidden')).toBe(true);
  });

  it('names only units that newly wait', () => {
    const units = [unit('a', { needsYou: true }), unit('b', { needsYou: true }), unit('c')];
    expect(newlyNeedingYou(new Set(['a']), units).map((u) => u.key)).toEqual(['b']);
  });
});

describe('cardStatus', () => {
  it('says where a unit is', () => {
    expect(cardStatus(unit('a', { column: 'ready', status: 'open', waitsFor: ['f-x'] }))).toBe('waits for f-x');
    expect(cardStatus(unit('a', { column: 'review' }))).toBe('reviewer agent checking');
    expect(cardStatus(unit('a', { column: 'merging', reason: 'Resolving conflicts in a.ts' }))).toBe('Resolving conflicts in a.ts');
    expect(cardStatus(unit('a', { stalled: 'no heartbeat for 9m' }))).toBe('stalled: no heartbeat for 9m');
    expect(cardStatus(unit('a', { triage: true, needsYou: true }))).toBe('triage: accept, backlog or dismiss');
  });
});
