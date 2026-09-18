// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { JobOverlay, type JobSummary } from '../src/client/job-overlay.js';
import type { JobStatus } from '../src/client/job-board.js';

/**
 * The parts of the overlay that only exist as DOM: where it lives, when it is
 * on screen at all, and what a click on a card hands back.
 *
 * These are the rules most likely to break silently — a placement that stops
 * reparenting still renders, just on top of the buttons it was meant to avoid,
 * and nothing but an eye on the page would notice. The sorting and expiry rules
 * are pure and live in job-overlay.test.ts.
 */

const HEADER_HTML = `
  <main id="main-content">
    <div id="terminal-header" class="terminal-header hidden">
      <span id="session-name">Session</span>
      <div class="terminal-controls"><button id="terminate-session-btn"></button></div>
    </div>
    <div id="project-log-view" class="hidden"></div>
    <div id="rollup-view" class="hidden"></div>
    <div id="job-overlay" class="job-overlay jo-floating hidden">
      <div id="job-overlay-bar" class="jo-bar"><span id="job-overlay-counts"></span></div>
      <div id="job-overlay-list" class="jo-list"></div>
    </div>
  </main>`;

function job(id: string, status: JobStatus = 'running', over: Partial<JobSummary> = {}): JobSummary {
  return {
    id,
    projectCwd: `C:\\p\\${id}`,
    projectName: id,
    featureId: null,
    title: `Job ${id}`,
    status,
    stage: 'implement',
    gate: null,
    parkReason: status === 'parked' ? 'question' : null,
    detail: null,
    stages: [
      { name: 'design', status: 'passed' },
      { name: 'implement', status: 'running' },
      { name: 'integrate', status: 'pending' },
      { name: 'review', status: 'pending' },
      { name: 'fix', status: 'pending' },
      { name: 'qa', status: 'pending' },
      { name: 'merge', status: 'pending' },
      { name: 'rebuild', status: 'pending' },
    ],
    costUsd: 0,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...over,
  };
}

const root = (): HTMLElement => document.getElementById('job-overlay')!;
const header = (): HTMLElement => document.getElementById('terminal-header')!;
const showHeader = (visible: boolean): void => header().classList.toggle('hidden', !visible);

function mount(onOpen: (job: JobSummary) => void = () => {}): JobOverlay {
  document.body.innerHTML = HEADER_HTML;
  const overlay = new JobOverlay(onOpen);
  overlay.attach();
  return overlay;
}

beforeEach(() => {
  localStorage.clear();
});

describe('visibility', () => {
  it('stays off the screen when there is nothing in flight', () => {
    const overlay = mount();
    overlay.update({ jobs: [] });
    expect(root().classList.contains('hidden')).toBe(true);
  });

  it('appears as soon as a job arrives, and leaves when the last one goes', () => {
    const overlay = mount();
    overlay.update({ jobs: [job('a')] });
    expect(root().classList.contains('hidden')).toBe(false);

    overlay.update({ jobs: [] });
    expect(root().classList.contains('hidden')).toBe(true);
  });

  it('hides while the Projects view owns the corner, and comes back after', () => {
    const overlay = mount();
    overlay.update({ jobs: [job('a')] });

    overlay.setSuppressed(true);
    expect(root().classList.contains('hidden')).toBe(true);

    overlay.setSuppressed(false);
    expect(root().classList.contains('hidden')).toBe(false);
  });

  it('stays hidden when switched off, however many jobs are running', () => {
    const overlay = mount();
    overlay.setPreferences(false, 'below');
    overlay.update({ jobs: [job('a'), job('b')] });
    expect(root().classList.contains('hidden')).toBe(true);
  });

  it('empties itself when the socket drops', () => {
    const overlay = mount();
    overlay.update({ jobs: [job('a')] });
    overlay.clear();
    expect(root().classList.contains('hidden')).toBe(true);
  });
});

describe('placement', () => {
  it('floats inside the main area by default', () => {
    const overlay = mount();
    overlay.update({ jobs: [job('a')] });
    expect(root().classList.contains('jo-floating')).toBe(true);
    expect(root().parentElement?.id).toBe('main-content');
  });

  it('docks into the header, ahead of the session controls', () => {
    const overlay = mount();
    showHeader(true);
    overlay.setPreferences(true, 'header');

    expect(root().parentElement?.id).toBe('terminal-header');
    expect(root().classList.contains('jo-docked')).toBe(true);
    // Ahead of the controls, so flexbox puts it left of the buttons it must not cover.
    expect(root().nextElementSibling?.className).toBe('terminal-controls');
  });

  it('falls back to floating when there is no header to dock to', () => {
    const overlay = mount();
    showHeader(false);
    overlay.setPreferences(true, 'header');

    expect(root().parentElement?.id).toBe('main-content');
    expect(root().classList.contains('jo-floating')).toBe(true);
  });

  it('docks and undocks as the header comes and goes', () => {
    const overlay = mount();
    overlay.setPreferences(true, 'header');

    showHeader(true);
    overlay.applyPlacement();
    expect(root().parentElement?.id).toBe('terminal-header');

    showHeader(false);
    overlay.applyPlacement();
    expect(root().parentElement?.id).toBe('main-content');
  });

  it('remembers both preferences across a reload', () => {
    mount().setPreferences(false, 'header');

    const reloaded = mount();
    expect(reloaded.isEnabled()).toBe(false);
    expect(reloaded.getPlacement()).toBe('header');
  });
});

describe('cards', () => {
  it('renders one card per job, carrying its id', () => {
    const overlay = mount();
    overlay.update({ jobs: [job('a'), job('b', 'parked')] });

    const ids = [...document.querySelectorAll<HTMLElement>('.jo-card')].map(
      (el) => el.dataset.jobId
    );
    // Parked first: it is the one blocking you.
    expect(ids).toEqual(['b', 'a']);
  });

  it('hands the clicked job back to the caller', () => {
    const onOpen = vi.fn();
    const overlay = mount(onOpen);
    overlay.update({ jobs: [job('a')] });

    document.querySelector<HTMLElement>('.jo-card')!.click();
    expect(onOpen).toHaveBeenCalledWith(expect.objectContaining({ id: 'a' }));
  });

  it('leads a parked card with the question rather than the prose around it', () => {
    const overlay = mount();
    overlay.update({
      jobs: [
        job('a', 'parked', {
          detail: '- **Province-wide or municipality-only?** BOE filters by province. Recommends (b).',
        }),
      ],
    });
    expect(document.querySelector('.jo-detail')!.textContent).toBe(
      'Province-wide or municipality-only?'
    );
  });

  it('escapes a title that looks like markup', () => {
    const overlay = mount();
    overlay.update({ jobs: [job('a', 'running', { title: '<img src=x onerror=alert(1)>' })] });

    const title = document.querySelector('.jo-title')!;
    expect(title.querySelector('img')).toBeNull();
    expect(title.textContent).toBe('<img src=x onerror=alert(1)>');
  });

  it('keeps the list scrolled where the user left it across a push', () => {
    const overlay = mount();
    overlay.update({ jobs: [job('a'), job('b'), job('c')] });

    const list = document.getElementById('job-overlay-list')!;
    // jsdom has no layout, so scrollTop only holds a value we set ourselves;
    // this asserts the restore happens, not that the browser could scroll.
    list.scrollTop = 42;
    overlay.update({ jobs: [job('a'), job('b'), job('c')] });
    expect(list.scrollTop).toBe(42);
  });

  it('keeps focus on the card the user had tabbed to', () => {
    const overlay = mount();
    overlay.update({ jobs: [job('a'), job('b')] });

    const card = [...document.querySelectorAll<HTMLElement>('.jo-card')].find(
      (el) => el.dataset.jobId === 'a'
    )!;
    card.focus();
    overlay.update({ jobs: [job('a'), job('b')] });

    expect((document.activeElement as HTMLElement).dataset.jobId).toBe('a');
  });
});

describe('the collapsed pill', () => {
  it('toggles the list and remembers being closed', () => {
    const overlay = mount();
    overlay.update({ jobs: [job('a')] });
    expect(root().classList.contains('open')).toBe(true);

    document.getElementById('job-overlay-bar')!.click();
    expect(root().classList.contains('open')).toBe(false);

    const reloaded = mount();
    reloaded.update({ jobs: [job('a')] });
    expect(root().classList.contains('open')).toBe(false);
  });

  it('still reports the counts while collapsed', () => {
    const overlay = mount();
    document.getElementById('job-overlay-bar')!.click();
    overlay.update({ jobs: [job('a', 'parked'), job('b'), job('c', 'failed')] });

    const counts = document.getElementById('job-overlay-counts')!.textContent!;
    expect(counts).toContain('1 waiting');
    expect(counts).toContain('1 running');
    expect(counts).toContain('1 failed');
  });
});
