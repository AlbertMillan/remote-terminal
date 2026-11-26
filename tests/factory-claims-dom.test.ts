// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { FactoryBoardView } from '../src/client/factory-board.js';
import { FactoryClaims, canTakeOver, claimStatus, heldBySession } from '../src/client/factory-claims.js';
import { cardStatus } from '../src/client/factory-overlay.js';
import { SessionListView, type SessionListViewHost } from '../src/client/session-list-view.js';
import type { FactoryBoard, FactoryBoardUnit, FactorySummary } from '../src/shared/protocol.js';
import type { SessionInfo } from '../src/client/session-types.js';

/**
 * Sessions holding factory units, in the browser (f-c4urw6): the drawer's Take
 * over / Open terminal / Return to factory / Done and the routes they call,
 * "session · you" and "paused · claimed by you" cards, the header's Return to
 * factory button (only for a session holding a claim), and the sidebar badge.
 */

const CWD = 'C:\\p\\alpha';

function unit(key: string, over: Partial<FactoryBoardUnit> = {}): FactoryBoardUnit {
  return {
    key,
    projectCwd: CWD,
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
    modelTier: null,
    stalled: null,
    heartbeatAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    claim: null,
    ...over,
    detail: {
      parkReason: null,
      verdict: null,
      questions: [],
      hasSummary: false,
      worktreePath: 'C:\\wt\\x',
      branch: 'factory/x',
      baseBranch: 'main',
      lastCommit: null,
      ...over.detail,
    },
  };
}

const UNITS = [
  unit('f-run'),
  unit('f-mine', { claim: { sessionId: 's-live', sessionName: 'history-search', live: true } }),
  unit('f-paused', { claim: { sessionId: 's-gone', sessionName: 'old', live: false } }),
  unit('f-merge', { column: 'merging', mergeStatus: 'queued' }),
  unit('f-triage', { column: 'intake', status: 'open', triage: true, needsYou: true }),
];

const BOARD: FactoryBoard = {
  units: UNITS,
  merges: [],
  counts: { running: 3, reviewing: 0, needsYou: 1, merging: 1, done: 0 },
  dispatch: { started: true, paused: null, capped: {}, seats: 3, running: 1 },
  tokensToday: 0,
  since: new Date().toISOString(),
};

let calls: { url: string; method: string; body: unknown }[];

const flush = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  calls = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, method: init?.method ?? 'GET', body: init?.body ? JSON.parse(String(init.body)) : undefined });
      const path = url.split('?')[0];
      if (path === '/api/factory/board') return new Response(JSON.stringify(BOARD), { status: 200 });
      if (path === '/api/factory/report') {
        return new Response(JSON.stringify({ since: '', landed: [], stalls: [], tokens: [], totalTokens: 0 }), { status: 200 });
      }
      if (path.endsWith('/take')) return new Response(JSON.stringify({ sessionId: 's-new' }), { status: 200 });
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    })
  );
});
afterEach(() => vi.unstubAllGlobals());

describe('the drawer', () => {
  let host: { takeMainArea: () => void; returnToMain: () => void; syncOverlay: () => void; openSession: ReturnType<typeof vi.fn>; sessionExists: (id: string) => boolean };
  let view: FactoryBoardView;

  beforeEach(() => {
    localStorage.clear();
    document.body.innerHTML = `<main><div id="factory-board-view" class="hidden"><span id="factory-board-status"></span>
      <div id="factory-board-body"></div><aside id="factory-drawer" class="hidden"></aside></div></main>`;
    host = { takeMainArea: vi.fn(), returnToMain: vi.fn(), syncOverlay: vi.fn(), openSession: vi.fn(), sessionExists: (id) => id === 's-live' };
    view = new FactoryBoardView(host);
    view.attach();
  });

  const drawer = () => document.getElementById('factory-drawer')!;
  async function open(key: string) {
    await view.show(key);
    await flush();
  }
  async function click(selector: string) {
    drawer().querySelector<HTMLElement>(selector)!.click();
    await flush();
    await flush();
  }
  const posts = () => calls.filter((c) => c.method === 'POST');

  it('offers Take over on a running unit, and opens the new terminal once it is taken', async () => {
    await open('f-run');
    expect(drawer().textContent).toContain('Take over in terminal');
    await click('[data-fb="take-over"]');
    expect(posts()).toEqual([{ url: '/api/factory/items/f-run/take', method: 'POST', body: { cwd: CWD } }]);
    expect(host.openSession).toHaveBeenCalledWith('s-new');
    expect(document.getElementById('factory-board-view')!.classList.contains('hidden')).toBe(true);
  });

  it('never offers Take over in the merge queue or triage', async () => {
    await open('f-merge');
    expect(drawer().querySelector('[data-fb="take-over"]')).toBeNull();
    await open('f-triage');
    expect(drawer().querySelector('[data-fb="take-over"]')).toBeNull();
  });

  it('shows a held unit as "session · you" with Open terminal, Return to factory and Done', async () => {
    await open('f-mine');
    expect(drawer().querySelector('.fb-chip.c')!.textContent).toBe('session · you');
    expect(drawer().textContent).toContain('your terminal');
    expect(drawer().querySelector('[data-fb="take-over"]')).toBeNull();
    await click('[data-fb="claim-open"]');
    expect(host.openSession).toHaveBeenCalledWith('s-live');
    await open('f-mine');
    await click('[data-fb="claim-return"]');
    expect(posts().pop()).toEqual({ url: '/api/factory/items/f-mine/return', method: 'POST', body: { cwd: CWD } });
    await click('[data-fb="claim-done"]');
    expect(posts().pop()).toEqual({ url: '/api/factory/items/f-mine/done', method: 'POST', body: { cwd: CWD } });
  });

  it('shows a closed terminal\'s unit as paused and still claimed by you', async () => {
    await open('f-paused');
    expect(drawer().querySelector('.fb-chip.c')!.textContent).toBe('paused · claimed by you');
    expect(drawer().textContent).toContain('terminal closed');
    // Its session's row is gone: no Open terminal, but it can still be returned.
    expect(drawer().querySelector('[data-fb="claim-open"]')).toBeNull();
    expect(drawer().querySelector('[data-fb="claim-return"]')).not.toBeNull();
  });
});

describe('cards and helpers', () => {
  it('a held unit\'s card line', () => {
    expect(cardStatus(UNITS[1])).toBe('session · you');
    expect(cardStatus(UNITS[2])).toBe('paused · claimed by you');
    expect(claimStatus(UNITS[0])).toBeNull();
  });

  it('take over needs a unit that has a worktree (or is a track), live and unheld', () => {
    expect(canTakeOver(UNITS[0])).toBe(true);
    expect(canTakeOver(unit('f-x', { detail: { worktreePath: null } as FactoryBoardUnit['detail'] }))).toBe(false);
    expect(canTakeOver(unit('track:T', { isTrack: true, detail: { worktreePath: null } as FactoryBoardUnit['detail'] }))).toBe(true);
    expect(canTakeOver(UNITS[1])).toBe(false);
  });

  it('maps sessions to what they hold', () => {
    const held = heldBySession([...UNITS, unit('track:Search', { isTrack: true, claim: { sessionId: 's-b', sessionName: null, live: true } })]);
    expect([...held.keys()]).toEqual(['s-live', 's-gone', 's-b']);
    expect(held.get('s-b')?.label).toBe('track');
    expect(held.get('s-live')?.label).toBe('f-mine');
  });
});

describe('the session header button', () => {
  let current: string | null;
  let onChange: ReturnType<typeof vi.fn>;
  let errors: string[];
  let claims: FactoryClaims;
  const summary = (units: FactoryBoardUnit[]): FactorySummary => ({ ...BOARD, units });
  const btn = () => document.getElementById('return-factory-btn')!;

  beforeEach(() => {
    document.body.innerHTML = '<button id="return-factory-btn" class="hidden">Return to factory</button>';
    current = 's-live';
    onChange = vi.fn();
    errors = [];
    claims = new FactoryClaims({ onChange, currentSessionId: () => current, showError: (m) => errors.push(m) });
    claims.attach();
  });

  it('shows only for a session holding a claim, and returns its unit', async () => {
    claims.update(summary(UNITS));
    expect(btn().classList.contains('hidden')).toBe(false);
    btn().click();
    await flush();
    expect(calls.pop()).toEqual({ url: '/api/factory/items/f-mine/return', method: 'POST', body: { cwd: CWD } });

    current = 'some-other';
    claims.syncHeader();
    expect(btn().classList.contains('hidden')).toBe(true);
  });

  it('re-renders the sidebar only when who holds what changes', () => {
    claims.update(summary(UNITS));
    claims.update(summary(UNITS));
    expect(onChange).toHaveBeenCalledTimes(1);
    claims.update(summary([UNITS[0]]));
    expect(onChange).toHaveBeenCalledTimes(2);
    expect(btn().classList.contains('hidden')).toBe(true);
  });
});

describe('the sidebar badge', () => {
  it('marks the row of a session holding a unit', () => {
    document.body.innerHTML = '<input id="session-filter"><ul id="session-list"></ul><div id="session-toast" hidden></div>';
    const session = (id: string): SessionInfo => ({
      id,
      name: id,
      shell: 'pwsh',
      cwd: 'C:\\p',
      createdAt: '2026-10-01T10:00:00.000Z',
      lastAccessedAt: '2026-10-01T10:00:00.000Z',
      status: 'active',
      cols: 80,
      rows: 24,
      attachable: true,
      categoryId: null,
      sortOrder: 0,
      isFork: false,
      claudeSessionId: null,
      spawnedBy: null,
      permissionMode: null,
    });
    const held = heldBySession(UNITS);
    const host: SessionListViewHost = {
      sessions: new Map([
        ['s-live', session('s-live')],
        ['plain', session('plain')],
      ]),
      categories: new Map(),
      sessionNotifications: new Map(),
      getCurrentSessionId: () => null,
      attachToSession: vi.fn(),
      reviveSession: vi.fn(),
      stopSession: vi.fn(),
      deleteSession: vi.fn(),
      moveSession: vi.fn(),
      toggleCategory: vi.fn(),
      deleteCategory: vi.fn(),
      showCategoryModal: vi.fn(),
      reorderSessions: vi.fn(),
      claimOf: (id) => held.get(id) ?? null,
    };
    new SessionListView(host).render();
    const badge = (id: string) => document.querySelector(`.session-item[data-session-id="${id}"] .session-claim`);
    expect(badge('s-live')?.textContent).toBe('f-mine');
    expect(badge('plain')).toBeNull();
  });
});
