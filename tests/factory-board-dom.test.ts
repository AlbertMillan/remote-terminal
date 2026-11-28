// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { FactoryBoardView, LAST_OPENED_KEY, cancellable, joinAnswers, readAddResult, renderMarkdown } from '../src/client/factory-board.js';
import { looseMerges, stageGroups, startBlocker } from '../src/client/factory-board-pipeline.js';
import { needsYouUnits } from '../src/client/factory-board-needs.js';
import { UNDO_MS } from '../src/client/factory-decisions.js';
import { VIEW_MODE_KEY, flowLanes, readViewMode } from '../src/client/factory-board-flow.js';
import { phoneStage, phoneStageGroups, planTile } from '../src/client/factory-board-phone.js';
import type { PlanUsage } from '../src/client/plan-usage-chip.js';
import { FakeClock } from './helpers/fake-clock.js';
import { silenceIframePageLoads } from './helpers/happy-dom-iframe.js';
import type { FactoryBoard, FactoryBoardUnit, FactoryColumn, FactoryMergeSummary, FactoryReport } from '../src/shared/protocol.js';

silenceIframePageLoads();

/**
 * The factory board (project/code-factory.md, f-5clssc): its columns, each
 * drawer and the route each action calls (the factory's other half's routes —
 * add, answer, triage — are mocked here like ours), Add work, and the morning
 * report. fetch is a fake; nothing reaches a server.
 */

const DOM = `
  <main id="main-content">
    <div id="terminal-container"></div>
    <div id="factory-board-view" class="hidden">
      <span id="factory-board-status"></span>
      <button data-fb="view-mode" data-mode="board">Board</button>
      <button data-fb="view-mode" data-mode="flow">Flow</button>
      <button data-fb="add">Add work</button>
      <button data-fb="back">Back</button>
      <div class="fb-split">
        <div id="factory-board-body"></div>
        <div class="fb-right">
          <div id="factory-side"></div>
          <aside id="factory-drawer" class="hidden"></aside>
        </div>
      </div>
      <div id="factory-add" class="hidden"></div>
      <div id="factory-board-toasts"></div>
      <nav id="factory-phone-tabs" class="hidden"></nav>
    </div>
  </main>`;

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
    tokens: 1200,
    modelTier: 'sonnet',
    stalled: null,
    heartbeatAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...over,
    detail: {
      parkReason: null,
      verdict: null,
      questions: [],
      hasSummary: false,
      worktreePath: 'C:\\wt\\x',
      branch: 'factory/x',
      baseBranch: 'main',
      lastCommit: 'abcdef1234567',
      ...over.detail,
    },
  };
}

const merge: FactoryMergeSummary = {
  id: 'mq-1',
  projectCwd: CWD,
  projectName: 'alpha',
  kind: 'item',
  title: 'Tab leaves the folder field',
  branch: 'factory/tab-f-z9le4c',
  featureIds: ['f-z9le4c'],
  status: 'parked',
  detail: 'The resolver could not settle the conflict',
  conflictPaths: ['src/client/session-manager.ts'],
  mergeSha: null,
  updatedAt: new Date().toISOString(),
};

const land: FactoryMergeSummary = { ...merge, id: 'mq-2', kind: 'session-land', title: 'History search', status: 'queued', conflictPaths: [], detail: null };

const UNITS: FactoryBoardUnit[] = [
  unit('f-intake', { column: 'intake', status: 'open', step: null }),
  unit('f-triage', { column: 'intake', status: 'open', triage: true, needsYou: true, step: 'triage' }),
  unit('f-ask', {
    column: 'intake',
    status: 'parked',
    needsYou: true,
    step: 'shape',
    reason: 'shape: a question for you',
    detail: { questions: [{ id: 'q1', question: 'Keep the old title?', options: ['yes', 'no'], default: 'no' }] } as FactoryBoardUnit['detail'],
  }),
  unit('f-ready', { column: 'ready', status: 'open', waitsFor: ['f-intake'] }),
  unit('track:History search', {
    isTrack: true,
    trackName: 'History search',
    title: 'History search',
    featureIds: ['f-h1', 'f-h2'],
    features: [
      { id: 'f-h1', title: 'Index transcripts', state: 'done' },
      { id: 'f-h2', title: 'Search API', state: 'now' },
    ],
  }),
  unit('f-agent', { column: 'review', step: 'review', reviewer: 'agent' }),
  unit('f-esc', {
    column: 'review',
    status: 'parked',
    step: 'review',
    reviewer: 'you',
    needsYou: true,
    escalated: true,
    title: 'Admit tailnet devices by tag',
    reason: 'review: escalated: touches auth/access-gate.ts',
    detail: {
      parkReason: 'review: escalated: touches auth/access-gate.ts\n\nReviewer: approve',
      verdict: 'Reviewer: approve',
      hasSummary: true,
    } as FactoryBoardUnit['detail'],
  }),
  unit('f-cap', { column: 'running', status: 'parked', step: 'fix', needsYou: true, reason: 'fix ran 2 times', detail: { parkReason: 'fix ran 2 times without settling it' } as FactoryBoardUnit['detail'] }),
  unit('f-merge', { column: 'merging', mergeId: 'mq-1', mergeStatus: 'parked', status: 'parked', needsYou: true }),
  unit('f-done', { column: 'done', status: 'done' }),
];

const BOARD: FactoryBoard = {
  units: UNITS,
  merges: [merge, land],
  counts: { running: 4, reviewing: 1, needsYou: 4, merging: 1, done: 1 },
  dispatch: { started: true, paused: null, capped: {}, seats: 3, running: 2 },
  tokensToday: 1_900_000,
  since: new Date().toISOString(),
};

const REPORT: FactoryReport = {
  since: new Date(Date.now() - 10 * 3600_000).toISOString(),
  landed: [{ ...merge, id: 'mq-9', status: 'merged', mergeSha: 'abc1234def', title: 'Revive after Build & restart' }],
  stalls: [unit('f-ready', { stalled: 'ready and unclaimed for 40m with a seat free' })],
  tokens: [{ projectName: 'alpha', title: 'History search', tokens: 640_000 }],
  totalTokens: 640_000,
};

interface Call {
  url: string;
  method: string;
  body: unknown;
}

let calls: Call[];
let responses: Record<string, unknown>;
let host: { takeMainArea: ReturnType<typeof vi.fn>; returnToMain: ReturnType<typeof vi.fn>; syncOverlay: ReturnType<typeof vi.fn> };
let view: FactoryBoardView;

function respond(url: string): unknown {
  const path = url.split('?')[0];
  if (path in responses) return responses[path];
  if (path === '/api/factory/board') return BOARD;
  if (path === '/api/factory/report') return REPORT;
  if (path === '/api/factory/summary') return { markdown: '# Summary\n- New setting auth.allowedTags\n\n## Assumptions\n- Tags match exactly' };
  if (path === '/api/factory/diff') return { range: 'main...HEAD', stat: ' a.ts | 2 +-', patch: 'diff --git a/a.ts b/a.ts', truncated: false };
  if (path === '/api/projects/registry') return { registry: { projects: [{ cwd: CWD, name: 'alpha' }, { cwd: 'C:\\p\\beta' }] } };
  // The add route's real answer (server factory/intake.ts).
  if (path === '/api/factory/add') {
    return {
      features: [{ featureId: 'f-r7qq2e', title: 'Android push retries on 503', requirements: ['back off, no spam'], mockupFirst: false }],
      order: [],
    };
  }
  return { ok: true };
}

const flush = () => new Promise((r) => setTimeout(r, 0));
/** The docked detail pane (it keeps the drawer's element id). */
const drawer = () => document.getElementById('factory-drawer')!;
const addModal = () => document.getElementById('factory-add')!;
const root = () => document.getElementById('factory-board-view')!;
const dots = () => [...drawer().querySelectorAll<HTMLElement>('.fb-dots li')].map((li) => li.dataset.dot);
const click = async (selector: string, within: ParentNode = document) => {
  const el = within.querySelector<HTMLElement>(selector);
  if (!el) throw new Error(`no ${selector}`);
  el.click();
  await flush();
  await flush();
};
const lastPost = () => calls.filter((c) => c.method === 'POST').pop();
/** The selected stage's rows: a unit's key, or `merge:<id>` for a loose merge entry (a Ready row sits in a line with Start now). */
const rows = () =>
  [...document.querySelectorAll<HTMLElement>('[data-stage-rows] > .fb-row, [data-stage-rows] > .fb-row-line > .fb-row')].map(
    (r) => r.dataset.unitKey ?? `merge:${r.dataset.mergeCard}`
  );
const need = (key: string) => [...document.querySelectorAll<HTMLElement>('[data-need]')].find((el) => el.dataset.need === key)!;

async function open(key?: string) {
  await view.show(key);
  await flush();
}

beforeEach(() => {
  localStorage.clear();
  document.body.innerHTML = DOM;
  calls = [];
  responses = {};
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, method: init?.method ?? 'GET', body: init?.body ? JSON.parse(String(init.body)) : undefined });
      return new Response(JSON.stringify(respond(url)), { status: 200 });
    })
  );
  host = { takeMainArea: vi.fn(), returnToMain: vi.fn(), syncOverlay: vi.fn() };
  // No Undo window for the route tests: a decision sends at once. 'Undo on decisions' uses a real one.
  view = new FactoryBoardView(host, { undoMs: 0 });
  view.attach();
});

describe('the board', () => {
  it("selects the opened unit's stage, whichever stage was picked last, and lists its row", async () => {
    await open();
    await click('[data-fb="stage"][data-stage="done"]');
    expect(document.querySelector('.fb-stage.on')!.getAttribute('data-stage')).toBe('done');
    // Already on screen: opening another unit moves the picker to its stage.
    await open('f-esc');
    expect(document.querySelector('.fb-stage.on')!.getAttribute('data-stage')).toBe('review');
    expect(rows()).toContain('f-esc');
    expect(document.querySelector('[data-stage-rows="review"] .fb-row.open')!.getAttribute('data-unit-key')).toBe('f-esc');
    // Once: picking another stage afterwards sticks, even through a pushed reload.
    await click('[data-fb="stage"][data-stage="intake"]');
    await view.load();
    expect(document.querySelector('.fb-stage.on')!.getAttribute('data-stage')).toBe('intake');
    // A fresh visit on a unit in another stage.
    view.hide();
    await open('f-ready');
    expect(document.querySelector('.fb-stage.on')!.getAttribute('data-stage')).toBe('ready');
    expect(rows()).toEqual(['f-ready']);
  });

  it('waits for the board data when the unit is not known yet, then selects its stage', async () => {
    const pending = view.show('f-merge');
    await pending;
    await flush();
    expect(document.querySelector('.fb-stage.on')!.getAttribute('data-stage')).toBe('merging');
    expect(rows()).toContain('f-merge');
  });

  it('takes the main area and opens the Pipeline at Running', async () => {
    await open();
    expect(host.takeMainArea).toHaveBeenCalled();
    expect(document.getElementById('factory-board-view')!.classList.contains('hidden')).toBe(false);
    expect(document.querySelector('.fb-stage.on')!.getAttribute('data-stage')).toBe('running');
    expect(rows()).toEqual(['track:History search', 'f-cap']);
    expect(document.getElementById('factory-board-status')!.textContent).toContain('dispatcher on · 2/3 seats');
  });

  it("lists each stage's units as rows when its tab is clicked, loose merges under Merging", async () => {
    await open();
    const expected: Record<string, string[]> = {
      intake: ['f-intake', 'f-triage', 'f-ask'],
      ready: ['f-ready'],
      running: ['track:History search', 'f-cap'],
      review: ['f-agent', 'f-esc'],
      // A session's Land has no unit: its own row in Merging.
      merging: ['f-merge', 'merge:mq-2'],
      done: ['f-done'],
    };
    for (const [stage, keys] of Object.entries(expected)) {
      await click(`[data-fb="stage"][data-stage="${stage}"]`);
      expect(document.querySelector('.fb-stage.on')!.getAttribute('data-stage')).toBe(stage);
      expect(rows()).toEqual(keys);
    }
    const tab = (id: string) => document.querySelector(`[data-fb="stage"][data-stage="${id}"]`)!;
    expect(tab('review').textContent).toContain('agent 1 · you 1');
    expect(tab('merging').querySelector('em')!.textContent).toBe('2');
    // Amber: a stage holding a unit that waits for you.
    expect(['intake', 'ready', 'running', 'review', 'merging', 'done'].filter((id) => tab(id).classList.contains('you'))).toEqual([
      'intake',
      'running',
      'review',
      'merging',
    ]);
  });

  it('opens a unit from its row, and says when a stage is empty', async () => {
    responses['/api/factory/board'] = { ...BOARD, units: UNITS.filter((u) => u.column !== 'ready') };
    await open();
    await click('[data-stage-rows] [data-unit-key="f-cap"]');
    expect(drawer().classList.contains('hidden')).toBe(false);
    expect(drawer().textContent).toContain('fix ran 2 times without settling it');
    await click('[data-fb="stage"][data-stage="ready"]');
    expect(document.querySelector('[data-stage-rows]')!.textContent).toContain('Nothing in Ready.');
  });

  it('fetches again on a pushed summary only while on screen, and Back leaves', async () => {
    await open();
    const boards = () => calls.filter((c) => c.url.startsWith('/api/factory/board')).length;
    const before = boards();
    view.onSummary();
    await flush();
    expect(boards()).toBe(before + 1);
    await click('[data-fb="back"]');
    expect(host.returnToMain).toHaveBeenCalled();
    view.onSummary();
    await flush();
    expect(boards()).toBe(before + 1);
  });
});

describe('Needs you', () => {
  const mockupUnit = unit('f-mock', { column: 'intake', status: 'parked', step: 'mockup', needsYou: true, reason: 'mockup: waiting for your approval' });

  it('lists every unit that waits for you, each with its decision inline', async () => {
    responses['/api/factory/board'] = { ...BOARD, units: [...UNITS, mockupUnit] };
    await open();
    const cards = [...document.querySelectorAll<HTMLElement>('.fb-needs [data-need]')].map((c) => [c.dataset.need, c.dataset.needKind]);
    expect(cards).toEqual([
      ['f-triage', 'triage'],
      ['f-ask', 'question'],
      ['f-esc', 'review'],
      ['f-cap', 'other'],
      ['f-merge', 'other'],
      ['f-mock', 'mockup'],
    ]);
    expect(document.querySelector('.fb-needs h3')!.textContent).toContain('6');
    const buttons = (key: string) => [...need(key).querySelectorAll('.fb-acts button')].map((b) => b.textContent!.trim());
    expect(buttons('f-triage')).toEqual(['Accept', 'Backlog', 'Dismiss']);
    expect(buttons('f-ask')).toEqual(['yes', 'no', 'Other…']);
    expect(need('f-ask').querySelector('[data-value="no"]')!.className).toBe('btn-primary');
    expect(need('f-ask').textContent).toContain('Keep the old title?');
    expect(buttons('f-esc')).toEqual(['Approve', 'Open']);
    expect(buttons('f-mock')).toEqual(['Build it', 'Open']);
    expect(buttons('f-cap')).toEqual(['Open']);
  });

  it('is hidden when nothing waits for you, with no placeholder', async () => {
    responses['/api/factory/board'] = { ...BOARD, units: UNITS.filter((u) => !u.needsYou) };
    await open();
    expect(document.querySelector('.fb-needs')).toBeNull();
    expect(document.querySelector('.fb-pipeline')).not.toBeNull();
    expect(document.getElementById('factory-board-body')!.textContent).not.toContain('Needs you');
  });

  it('approves a review inline, with no drawer open', async () => {
    await open();
    await click('[data-fb="approve"]', need('f-esc'));
    expect(lastPost()).toEqual({ url: '/api/factory/items/f-esc/release', method: 'POST', body: { cwd: CWD, outcome: 'approved' } });
    expect(drawer().classList.contains('hidden')).toBe(true);
  });

  it("acts on the card's unit even while the drawer shows another", async () => {
    await open('f-cap');
    await click('[data-fb="triage"][data-action="backlog"]', need('f-triage'));
    expect(lastPost()).toEqual({ url: '/api/factory/triage/f-triage', method: 'POST', body: { cwd: CWD, action: 'backlog' } });
  });

  it('answers a single question by its option', async () => {
    await open();
    await click('[data-fb="answer-option"][data-value="yes"]', need('f-ask'));
    expect(lastPost()).toEqual({ url: '/api/factory/items/f-ask/answer', method: 'POST', body: { cwd: CWD, answer: 'yes' } });
  });

  it('sends several questions, or Other, to the drawer', async () => {
    const two = unit('f-two', {
      column: 'intake',
      status: 'parked',
      needsYou: true,
      step: 'shape',
      detail: {
        questions: [
          { id: 'a', question: 'Q1?', options: ['x'], default: null },
          { id: 'b', question: 'Q2?', options: ['y'], default: null },
        ],
      } as FactoryBoardUnit['detail'],
    });
    responses['/api/factory/board'] = { ...BOARD, units: [two, ...UNITS] };
    await open();
    expect(need('f-two').textContent).toContain('2 questions');
    expect(need('f-two').querySelector('[data-fb="answer-option"]')).toBeNull();
    await click('[data-unit-key="f-two"].btn-secondary', need('f-two'));
    expect(drawer().querySelectorAll('fieldset.fb-question')).toHaveLength(2);
    await click('[data-unit-key="f-ask"].btn-secondary', need('f-ask'));
    expect(drawer().querySelector('input[value="__other"]')).not.toBeNull();
    expect(calls.filter((c) => c.method === 'POST')).toEqual([]);
  });

  it('builds a mockup inline: the release route, approved', async () => {
    responses['/api/factory/board'] = { ...BOARD, units: [mockupUnit] };
    await open();
    await click('[data-fb="mockup-approve"]', need('f-mock'));
    expect(lastPost()).toEqual({ url: '/api/factory/items/f-mock/release', method: 'POST', body: { cwd: CWD, outcome: 'approved' } });
  });
});

describe('Undo on decisions', () => {
  // The real 5 s window on a fake clock: time moves only when a test lets the toasts expire.
  let clock: FakeClock;
  const expire = async () => {
    clock.advance(UNDO_MS);
    await flush();
    await flush();
  };
  const posts = () => calls.filter((c) => c.method === 'POST');
  const toasts = () => [...document.querySelectorAll('#factory-board-toasts .fb-toast span')].map((s) => s.textContent);
  const count = (stage: string) => document.querySelector(`[data-fb="stage"][data-stage="${stage}"] em`)!.textContent;
  const mockupUnit = unit('f-mock', { column: 'intake', status: 'parked', step: 'mockup', needsYou: true, reason: 'mockup: waiting for your approval' });
  const approveEsc = { url: '/api/factory/items/f-esc/release', method: 'POST', body: { cwd: CWD, outcome: 'approved' } };

  beforeEach(() => {
    // A fresh root: the suite's default view (no Undo window) must not handle these clicks too.
    document.body.innerHTML = DOM;
    clock = new FakeClock();
    view = new FactoryBoardView(host, { clock });
    view.attach();
  });

  it('Approve resolves the card at once and the Review count drops; Undo restores it and sends nothing', async () => {
    await open();
    expect(count('review')).toBe('2');
    await click('[data-fb="approve"]', need('f-esc'));
    expect(need('f-esc')).toBeUndefined();
    expect(count('review')).toBe('1');
    expect(count('merging')).toBe('3');
    expect(toasts()).toEqual(['Approved: it moves to Merging']);
    expect(posts()).toEqual([]);
    await click('#factory-board-toasts [data-fb="undo"]');
    expect(need('f-esc')).toBeDefined();
    expect(count('review')).toBe('2');
    expect(toasts()).toEqual([]);
    expect(document.querySelector('.fb-main > .fb-notice')!.textContent).toBe('Undone: nothing was sent');
    await expire();
    expect(posts()).toEqual([]);
  });

  it('sends when the toast expires, keeping the unit resolved across a pushed reload meanwhile', async () => {
    await open();
    await click('[data-fb="approve"]', need('f-esc'));
    view.onSummary();
    await flush();
    await flush();
    // The pushed board still has it waiting for you: the pending decision wins.
    expect(need('f-esc')).toBeUndefined();
    await expire();
    await flush();
    expect(posts()).toEqual([approveEsc]);
    expect(toasts()).toEqual([]);
  });

  it('leaving the board sends what waits at once', async () => {
    await open();
    await click('[data-fb="approve"]', need('f-esc'));
    expect(posts()).toEqual([]);
    await click('[data-fb="back"]');
    expect(host.returnToMain).toHaveBeenCalled();
    expect(posts()).toEqual([approveEsc]);
  });

  it('pagehide sends what waits, with keepalive so the request outlives the page', async () => {
    await open();
    await click('[data-fb="approve"]', need('f-esc'));
    window.dispatchEvent(new Event('pagehide'));
    await flush();
    expect(posts()).toEqual([approveEsc]);
    const init = vi.mocked(fetch).mock.calls.find(([url]) => url === approveEsc.url)![1] as RequestInit;
    expect(init.keepalive).toBe(true);
  });

  it('Answer, Build it and triage Accept wait the same way; Send back moves the unit to Running', async () => {
    responses['/api/factory/board'] = { ...BOARD, units: [...UNITS, mockupUnit] };
    await open();
    expect(count('running')).toBe('2');
    await click('[data-fb="answer-option"][data-value="yes"]', need('f-ask'));
    await click('[data-fb="triage"][data-action="accept"]', need('f-triage'));
    await click('[data-fb="mockup-approve"]', need('f-mock'));
    await click('[data-unit-key="f-esc"].btn-secondary', need('f-esc'));
    await click('[data-view="changes"]', drawer());
    drawer().querySelector<HTMLTextAreaElement>('textarea')!.value = 'Allow tag wildcards';
    await click('[data-fb="send-changes"]', drawer());
    expect(posts()).toEqual([]);
    expect(toasts()).toEqual([
      'Answered: shaping goes on in Intake',
      'Accepted: it moves to Intake for shaping',
      'Mockup approved: it moves to Running to be built',
      'Sent back: it moves to Running for the fix step',
    ]);
    expect(count('running')).toBe('4');
    expect(dots()).toEqual(['done', 'done', 'now', 'todo', 'todo', 'todo']);
    expect(['f-ask', 'f-triage', 'f-mock', 'f-esc'].map((k) => need(k))).toEqual([undefined, undefined, undefined, undefined]);
    await expire();
    await flush();
    expect(posts().map((p) => [p.url, p.body])).toEqual([
      ['/api/factory/items/f-ask/answer', { cwd: CWD, answer: 'yes' }],
      ['/api/factory/triage/f-triage', { cwd: CWD, action: 'accept' }],
      ['/api/factory/items/f-mock/release', { cwd: CWD, outcome: 'approved' }],
      ['/api/factory/items/f-esc/release', { cwd: CWD, outcome: 'changes', note: 'Allow tag wildcards' }],
    ]);
  });

  it('keeps a sent-back note as a draft until it lands, so Undo gives it back', async () => {
    await open('f-esc');
    await click('[data-view="changes"]', drawer());
    drawer().querySelector<HTMLTextAreaElement>('textarea')!.value = 'Allow tag wildcards';
    await click('[data-fb="send-changes"]', drawer());
    await click('#factory-board-toasts [data-fb="undo"]');
    await click('[data-view="changes"]', drawer());
    expect(drawer().querySelector<HTMLTextAreaElement>('textarea')!.value).toBe('Allow tag wildcards');
  });

  it('hides Needs you after the last decision', async () => {
    responses['/api/factory/board'] = { ...BOARD, units: UNITS.filter((u) => !u.needsYou || u.key === 'f-esc') };
    await open();
    expect(document.querySelector('.fb-needs')).not.toBeNull();
    await click('[data-fb="approve"]', need('f-esc'));
    expect(document.querySelector('.fb-needs')).toBeNull();
  });

  it('a refused send brings the unit back and says why', async () => {
    vi.mocked(fetch).mockImplementation(async (url, init) => {
      calls.push({ url: String(url), method: init?.method ?? 'GET', body: init?.body ? JSON.parse(String(init.body)) : undefined });
      if (String(url).endsWith('/release')) return new Response(JSON.stringify({ error: 'f-esc is not parked' }), { status: 409 });
      return new Response(JSON.stringify(respond(String(url))), { status: 200 });
    });
    await open();
    await click('[data-fb="approve"]', need('f-esc'));
    await expire();
    await flush();
    await flush();
    expect(need('f-esc')).toBeDefined();
    expect(document.querySelector('.fb-main > .fb-notice.error')!.textContent).toBe('f-esc is not parked');
  });
});

describe('Flow view', () => {
  const BETA = 'C:\\p\\beta';
  const lanesOf = () =>
    [...document.querySelectorAll<HTMLElement>('.fb-flow-row[data-lane]')].map((row) => [
      row.querySelector('.fb-lane-name b')!.textContent,
      Object.fromEntries(
        [...row.querySelectorAll<HTMLElement>('[data-lane-stage]')]
          .map((cell) => [cell.dataset.laneStage, [...cell.querySelectorAll<HTMLElement>('.fb-tag')].map((t) => t.dataset.unitKey ?? `merge:${t.dataset.mergeCard}`)])
          .filter(([, tags]) => tags.length > 0)
      ),
    ]);

  it('groups track units one lane per project and track, then one Inbox lane per project for loose items', () => {
    const units = [
      unit('track:History search', { isTrack: true, trackName: 'History search' }),
      unit('f-a', { trackName: 'Core' }),
      unit('track:History search@beta', { isTrack: true, trackName: 'History search', projectCwd: BETA, projectName: 'beta' }),
      unit('f-b', { projectCwd: BETA, projectName: 'beta' }),
      unit('track:Auth', { isTrack: true, trackName: 'Auth', column: 'review' }),
    ];
    const orphan: FactoryMergeSummary = { ...land, id: 'mq-7', title: 'Gone track' };
    const lanes = flowLanes({ units, merges: [land, orphan] });
    expect(lanes.map((l) => [l.name, l.projectName, l.units.map((u) => u.key), l.merges.map((m) => m.id)])).toEqual([
      // A session's Land sits in the lane of the track it lands.
      ['History search', 'alpha', ['track:History search'], ['mq-2']],
      ['History search', 'beta', ['track:History search@beta'], []],
      ['Auth', 'alpha', ['track:Auth'], []],
      // Loose items share their project's Inbox, whatever track they were filed into; so does an entry with no lane.
      ['Inbox', 'alpha', ['f-a'], ['mq-7']],
      ['Inbox', 'beta', ['f-b'], []],
    ]);
    expect(lanes.every((l) => l.inbox === (l.name === 'Inbox'))).toBe(true);
    // An entry whose unit is on the board is drawn with the unit, never twice.
    expect(flowLanes({ units: UNITS, merges: [merge] }).flatMap((l) => l.merges)).toEqual([]);
  });

  it('reads a stored choice, Board by default', () => {
    expect(readViewMode('flow')).toBe('flow');
    expect(readViewMode('board')).toBe('board');
    expect(readViewMode(null)).toBe('board');
    expect(readViewMode('columns')).toBe('board');
  });

  it('toggles to lanes with each unit at its stage, Needs you still above, and back', async () => {
    await open();
    expect(document.querySelector('[data-mode="board"]')!.getAttribute('aria-pressed')).toBe('true');
    await click('[data-fb="view-mode"][data-mode="flow"]');
    expect(document.querySelector('[data-mode="flow"]')!.getAttribute('aria-pressed')).toBe('true');
    expect(document.querySelector('.fb-pipeline')).toBeNull();
    expect(document.querySelector('.fb-needs + .fb-flow')).not.toBeNull();
    expect(lanesOf()).toEqual([
      ['History search', { running: ['track:History search'], merging: ['merge:mq-2'] }],
      [
        'Inbox',
        {
          intake: ['f-intake', 'f-triage', 'f-ask'],
          ready: ['f-ready'],
          running: ['f-cap'],
          review: ['f-agent', 'f-esc'],
          merging: ['f-merge'],
          done: ['f-done'],
        },
      ],
    ]);
    // The track's tag names the feature it is at.
    expect(document.querySelector('.fb-tag[data-unit-key="track:History search"]')!.textContent).toContain('Search API');
    expect(document.querySelector('.fb-flow-row[data-lane^="inbox:"]')!.classList.contains('you')).toBe(true);
    await click('[data-fb="view-mode"][data-mode="board"]');
    expect(document.querySelector('.fb-flow')).toBeNull();
    expect(document.querySelector('.fb-pipeline')).not.toBeNull();
  });

  it('opens a lane tag in the detail pane', async () => {
    await open();
    await click('[data-fb="view-mode"][data-mode="flow"]');
    await click('.fb-tag[data-unit-key="f-cap"]');
    expect(drawer().classList.contains('hidden')).toBe(false);
    expect(drawer().querySelector('h3')!.textContent).toBe('Unit f-cap');
    expect(document.querySelector('.fb-tag.open')!.getAttribute('data-unit-key')).toBe('f-cap');
    await click('.fb-tag[data-merge-card="mq-2"]');
    expect(drawer().textContent).toContain('queued');
  });

  it('remembers the choice in this browser: a reload opens in Flow', async () => {
    await open();
    await click('[data-fb="view-mode"][data-mode="flow"]');
    expect(localStorage.getItem(VIEW_MODE_KEY)).toBe('flow');
    // A reload: a fresh page and view, the same storage.
    document.body.innerHTML = DOM;
    view = new FactoryBoardView(host, { undoMs: 0 });
    view.attach();
    await open();
    expect(document.querySelector('.fb-flow')).not.toBeNull();
    expect(document.querySelector('[data-mode="flow"]')!.classList.contains('on')).toBe(true);
  });
});

describe('Start now', () => {
  const free = unit('f-free', { column: 'ready', status: 'open', step: null, title: 'Free to start' });
  const startButton = (key: string) => document.querySelector<HTMLButtonElement>(`[data-fb="start-now"][data-unit="${key}"]`)!;
  const withDispatch = (dispatch: Partial<FactoryBoard['dispatch']>) =>
    (responses['/api/factory/board'] = { ...BOARD, units: [...UNITS, free], dispatch: { ...BOARD.dispatch, ...dispatch } });

  async function openReady() {
    await open();
    await click('[data-fb="stage"][data-stage="ready"]');
  }

  it('offers Start now on Ready rows only, and posts the item with its project', async () => {
    withDispatch({});
    await openReady();
    expect(rows()).toEqual(['f-ready', 'f-free']);
    expect(startButton('f-free').disabled).toBe(false);
    await click('[data-fb="start-now"][data-unit="f-free"]');
    expect(lastPost()).toEqual({ url: '/api/factory/items/f-free/start', method: 'POST', body: { cwd: CWD } });
    expect(document.querySelector('.fb-main > .fb-notice')!.textContent).toBe('Started now: it moves to Running');
    await click('[data-fb="stage"][data-stage="running"]');
    expect(document.querySelector('[data-fb="start-now"]')).toBeNull();
  });

  it('disables it, saying why, when the board can tell it would be refused', async () => {
    withDispatch({});
    await openReady();
    // f-ready waits for a blocker.
    expect(startButton('f-ready').disabled).toBe(true);
    expect(startButton('f-ready').title).toBe('Waits for f-intake');
    const reasonFor = async (dispatch: Partial<FactoryBoard['dispatch']>) => {
      withDispatch(dispatch);
      view.onSummary();
      await flush();
      await flush();
      return [startButton('f-free').disabled, startButton('f-free').title];
    };
    expect(await reasonFor({ running: 3 })).toEqual([true, 'No free seat: 3 of 3 busy']);
    expect(await reasonFor({ paused: '3 waiting for you' })).toEqual([true, 'Dispatch is paused: 3 waiting for you']);
    expect(await reasonFor({ capped: { [CWD]: '5-hour usage at 85% (cap 80%)' } })).toEqual([true, 'Over the plan-usage cap: 5-hour usage at 85% (cap 80%)']);
    expect(await reasonFor({ started: false })).toEqual([true, 'The dispatcher is off']);
    expect(await reasonFor({})).toEqual([false, 'Claim a free seat for it now, ahead of the priority order']);
    expect(calls.filter((c) => c.method === 'POST')).toEqual([]);
  });

  it("shows the server's refusal", async () => {
    withDispatch({});
    await openReady();
    vi.mocked(fetch).mockImplementationOnce(async () => new Response(JSON.stringify({ error: 'No free seat in this project: 2 of 2 busy' }), { status: 409 }));
    await click('[data-fb="start-now"][data-unit="f-free"]');
    expect(document.querySelector('.fb-main > .fb-notice.error')!.textContent).toBe('No free seat in this project: 2 of 2 busy');
  });

  it('works out the blocker from the dispatch state and the unit', () => {
    const d = BOARD.dispatch;
    expect(startBlocker(free, d)).toBeNull();
    expect(startBlocker({ ...free, claim: { sessionId: 's', sessionName: 'x', live: true } }, d)).toBe('A terminal session holds it');
  });

  it('is on the phone too: a Ready item listed under Running', async () => {
    withDispatch({});
    document.body.innerHTML = DOM;
    view = new FactoryBoardView(host, { undoMs: 0, isPhone: () => true });
    view.attach();
    await open();
    await click('[data-fb="phone-tab"][data-tab="flow"]');
    expect(rows()).toContain('f-free');
    expect(startButton('f-free').disabled).toBe(false);
  });
});

describe('phone layout', () => {
  const usage: PlanUsage = {
    accounts: [
      { account: 'personal', snapshot: { fiveHour: { usedPercentage: 42.4, resetsAt: 0, observedAt: '' }, sevenDay: { usedPercentage: 18, resetsAt: 0, observedAt: '' } }, setup: { command: null } },
      { account: 'work', snapshot: { fiveHour: { usedPercentage: 86, resetsAt: 0, observedAt: '' }, sevenDay: null }, setup: { command: null } },
    ],
  };
  let clock: FakeClock;
  const tabs = () => [...document.querySelectorAll<HTMLElement>('#factory-phone-tabs [data-tab]')].map((t) => [t.dataset.tab, t.classList.contains('on')]);
  const tile = (id: string) => document.querySelector<HTMLElement>(`[data-tile="${id}"]`)!;
  const phoneStages = () =>
    [...document.querySelectorAll<HTMLElement>('.fb-phone-stage')].map((b) => [b.dataset.stage, b.querySelector('em')!.textContent, b.classList.contains('you')]);

  beforeEach(() => {
    document.body.innerHTML = DOM;
    clock = new FakeClock();
    view = new FactoryBoardView({ ...host, planUsage: () => usage }, { clock, isPhone: () => true });
    view.attach();
  });

  it('folds Ready into Running for the phone, four stages, and maps a desktop stage onto them', () => {
    const groups = phoneStageGroups(stageGroups({ units: UNITS, merges: [merge, land] }));
    expect(groups.map((g) => [g.id, g.units.map((u) => u.key), g.you])).toEqual([
      ['intake', ['f-intake', 'f-triage', 'f-ask'], 2],
      ['running', ['track:History search', 'f-cap', 'f-ready'], 1],
      ['review', ['f-agent', 'f-esc'], 1],
      ['merging', ['f-merge'], 1],
    ]);
    expect(groups.find((g) => g.id === 'merging')!.merges.map((m) => m.id)).toEqual(['mq-2']);
    expect(['ready', 'done', 'review'].map((s) => phoneStage(s as FactoryColumn))).toEqual(['running', 'running', 'review']);
  });

  it("reads the plan tile from the highest 5-hour reading, with that login's week", () => {
    expect(planTile(usage)).toEqual({ value: '86%', note: '5-hour · week — · work', level: 'warn' });
    expect(planTile({ accounts: [usage.accounts[0]] })).toEqual({ value: '42%', note: '5-hour · week 18%', level: 'ok' });
    expect(planTile(null)).toEqual({ value: '—', note: 'no reading yet', level: '' });
  });

  it('opens on You: tiles, Needs you and a running preview, with no side panel or desktop Pipeline', async () => {
    await open();
    expect(root().classList.contains('fb-phone')).toBe(true);
    expect(document.getElementById('factory-phone-tabs')!.classList.contains('hidden')).toBe(false);
    expect(tabs()).toEqual([
      ['you', true],
      ['flow', false],
      ['done', false],
    ]);
    expect(document.querySelector('[data-tab="you"] em')!.textContent).toBe('5');
    expect(tile('plan').textContent).toContain('86%');
    expect(tile('plan').classList.contains('warn')).toBe(true);
    expect(tile('running').querySelector('b')!.textContent).toBe('2');
    expect(tile('running').textContent).toContain('2 of 3 seats');
    expect(tile('merging').querySelector('b')!.textContent).toBe('2');
    expect(document.querySelector('.fb-needs')).not.toBeNull();
    expect([...document.querySelectorAll<HTMLElement>('.fb-preview .fb-row')].map((r) => r.dataset.unitKey)).toEqual(['track:History search', 'f-cap']);
    expect(document.querySelector('.fb-pipeline')).toBeNull();
    expect(document.querySelector('.fb-side')).toBeNull();
    expect(document.getElementById('factory-side')!.classList.contains('hidden')).toBe(true);
  });

  it('the running preview opens Flow at Running; stage buttons show counts, amber where work waits for you', async () => {
    await open();
    await click('.fb-preview [data-fb="phone-flow"]');
    expect(tabs().find(([, on]) => on)![0]).toBe('flow');
    expect(phoneStages()).toEqual([
      ['intake', '3', true],
      ['running', '3', true],
      ['review', '2', true],
      ['merging', '2', true],
    ]);
    expect(document.querySelector('.fb-phone-stage.on')!.getAttribute('data-stage')).toBe('running');
    expect(rows()).toEqual(['track:History search', 'f-cap', 'f-ready']);
    // The track's card carries its progress dots.
    expect(document.querySelector('[data-unit-key="track:History search"] .fo-prog')).not.toBeNull();
    await click('.fb-phone-stage[data-stage="merging"]');
    expect(rows()).toEqual(['f-merge', 'merge:mq-2']);
    // The You tiles lead into Flow as well.
    await click('[data-fb="phone-tab"][data-tab="you"]');
    await click('[data-tile="running"]');
    expect(document.querySelector('.fb-phone-stage.on')!.getAttribute('data-stage')).toBe('running');
  });

  it('Done lists what merged today and what happened since you last looked', async () => {
    const last = new Date(Date.now() - 10 * 3600_000).toISOString();
    localStorage.setItem(LAST_OPENED_KEY, last);
    responses['/api/factory/board'] = { ...BOARD, merges: [merge, { ...land, status: 'merged', mergeSha: 'abc1234' }] };
    await open();
    await click('[data-fb="phone-tab"][data-tab="done"]');
    expect(rows()).toEqual(['f-done', 'merge:mq-2']);
    expect(document.querySelector('.fb-done .fb-report')!.textContent).toContain('Revive after Build & restart');
  });

  it('opens the detail pane as a sheet with sticky Approve, Request changes and Take over; Take over asks first', async () => {
    await open();
    await click('.fb-needs [data-need="f-esc"] .fb-title');
    expect(root().classList.contains('fb-pane-open')).toBe(true);
    const bar = drawer().querySelector('.fb-sticky')!;
    expect([...bar.querySelectorAll('button')].map((b) => b.textContent!.trim())).toEqual(['Approve', 'Request changes', 'Take over', 'Open diff']);
    // Only the sticky bar offers it: no second Take over below.
    expect(drawer().querySelectorAll('[data-view="take-over"]')).toHaveLength(1);
    expect(drawer().querySelector('[data-fb="take-over"]')).toBeNull();
    await click('[data-view="take-over"]', bar);
    expect(drawer().textContent).toContain('Take this over in a terminal?');
    expect(calls.filter((c) => c.method === 'POST')).toEqual([]);
    await click('[data-fb="view"][data-view="main"]', drawer());
    await click('[data-view="take-over"]', drawer());
    await click('[data-fb="take-over"]', drawer());
    expect(lastPost()).toEqual({ url: '/api/factory/items/f-esc/take', method: 'POST', body: { cwd: CWD } });
  });

  it("asks first on a running unit's Take over too, from a sticky block", async () => {
    await open('track:History search');
    const takeOver = drawer().querySelector<HTMLElement>('.fb-sticky [data-view="take-over"]')!;
    expect(takeOver.textContent).toBe('Take over in terminal');
    expect(drawer().querySelector('[data-fb="take-over"]')).toBeNull();
  });

  it("says where a decision's unit went in Flow, and the toast takes you there", async () => {
    await open();
    await click('[data-fb="approve"]', need('f-esc'));
    const go = document.querySelector<HTMLElement>('#factory-board-toasts [data-fb="phone-flow"]')!;
    expect(go.textContent).toBe('Flow: Merging');
    await click('#factory-board-toasts [data-fb="phone-flow"]');
    expect(tabs().find(([, on]) => on)![0]).toBe('flow');
    expect(document.querySelector('.fb-phone-stage.on')!.getAttribute('data-stage')).toBe('merging');
    expect(rows()).toContain('f-esc');
    // Triage Dismiss leaves the board: no Flow stage to point to.
    await click('[data-fb="phone-tab"][data-tab="you"]');
    await click('[data-fb="triage"][data-action="dismiss"]', need('f-triage'));
    const dismissed = [...document.querySelectorAll<HTMLElement>('#factory-board-toasts .fb-toast')].pop()!;
    expect(dismissed.querySelector('[data-fb="phone-flow"]')).toBeNull();
  });

  it('opens Add work in its modal (full-screen on a phone)', async () => {
    await view.show(undefined, true);
    await flush();
    expect(root().classList.contains('fb-phone')).toBe(true);
    expect(addModal().classList.contains('hidden')).toBe(false);
    expect(addModal().querySelector('[data-fb="submit-add"]')).not.toBeNull();
  });

  it('keeps the desktop layout off a phone: no tab bar, Take over at once', async () => {
    document.body.innerHTML = DOM;
    view = new FactoryBoardView(host, { undoMs: 0, isPhone: () => false });
    view.attach();
    await open('track:History search');
    expect(root().classList.contains('fb-phone')).toBe(false);
    expect(document.getElementById('factory-phone-tabs')!.classList.contains('hidden')).toBe(true);
    expect(document.querySelector('.fb-pipeline')).not.toBeNull();
    expect(drawer().querySelector('[data-fb="take-over"]')).not.toBeNull();
    expect(drawer().querySelector('.fb-sticky')).toBeNull();
  });
});

describe('the side panel', () => {
  it('shows capacity and the merge queue, and opens an entry from it', async () => {
    await open();
    const side = document.querySelector('.fb-side')!;
    expect(side.querySelector('.fb-capacity')!.textContent).toContain('2 of 3 busy');
    expect(side.querySelectorAll('.fb-seats i.busy')).toHaveLength(2);
    expect(side.querySelector('.fb-capacity')!.textContent).toContain('1.9M');
    const queue = [...side.querySelectorAll<HTMLElement>('.fb-queue [data-merge-card]')].map((b) => b.dataset.mergeCard);
    expect(queue).toEqual(['mq-1', 'mq-2']);
    await click('.fb-queue [data-merge-card="mq-1"]');
    expect(drawer().textContent).toContain('The resolver could not settle the conflict');
  });

  it('says why dispatch is paused and which projects plan usage caps', async () => {
    responses['/api/factory/board'] = { ...BOARD, dispatch: { ...BOARD.dispatch, paused: 'spending cap reached', capped: { [CWD]: 'weekly limit at 95%' } } };
    await open();
    const cap = document.querySelector('.fb-capacity')!.textContent!;
    expect(cap).toContain('paused');
    expect(cap).toContain('spending cap reached');
    expect(cap).toContain('weekly limit at 95%');
  });
});

describe('stage grouping', () => {
  it('groups units by column and loose merges under Merging until merged, then Done', () => {
    const merged: FactoryMergeSummary = { ...land, id: 'mq-3', status: 'merged' };
    const groups = stageGroups({ units: UNITS, merges: [merge, land, merged] });
    const by = Object.fromEntries(groups.map((g) => [g.id, { units: g.units.map((u) => u.key), merges: g.merges.map((m) => m.id), you: g.you }]));
    expect(groups.map((g) => g.id)).toEqual(['intake', 'ready', 'running', 'review', 'merging', 'done']);
    // mq-1 belongs to f-merge: listed with its unit, never twice.
    expect(by.merging).toEqual({ units: ['f-merge'], merges: ['mq-2'], you: 1 });
    expect(by.done).toEqual({ units: ['f-done'], merges: ['mq-3'], you: 0 });
    expect(by.intake.you).toBe(2);
    expect(by.ready.you).toBe(0);
    expect(looseMerges({ units: UNITS, merges: [merge, land] }).map((m) => m.id)).toEqual(['mq-2']);
  });

  it('counts a parked loose merge as waiting for you', () => {
    const groups = stageGroups({ units: [], merges: [{ ...land, status: 'parked' }] });
    expect(groups.find((g) => g.id === 'merging')!.you).toBe(1);
  });

  it('lists only units that need you and are not done', () => {
    expect(needsYouUnits(UNITS).map((u) => u.key)).toEqual(['f-triage', 'f-ask', 'f-esc', 'f-cap', 'f-merge']);
    expect(needsYouUnits([unit('x', { needsYou: true, column: 'done' })])).toEqual([]);
  });
});

describe('drawers', () => {
  it('shows an escalated review with its summary page, and Approve releases it as approved', async () => {
    await open('f-esc');
    await flush();
    const text = drawer().textContent!;
    expect(text).toContain('Escalated to you');
    expect(text).toContain('touches auth/access-gate.ts');
    expect(text).toContain('Reviewer: approve');
    expect(drawer().querySelector('.fb-md h4')!.textContent).toBe('Summary');
    expect(drawer().querySelector('.fb-md li')!.textContent).toBe('New setting auth.allowedTags');
    await click('[data-fb="approve"]', drawer());
    expect(lastPost()).toEqual({ url: '/api/factory/items/f-esc/release', method: 'POST', body: { cwd: CWD, outcome: 'approved' } });
  });

  it('requests changes with a note, which survives a pushed re-render', async () => {
    await open('f-esc');
    await click('[data-view="changes"]', drawer());
    const box = drawer().querySelector<HTMLTextAreaElement>('textarea')!;
    box.value = 'Allow tag wildcards';
    box.focus();
    view.onSummary();
    await flush();
    await flush();
    expect(drawer().querySelector<HTMLTextAreaElement>('textarea')!.value).toBe('Allow tag wildcards');
    await click('[data-fb="send-changes"]', drawer());
    expect(lastPost()).toEqual({
      url: '/api/factory/items/f-esc/release',
      method: 'POST',
      body: { cwd: CWD, outcome: 'changes', note: 'Allow tag wildcards' },
    });
  });

  it('opens the diff', async () => {
    await open('f-esc');
    await click('[data-view="diff"]', drawer());
    await flush();
    expect(calls.some((c) => c.url.startsWith('/api/factory/diff?cwd=') && c.url.includes('unit=f-esc'))).toBe(true);
    expect(drawer().querySelector('.fb-diff')!.textContent).toBe('diff --git a/a.ts b/a.ts');
  });

  it('answers a shaping question with its default preselected', async () => {
    await open('f-ask');
    const radios = [...drawer().querySelectorAll<HTMLInputElement>('input[type="radio"]')];
    expect(radios.find((r) => r.checked)?.value).toBe('no');
    expect(drawer().textContent).toContain('(default)');
    await click('[data-fb="answer"]', drawer());
    expect(lastPost()).toEqual({ url: '/api/factory/items/f-ask/answer', method: 'POST', body: { cwd: CWD, answer: 'no' } });
  });

  it('answers with your own words under Other', async () => {
    await open('f-ask');
    drawer().querySelector<HTMLInputElement>('input[value="__other"]')!.checked = true;
    drawer().querySelector<HTMLInputElement>('input[type="text"]')!.value = 'Only on forks';
    await click('[data-fb="answer"]', drawer());
    expect(lastPost()?.body).toEqual({ cwd: CWD, answer: 'Only on forks' });
  });

  it('triages: accept, backlog, dismiss', async () => {
    await open('f-triage');
    for (const action of ['accept', 'backlog', 'dismiss']) {
      // Each from a fresh pane: Backlog and Dismiss take the unit off the page, and close its pane.
      view.hide();
      await open('f-triage');
      await click(`[data-fb="triage"][data-action="${action}"]`, drawer());
      expect(lastPost()).toEqual({ url: '/api/factory/triage/f-triage', method: 'POST', body: { cwd: CWD, action } });
    }
  });

  it("shows a running track's features in order, the current one marked", async () => {
    await open('track:History search');
    const items = [...drawer().querySelectorAll('.fb-features li')].map((li) => [li.className, li.textContent!.replace(/\s+/g, ' ').trim()]);
    expect(items).toEqual([
      ['done', '✓ Index transcripts'],
      ['now', '… Search API (now)'],
    ]);
    expect(drawer().textContent).toContain('1 agent · sonnet');
  });

  it("shows a merge entry's park and retries it", async () => {
    await open('f-merge');
    expect(drawer().textContent).toContain('The resolver could not settle the conflict');
    expect(drawer().textContent).toContain('src/client/session-manager.ts');
    await click('[data-fb="retry-merge"]', drawer());
    expect(lastPost()).toEqual({ url: '/api/factory/merges/mq-1/retry', method: 'POST', body: {} });
  });

  it('releases a loop-cap park for another round, with no outcome', async () => {
    await open('f-cap');
    expect(drawer().textContent).toContain('fix ran 2 times without settling it');
    await click('[data-fb="release"]', drawer());
    expect(lastPost()).toEqual({ url: '/api/factory/items/f-cap/release', method: 'POST', body: { cwd: CWD } });
  });

  it('cancels a parked unit after a confirm step, and Keep it backs out', async () => {
    await open('f-cap');
    await click('[data-fb="view"][data-view="cancel"]', drawer());
    expect(drawer().textContent).toContain('Cancel this item?');
    expect(drawer().textContent).toContain('Its worktree and branch are removed');
    await click('[data-fb="view"][data-view="main"]', drawer());
    expect(calls.filter((c) => c.method === 'POST')).toEqual([]);
    await click('[data-fb="view"][data-view="cancel"]', drawer());
    await click('[data-fb="cancel-unit"]', drawer());
    expect(lastPost()).toEqual({ url: '/api/factory/items/f-cap/cancel', method: 'POST', body: { cwd: CWD } });
    expect(drawer().querySelector('[data-fb="cancel-unit"]')).toBeNull();
  });

  it('offers Cancel on a parked merge, a running track and a review, never on a merge under way or claimed work', () => {
    const u = (key: string) => BOARD.units.find((x) => x.key === key)!;
    expect(cancellable(u('f-merge'))).toBe(true);
    expect(cancellable(u('f-esc'))).toBe(true);
    expect(cancellable(u('track:History search'))).toBe(true);
    expect(cancellable(u('f-triage'))).toBe(false);
    expect(cancellable(u('f-done'))).toBe(false);
    expect(cancellable({ ...u('f-merge'), mergeStatus: 'running', status: 'open' })).toBe(false);
    expect(cancellable({ ...u('f-cap'), claim: { sessionId: 's-1', sessionName: 'x', live: true } })).toBe(false);
  });

  it("shows a refusal from the server in the drawer", async () => {
    await open('f-cap');
    vi.mocked(fetch).mockImplementationOnce(async () => new Response(JSON.stringify({ error: 'f-cap is not parked' }), { status: 409 }));
    await click('[data-fb="release"]', drawer());
    expect(drawer().querySelector('.fb-notice.error')!.textContent).toBe('f-cap is not parked');
  });

  it('opens a session Land from its card', async () => {
    await open();
    await click('[data-merge-card="mq-2"]');
    expect(drawer().textContent).toContain('History search');
    expect(drawer().textContent).toContain('queued');
  });
});

describe('Add work', () => {
  it('files free-form text through intake and shows what it parsed', async () => {
    await view.show(undefined, true);
    await flush();
    await flush();
    const options = [...addModal().querySelectorAll('option')].map((o) => o.textContent);
    expect(options).toEqual(['alpha', 'beta']);
    addModal().querySelector<HTMLTextAreaElement>('textarea')!.value = '- android push should retry on 503, but do not spam';
    await click('[data-fb="submit-add"]', addModal());
    expect(lastPost()).toEqual({
      url: '/api/factory/add',
      method: 'POST',
      body: { cwd: CWD, text: '- android push should retry on 503, but do not spam' },
    });
    expect(addModal().querySelector('.fb-intake')!.textContent).toContain('Android push retries on 503');
    expect(addModal().querySelector('.fb-intake')!.textContent).toContain('requirement: back off, no spam');
  });

  it('refuses empty text without calling the server', async () => {
    await view.show(undefined, true);
    await flush();
    await click('[data-fb="submit-add"]', addModal());
    expect(calls.some((c) => c.url === '/api/factory/add')).toBe(false);
    expect(addModal().querySelector('.fb-notice.error')).not.toBeNull();
  });

  it('is a modal over the board: the pane and its unit stay as they were, × and Escape close it', async () => {
    await open('f-cap');
    await click('[data-fb="add"]');
    expect(addModal().classList.contains('hidden')).toBe(false);
    expect(addModal().querySelector('[role="dialog"]')).not.toBeNull();
    expect(drawer().classList.contains('hidden')).toBe(false);
    expect(drawer().textContent).toContain('fix ran 2 times without settling it');
    await click('[data-fb="close-add"]', addModal());
    expect(addModal().classList.contains('hidden')).toBe(true);
    expect(drawer().classList.contains('hidden')).toBe(false);
    await click('[data-fb="add"]');
    root().dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(addModal().classList.contains('hidden')).toBe(true);
    // The modal went first; the pane is still open.
    expect(drawer().classList.contains('hidden')).toBe(false);
  });
});

describe('the docked detail pane', () => {
  it("opens beside the board in the side panel's place, never over it, and closing brings the panel back", async () => {
    await open();
    expect(document.querySelector('#factory-side .fb-side')).not.toBeNull();
    await click('[data-stage-rows] [data-unit-key="track:History search"]');
    expect(drawer().classList.contains('hidden')).toBe(false);
    expect(root().classList.contains('fb-pane-open')).toBe(true);
    // The pane takes the side panel's column; the board stays rendered and usable.
    expect(document.getElementById('factory-side')!.classList.contains('hidden')).toBe(true);
    expect(document.querySelector('#factory-side .fb-side')).toBeNull();
    expect(document.querySelector('.fb-needs')).not.toBeNull();
    expect(document.querySelector('.fb-row.open')!.getAttribute('data-unit-key')).toBe('track:History search');
    await click('[data-fb="close"]', drawer());
    expect(drawer().classList.contains('hidden')).toBe(true);
    expect(root().classList.contains('fb-pane-open')).toBe(false);
    expect(document.querySelector('#factory-side .fb-side')).not.toBeNull();
  });

  it('opens from a Needs you card, a row and a side-panel link, and Escape closes it', async () => {
    localStorage.setItem(LAST_OPENED_KEY, new Date(Date.now() - 3600_000).toISOString());
    await open();
    await click('.fb-needs [data-need="f-esc"] .fb-title');
    expect(drawer().querySelector('h3')!.textContent).toBe('Admit tailnet devices by tag');
    expect(document.querySelector('.fb-need.open')!.getAttribute('data-need')).toBe('f-esc');
    await click('[data-stage-rows] [data-unit-key="f-cap"]');
    expect(drawer().querySelector('h3')!.textContent).toBe('Unit f-cap');
    // The report's stall link lives in the side panel, which the pane replaces: close first.
    await click('[data-fb="close"]', drawer());
    await click('.fb-report [data-unit-key="f-ready"]');
    expect(drawer().querySelector('h3')!.textContent).toBe('Unit f-ready');
    root().dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(drawer().classList.contains('hidden')).toBe(true);
  });

  it('shows stage dots: stages passed, where the unit is (amber when it waits for you), still ahead', async () => {
    await open('track:History search');
    expect(dots()).toEqual(['done', 'done', 'now', 'todo', 'todo', 'todo']);
    expect(drawer().querySelector('.fb-dots')!.getAttribute('aria-label')).toBe('Stage: Running');
    await click('[data-unit-key="f-esc"]', document.querySelector('.fb-needs')!);
    expect(dots()).toEqual(['done', 'done', 'done', 'you', 'todo', 'todo']);
    await click('[data-fb="stage"][data-stage="intake"]');
    await click('[data-stage-rows] [data-unit-key="f-intake"]');
    expect(dots()).toEqual(['now', 'todo', 'todo', 'todo', 'todo', 'todo']);
    await click('[data-fb="stage"][data-stage="done"]');
    await click('[data-stage-rows] [data-unit-key="f-done"]');
    expect(dots()).toEqual(['done', 'done', 'done', 'done', 'done', 'now']);
  });

  it('shows a merge entry with its dots at Merging, amber while parked', async () => {
    await open();
    await click('.fb-queue [data-merge-card="mq-1"]');
    expect(dots()).toEqual(['done', 'done', 'done', 'done', 'you', 'todo']);
    expect(drawer().textContent).toContain('Retry merge');
  });

  it('keeps every view: summary page, diff, request changes and cancel, each with Back', async () => {
    await open('f-esc');
    await click('[data-fb="view"][data-view="diff"]', drawer());
    await flush();
    expect(drawer().querySelector('.fb-diff')).not.toBeNull();
    expect(drawer().querySelector('.fb-dots')).not.toBeNull();
    await click('[data-fb="view"][data-view="main"]', drawer());
    await click('[data-fb="view"][data-view="changes"]', drawer());
    expect(drawer().querySelector('textarea[data-draft="changes:f-esc"]')).not.toBeNull();
    await click('[data-fb="view"][data-view="main"]', drawer());
    await click('[data-fb="view"][data-view="cancel"]', drawer());
    expect(drawer().textContent).toContain('Cancel this item?');
  });
});

describe('the morning report', () => {
  it('says what landed, what stalls and the tokens since the last visit, then counts from now', async () => {
    const last = new Date(Date.now() - 10 * 3600_000).toISOString();
    localStorage.setItem(LAST_OPENED_KEY, last);
    await open();
    expect(calls.some((c) => c.url === `/api/factory/report?since=${encodeURIComponent(last)}`)).toBe(true);
    const report = document.querySelector('.fb-report')!;
    expect(report.textContent).toContain('Revive after Build & restart');
    expect(report.textContent).toContain('abc1234');
    expect(report.textContent).toContain('ready and unclaimed for 40m with a seat free');
    expect(report.textContent).toContain('History search');
    expect(report.textContent).toContain('640k');
    expect(Date.parse(localStorage.getItem(LAST_OPENED_KEY)!)).toBeGreaterThan(Date.parse(last));
    await click('[data-fb="dismiss-report"]');
    expect(document.querySelector('.fb-report')).toBeNull();
  });

  it('shows nothing on the first visit', async () => {
    await open();
    expect(calls.some((c) => c.url.startsWith('/api/factory/report'))).toBe(false);
    expect(document.querySelector('.fb-report')).toBeNull();
    expect(localStorage.getItem(LAST_OPENED_KEY)).not.toBeNull();
  });
});

describe('helpers', () => {
  it('renders a summary page as escaped blocks', () => {
    const out = renderMarkdown('# Title\n- <b>x</b>\n\ntext\n```\ncode\n```').value;
    expect(out).toBe('<h4>Title</h4><ul><li>&lt;b&gt;x&lt;/b&gt;</li></ul><p>text</p><pre class="fb-pre">code</pre>');
  });

  it('joins answers one per question, all required', () => {
    const qs = [
      { id: 'a', question: 'Q1?', options: [], default: null },
      { id: 'b', question: 'Q2?', options: [], default: null },
    ];
    expect(joinAnswers(qs.slice(0, 1), ['yes'])).toBe('yes');
    expect(joinAnswers(qs, ['yes', 'no'])).toBe('1) Q1?\n   yes\n2) Q2?\n   no');
    expect(joinAnswers(qs, ['yes', ' '])).toBeNull();
  });

  it("reads the add route's answer: featureId, title, requirements, mockupFirst", () => {
    const data = {
      features: [
        { featureId: 'f-1', title: 'T', requirements: ['r1', 7], mockupFirst: true },
        { title: 'no id' },
      ],
      order: [],
    };
    expect(readAddResult(data)).toEqual({ features: [{ id: 'f-1', title: 'T', requirements: ['r1'], mockupFirst: true }] });
    expect(readAddResult({})).toEqual({ features: [] });
  });
});
