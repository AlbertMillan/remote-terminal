// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { FactoryBoardView } from '../src/client/factory-board.js';
import { frameSrc, isMockupPark, type MockupInfo } from '../src/client/factory-mockup.js';
import type { FactoryBoard, FactoryBoardUnit } from '../src/shared/protocol.js';

/**
 * The mockup drawer (project/code-factory.md, f-ib2d86): an item parked at
 * its mockup shows the page in a sandboxed frame with Open full size, Approve
 * and Comment, each calling its route; Add work's "Mockup first" checkbox
 * reaches the add route. fetch is a fake; nothing reaches a server.
 */

const DOM = `
  <main id="main-content">
    <div id="factory-board-view" class="hidden">
      <span id="factory-board-status"></span>
      <button data-fb="add">Add work</button>
      <div id="factory-board-body"></div>
      <div id="factory-side"></div>
      <aside id="factory-drawer" class="fb-pane hidden"></aside>
      <div id="factory-add" class="hidden"></div>
    </div>
  </main>`;

const CWD = 'C:\\p\\alpha';
const ID = 'f-mock01';
const URL_ = `/api/factory/mockup/0be1f5b3/${ID}/index.html`;

function unit(over: Partial<FactoryBoardUnit> = {}): FactoryBoardUnit {
  return {
    key: ID,
    projectCwd: CWD,
    projectName: 'alpha',
    unitId: ID,
    isTrack: false,
    trackName: 'Inbox',
    title: 'Dark mode toggle',
    featureIds: [ID],
    column: 'running',
    status: 'parked',
    step: 'mockup',
    needsYou: true,
    reviewer: null,
    escalated: false,
    triage: false,
    reason: 'mockup: ready for your approval',
    features: [],
    waitsFor: [],
    mergeId: null,
    mergeStatus: null,
    tokens: 0,
    modelTier: null,
    stalled: null,
    heartbeatAt: null,
    updatedAt: '2026-11-26T10:00:00.000Z',
    ...over,
    detail: {
      parkReason: 'mockup: ready for your approval',
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

const INFO: MockupInfo = {
  featureId: ID,
  url: URL_,
  walkthrough: "## What you'd do\n- Open Settings\n- Flip the toggle",
  revisions: 0,
  maxRevisions: 3,
  waiting: true,
  approved: false,
};

let board: FactoryBoard;
let info: MockupInfo;
let calls: { url: string; method: string; body: unknown }[];
let view: FactoryBoardView;

const flush = async () => {
  for (let i = 0; i < 4; i++) await new Promise((r) => setTimeout(r, 0));
};
const drawer = () => document.getElementById('factory-drawer')!;
const addModal = () => document.getElementById('factory-add')!;
const posts = () => calls.filter((c) => c.method === 'POST');

beforeEach(() => {
  // No morning report: these tests are about the drawer.
  localStorage.clear();
  document.body.innerHTML = DOM;
  calls = [];
  info = { ...INFO };
  board = {
    units: [unit()],
    merges: [],
    counts: { running: 0, reviewing: 0, needsYou: 1, merging: 0, done: 0 },
    dispatch: { started: true, paused: null, capped: {}, seats: 3, running: 0 },
    tokensToday: 0,
    since: new Date().toISOString(),
  };
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, method: init?.method ?? 'GET', body: init?.body ? JSON.parse(String(init.body)) : undefined });
      const path = url.split('?')[0];
      const data =
        path === '/api/factory/board'
          ? board
          : path === '/api/factory/mockup'
            ? info
            : path === '/api/projects/registry'
              ? { registry: { projects: [{ cwd: CWD, name: 'alpha' }] } }
              : path === '/api/factory/add'
                ? { features: [{ featureId: 'f-new', title: 'T', requirements: [], mockupFirst: true }] }
                : { ok: true };
      return new Response(JSON.stringify(data), { status: 200 });
    })
  );
  view = new FactoryBoardView({ takeMainArea: vi.fn(), returnToMain: vi.fn(), syncOverlay: vi.fn() });
  view.attach();
});

async function openUnit() {
  await view.show(ID);
  await flush();
}

describe('the mockup drawer', () => {
  it('knows a mockup park, and gives each revision its own frame address', () => {
    expect(isMockupPark(unit())).toBe(true);
    expect(isMockupPark(unit({ step: 'review' }))).toBe(false);
    expect(isMockupPark(unit({ status: 'in_progress' }))).toBe(false);
    expect(isMockupPark(unit({ isTrack: true }))).toBe(false);
    expect(frameSrc({ ...INFO, revisions: 2 })).toBe(`${URL_}?r=2`);
    expect(frameSrc({ ...INFO, url: null })).toBeNull();
  });

  it('shows the mockup in a sandboxed frame, Open full size in a new tab, and the walkthrough, in a wide pane', async () => {
    await openUnit();
    expect(calls.some((c) => c.url === `/api/factory/mockup?cwd=${encodeURIComponent(CWD)}&unit=${ID}`)).toBe(true);
    const frame = drawer().querySelector<HTMLIFrameElement>('iframe.fb-mockup-frame')!;
    expect(frame.getAttribute('sandbox')).toBe('allow-scripts');
    expect(frame.getAttribute('src')).toBe(`${URL_}?r=0`);
    const open = drawer().querySelector<HTMLAnchorElement>('[data-mockup-open]')!;
    expect(open.getAttribute('href')).toBe(`${URL_}?r=0`);
    expect(open.getAttribute('target')).toBe('_blank');
    expect(open.getAttribute('rel')).toContain('noopener');
    expect(drawer().textContent).toContain('Mockup waiting for your approval');
    expect([...drawer().querySelectorAll('.fb-md li')].map((li) => li.textContent)).toEqual(['Open Settings', 'Flip the toggle']);
    // The docked pane's column widens for the page.
    expect(document.getElementById('factory-board-view')!.classList.contains('fb-pane-wide')).toBe(true);
    // The generic park's "Release for another round" is not offered over a mockup.
    expect(drawer().querySelector('[data-fb="release"]')).toBeNull();
  });

  it('keeps the same frame across a pushed reload, so the page is not reloaded under you', async () => {
    await openUnit();
    const frame = drawer().querySelector('iframe');
    view.onSummary();
    await flush();
    expect(calls.filter((c) => c.url.startsWith('/api/factory/board')).length).toBe(2);
    expect(drawer().querySelector('iframe')).toBe(frame);
  });

  it('Approve releases it as approved', async () => {
    await openUnit();
    drawer().querySelector<HTMLElement>('[data-fb="mockup-approve"]')!.click();
    await flush();
    expect(posts()).toEqual([{ url: `/api/factory/items/${ID}/release`, method: 'POST', body: { cwd: CWD, outcome: 'approved' } }]);
  });

  it('Comment sends the text to the mockup session and clears it; an empty one is refused here', async () => {
    await openUnit();
    drawer().querySelector<HTMLElement>('[data-fb="mockup-comment"]')!.click();
    await flush();
    expect(posts()).toEqual([]);
    expect(drawer().textContent).toContain('Say what the mockup should change first.');

    drawer().querySelector<HTMLTextAreaElement>('textarea[data-draft]')!.value = 'Put the toggle at the top';
    drawer().querySelector<HTMLElement>('[data-fb="mockup-comment"]')!.click();
    await flush();
    expect(posts()).toEqual([
      { url: `/api/factory/items/${ID}/mockup/comment`, method: 'POST', body: { cwd: CWD, text: 'Put the toggle at the top' } },
    ]);
    expect(drawer().querySelector<HTMLTextAreaElement>('textarea[data-draft]')?.value ?? '').toBe('');
  });

  it('at the revision cap it escalates: no comment box, Approve stays, and Cancel is offered', async () => {
    info = { ...INFO, revisions: 3 };
    await openUnit();
    expect(drawer().textContent).toContain('Mockup escalated to you');
    expect(drawer().textContent).toContain('revision 3 of 3');
    expect(drawer().querySelector('[data-fb="mockup-comment"]')).toBeNull();
    expect(drawer().querySelector('[data-fb="mockup-approve"]')).not.toBeNull();
    expect(drawer().querySelector('[data-fb="view"][data-view="cancel"]')).not.toBeNull();
  });

  it('with no page yet it offers to build it again (a release with no outcome)', async () => {
    info = { ...INFO, url: null, walkthrough: null };
    board.units = [unit({ detail: { parkReason: 'mockup: the run wrote no index.html' } as FactoryBoardUnit['detail'] })];
    await openUnit();
    expect(drawer().querySelector('iframe')).toBeNull();
    expect(drawer().textContent).toContain('wrote no index.html');
    drawer().querySelector<HTMLElement>('[data-fb="release"]')!.click();
    await flush();
    expect(posts()).toEqual([{ url: `/api/factory/items/${ID}/release`, method: 'POST', body: { cwd: CWD } }]);
  });
});

describe("Add work's Mockup first checkbox", () => {
  async function submit(checked: boolean) {
    await view.show(undefined, true);
    await flush();
    addModal().querySelector<HTMLTextAreaElement>('[data-draft="add:text"]')!.value = 'dark mode';
    addModal().querySelector<HTMLInputElement>('[data-draft="add:mockup"]')!.checked = checked;
    addModal().querySelector<HTMLElement>('[data-fb="submit-add"]')!.click();
    await flush();
    return posts().find((c) => c.url === '/api/factory/add')?.body;
  }

  it('sends mockupFirst when ticked', async () => {
    expect(await submit(true)).toEqual({ cwd: CWD, text: 'dark mode', mockupFirst: true });
    expect(addModal().textContent).toContain('mockup first');
  });

  it('leaves it out when not', async () => {
    expect(await submit(false)).toEqual({ cwd: CWD, text: 'dark mode' });
  });
});
