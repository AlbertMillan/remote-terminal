// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { JobBoard, type Job, type JobDoc } from '../src/client/job-board.js';

/**
 * Folding the document pane on a job card.
 *
 * The rules worth pinning down are all about the difference between "loaded"
 * and "on screen", which only exists as DOM: a pane the board fetched on its
 * own starts folded, the fold is a class over a cache nothing discards, and
 * anything that opens a document has to unfold the pane it lives in — a scroll
 * into a `display: none` container silently does nothing.
 */

const CWD = 'C:\\p\\demo';
const NOW = new Date().toISOString();

const DETAIL = `- **Should the pane start folded when the board loads it?** §3.2 says a pane the
  board loaded on its own starts folded. Options: (a) start folded; (b) start open.
  **Recommend (a)**: the answer box belongs above the list.`;

const DOCS: JobDoc[] = [
  {
    path: 'project/spec.md',
    status: 'added',
    insertions: 40,
    deletions: 0,
    isSpec: true,
    headings: ['3', '3.2'],
  },
  {
    path: 'project/QA.md',
    status: 'unchanged',
    insertions: 0,
    deletions: 0,
    isSpec: false,
    headings: [],
  },
];

const DOC_TEXT = ['# Spec', '', '### 3.2 Folding', '', 'A pane starts folded.'].join('\n');

function parkedJob(over: Partial<Job> = {}): Job {
  return {
    id: 'j1',
    projectCwd: CWD,
    featureId: 'f-ab12cd',
    title: 'Collapsible document pane',
    status: 'parked',
    stage: 'design',
    gate: null,
    approvedGate: null,
    parkReason: 'question',
    detail: DETAIL,
    worktreePath: 'C:\\wt\\j1',
    branch: 'job/pane',
    baseBranch: 'main',
    claudeSessionId: null,
    createdAt: NOW,
    updatedAt: NOW,
    stages: [
      { name: 'design', status: 'needs_decision', detail: null, startedAt: NOW, finishedAt: null },
    ],
    ...over,
  };
}

let jobs: Job[] = [];
let docsByJob = new Map<string, JobDoc[]>();
let calls: string[] = [];

const json = (data: unknown) => ({ ok: true, status: 200, json: async () => data });

/** Every request the board can make on this path, and nothing else. */
function stubFetch(): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      calls.push(url);
      if (url.startsWith('/api/jobs?')) return json({ jobs, usage: null });
      const docs = /^\/api\/jobs\/([^/]+)\/docs$/.exec(url);
      if (docs) return json({ docs: docsByJob.get(decodeURIComponent(docs[1])) ?? [] });
      if (/^\/api\/jobs\/[^/]+\/file\?/.test(url)) return json({ text: DOC_TEXT });
      throw new Error(`unexpected fetch: ${url}`);
    })
  );
}

function mount(): JobBoard {
  document.body.innerHTML = `
    <div id="project-flash" class="hidden"></div>
    <div id="project-jobs"></div>`;
  const board = new JobBoard(() => {});
  board.attach(document.getElementById('project-jobs')!);
  return board;
}

/** Let the fetch-then-render pairs inside toggleDoc/openReference settle. */
const settle = (): Promise<void> => new Promise((resolve) => window.setTimeout(resolve, 0));

const pane = () => document.querySelector<HTMLElement>('.jb-docs')!;
const head = () => document.querySelector<HTMLButtonElement>('.jb-docs-head')!;
const docsBtn = () => document.querySelector<HTMLButtonElement>('.jb-docs-btn')!;
const folded = () => pane().classList.contains('collapsed');
const docsFetches = () => calls.filter((url) => url.endsWith('/docs')).length;

beforeEach(() => {
  jobs = [parkedJob()];
  docsByJob = new Map([['j1', DOCS]]);
  calls = [];
  stubFetch();
  // happy-dom has no layout, so the scroll itself is a no-op here; what these
  // tests check is that the heading exists to scroll to at all.
  Element.prototype.scrollIntoView = () => {};
});

describe('a pane the board loaded on its own', () => {
  it('starts folded, and still says what the run changed', async () => {
    const board = mount();
    await board.load(CWD);

    expect(folded()).toBe(true);
    expect(head().getAttribute('aria-expanded')).toBe('false');
    expect(document.querySelector('.jb-docs-count')!.textContent).toBe('1 changed by this run');
  });

  it('offers the documents button on a job parked on a question', async () => {
    const board = mount();
    await board.load(CWD);

    const button = document.querySelector('.jb-docs-btn');
    expect(button).not.toBeNull();
    // Folded, so the button is still an offer to see them.
    expect(button!.textContent).toBe('View documents');
  });

  it('is not re-folded by a later load once the user has opened it', async () => {
    const board = mount();
    await board.load(CWD);
    head().click();
    expect(folded()).toBe(false);

    await board.load(CWD);
    expect(folded()).toBe(false);
  });
});

/**
 * The documents button on the actions row, on the cards whose body is NOT
 * already open. A parked question is unfolded by loadDocsForParked(); every
 * other job with a worktree arrives collapsed, and the pane only renders inside
 * the card body — so the button has to expand the card as well as unfold.
 */
describe('the documents button on a collapsed card', () => {
  it('opens the pane on one click at the merge gate, where the list is already cached', async () => {
    jobs = [parkedJob({ parkReason: 'gate', gate: 'merge', stage: 'qa', detail: null })];
    const board = mount();
    await board.load(CWD);

    // Cached by the board's own fetch, but nothing of it is on screen yet.
    expect(document.querySelector('.jb-docs')).toBeNull();
    expect(docsBtn().textContent).toBe('View documents');

    docsBtn().click();
    expect(pane()).not.toBeNull();
    expect(folded()).toBe(false);
    expect(docsBtn().textContent).toBe('Hide documents');
  });

  it('fetches and shows the list for a finished job', async () => {
    jobs = [parkedJob({ status: 'done', stage: 'merge', parkReason: null, detail: null })];
    const board = mount();
    await board.load(CWD);

    // Not parked, so the board never fetched for it.
    expect(docsFetches()).toBe(0);
    expect(document.querySelector('.jb-docs')).toBeNull();

    docsBtn().click();
    await settle();

    expect(docsFetches()).toBe(1);
    expect(folded()).toBe(false);
    expect(document.querySelectorAll('.jb-doc-row')).toHaveLength(2);
  });
});

describe('the pane header', () => {
  it('folds and unfolds without fetching the list again', async () => {
    const board = mount();
    await board.load(CWD);
    const fetched = docsFetches();

    head().click();
    expect(folded()).toBe(false);
    expect(head().getAttribute('aria-expanded')).toBe('true');
    expect(docsFetches()).toBe(fetched);

    head().click();
    expect(folded()).toBe(true);
    expect(head().getAttribute('aria-expanded')).toBe('false');
    expect(docsFetches()).toBe(fetched);
  });

  it('keeps the keyboard on the control it just replaced, and says what it controls', async () => {
    const board = mount();
    await board.load(CWD);

    const body = document.querySelector<HTMLElement>('.jb-docs-body')!;
    expect(head().getAttribute('aria-controls')).toBe(body.id);
    expect(body.id).not.toBe('');

    head().click();
    // render() replaced the button; a keyboard user has to be able to press
    // Space again without tabbing back through the card.
    expect(document.activeElement).toBe(head());
  });

  it('is still there to click when the list came back empty', async () => {
    docsByJob.set('j1', []);
    const board = mount();
    await board.load(CWD);

    expect(folded()).toBe(true);
    expect(document.querySelector('.jb-docs-count')!.textContent).toBe('no documents');

    head().click();
    expect(folded()).toBe(false);
    expect(document.querySelector('.pw-hint')!.textContent).toContain('No documents');
  });

  it('brings back the document that was open before the fold', async () => {
    const board = mount();
    await board.load(CWD);
    head().click();

    document.querySelector<HTMLButtonElement>('.jb-doc-row')!.click();
    await settle();
    expect(document.querySelector('.jb-doc-view')!.getAttribute('data-doc')).toBe(
      'project/spec.md'
    );

    head().click();
    expect(folded()).toBe(true);

    head().click();
    expect(folded()).toBe(false);
    expect(document.querySelector('.jb-doc-view')!.getAttribute('data-doc')).toBe(
      'project/spec.md'
    );
  });
});

describe('a reference inside the question', () => {
  it('unfolds the pane and puts its heading on the page', async () => {
    const board = mount();
    await board.load(CWD);
    expect(folded()).toBe(true);

    const ref = document.querySelector<HTMLButtonElement>('.jb-ref');
    expect(ref?.textContent).toBe('§3.2');

    ref!.click();
    await settle();

    expect(folded()).toBe(false);
    const heading = [...document.querySelectorAll<HTMLElement>('.jb-doc-h')].find(
      (node) => node.dataset.section === '3.2'
    );
    expect(heading).toBeDefined();
  });

  it('unfolds it again when the referenced document is already the open one', async () => {
    const board = mount();
    await board.load(CWD);

    document.querySelector<HTMLButtonElement>('.jb-ref')!.click();
    await settle();
    head().click(); // fold it back with the spec still open
    expect(folded()).toBe(true);

    document.querySelector<HTMLButtonElement>('.jb-ref')!.click();
    await settle();
    expect(folded()).toBe(false);
  });
});
