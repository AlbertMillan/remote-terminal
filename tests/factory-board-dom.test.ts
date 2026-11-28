// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { FactoryBoardView, LAST_OPENED_KEY, cancellable, joinAnswers, readAddResult, renderMarkdown } from '../src/client/factory-board.js';
import type { FactoryBoard, FactoryBoardUnit, FactoryMergeSummary, FactoryReport } from '../src/shared/protocol.js';

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
      <button data-fb="add">Add work</button>
      <button data-fb="back">Back</button>
      <div id="factory-board-body"></div>
      <aside id="factory-drawer" class="hidden"></aside>
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
const drawer = () => document.getElementById('factory-drawer')!;
const click = async (selector: string, within: ParentNode = document) => {
  const el = within.querySelector<HTMLElement>(selector);
  if (!el) throw new Error(`no ${selector}`);
  el.click();
  await flush();
  await flush();
};
const lastPost = () => calls.filter((c) => c.method === 'POST').pop();

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
  view = new FactoryBoardView(host);
  view.attach();
});

describe('the board', () => {
  it('takes the main area and lays the units out in six columns', async () => {
    await open();
    expect(host.takeMainArea).toHaveBeenCalled();
    expect(document.getElementById('factory-board-view')!.classList.contains('hidden')).toBe(false);
    const column = (id: string) => [...document.querySelectorAll<HTMLElement>(`[data-column="${id}"] [data-unit-key]`)].map((c) => c.dataset.unitKey);
    expect(column('intake')).toEqual(['f-intake', 'f-triage', 'f-ask']);
    expect(column('ready')).toEqual(['f-ready']);
    expect(column('running')).toEqual(['track:History search', 'f-cap']);
    expect(column('review')).toEqual(['f-agent', 'f-esc']);
    expect(column('merging')).toEqual(['f-merge']);
    expect(column('done')).toEqual(['f-done']);
    expect(document.querySelector('[data-column="review"] h3')!.textContent).toContain('agent 1 · you 1');
    // A session's Land has no unit: its own card in Merging.
    expect(document.querySelector('[data-column="merging"] [data-merge-card="mq-2"]')).not.toBeNull();
    expect(document.getElementById('factory-board-status')!.textContent).toContain('dispatcher on · 2/3 seats');
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
    const options = [...drawer().querySelectorAll('option')].map((o) => o.textContent);
    expect(options).toEqual(['alpha', 'beta']);
    drawer().querySelector<HTMLTextAreaElement>('textarea')!.value = '- android push should retry on 503, but do not spam';
    await click('[data-fb="submit-add"]', drawer());
    expect(lastPost()).toEqual({
      url: '/api/factory/add',
      method: 'POST',
      body: { cwd: CWD, text: '- android push should retry on 503, but do not spam' },
    });
    expect(drawer().querySelector('.fb-intake')!.textContent).toContain('Android push retries on 503');
    expect(drawer().querySelector('.fb-intake')!.textContent).toContain('requirement: back off, no spam');
  });

  it('refuses empty text without calling the server', async () => {
    await view.show(undefined, true);
    await flush();
    await click('[data-fb="submit-add"]', drawer());
    expect(calls.some((c) => c.url === '/api/factory/add')).toBe(false);
    expect(drawer().querySelector('.fb-notice.error')).not.toBeNull();
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
