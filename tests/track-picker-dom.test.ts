// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { TrackPicker } from '../src/client/track-picker.js';

/**
 * The New Session dialog's Track picker.
 *
 * The bug this pins down: after the directory changed, the previous project's
 * list stayed up for the second the next one took to load, and Create in that
 * window opened a session in the OTHER project's track worktree.
 */

const REPO = 'C:\\p\\repo';
const OTHER = 'C:\\Windows\\Temp';

/** Replies held until released, so a test can act inside the loading window. */
let pending: { url: string; release: () => void }[] = [];
let branchCalls: unknown[] = [];

function reply(url: string, init?: RequestInit): Response {
  if (url.startsWith('/api/projects/track/branch')) {
    branchCalls.push(JSON.parse(String(init?.body)));
    return new Response(JSON.stringify({ branch: { worktreePath: 'C:\\wt\\tracks\\alpha' } }));
  }
  const cwd = decodeURIComponent(url.split('cwd=')[1] ?? '');
  if (cwd === REPO) {
    return new Response(
      JSON.stringify({ cwd: REPO, canBranch: true, tracks: [{ name: 'Alpha', branch: null }] })
    );
  }
  return new Response(JSON.stringify({ error: 'Unknown project' }), { status: 404 });
}

const flush = async () => {
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
};

function releaseAll(): void {
  const all = pending;
  pending = [];
  for (const p of all) p.release();
}

beforeEach(() => {
  document.body.innerHTML = `
    <input id="session-cwd-input">
    <div class="hidden" id="session-track-group">
      <select id="session-track-select"></select>
      <input id="session-track-new" class="hidden">
      <p id="session-track-note"></p>
    </div>`;
  pending = [];
  branchCalls = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(
      (url: string, init?: RequestInit) =>
        new Promise<Response>((resolve) => {
          if (url.startsWith('/api/projects/track/branch')) return resolve(reply(url, init));
          pending.push({ url, release: () => resolve(reply(url, init)) });
        })
    )
  );
});

afterEach(() => vi.unstubAllGlobals());

const group = () => document.getElementById('session-track-group')!;
const cwdInput = () => document.getElementById('session-cwd-input') as HTMLInputElement;
const select = () => document.getElementById('session-track-select') as HTMLSelectElement;

async function loadFor(picker: TrackPicker, cwd: string): Promise<void> {
  cwdInput().value = cwd;
  const done = picker.refresh();
  await flush();
  releaseAll();
  await done;
}

describe('TrackPicker', () => {
  it('shows the tracks of a board project, and nothing for another directory', async () => {
    const picker = new TrackPicker();
    await loadFor(picker, REPO);
    expect(group().classList.contains('hidden')).toBe(false);
    expect([...select().options].map((o) => o.value)).toEqual(['', 'Alpha', '__new__']);

    await loadFor(picker, OTHER);
    expect(group().classList.contains('hidden')).toBe(true);
  });

  it('never offers the previous project’s track while the next list loads', async () => {
    const picker = new TrackPicker();
    await loadFor(picker, REPO);
    select().value = 'Alpha';

    cwdInput().value = OTHER;
    picker.schedule(0);
    // Inside the loading window: the old list is gone and nothing is picked.
    expect(group().classList.contains('hidden')).toBe(true);
    expect(picker.chosen()).toBeNull();
    await expect(picker.resolve()).resolves.toBeNull();
    expect(branchCalls).toEqual([]);
  });

  it('ignores a reply that lands after the directory changed again', async () => {
    const picker = new TrackPicker();
    cwdInput().value = REPO;
    const late = picker.refresh();
    await flush();
    cwdInput().value = OTHER; // typed on before REPO's list arrived
    releaseAll();
    await late;

    expect(group().classList.contains('hidden')).toBe(true);
    expect(picker.chosen()).toBeNull();
  });

  it('ignores a list loaded for a directory the field no longer holds', async () => {
    const picker = new TrackPicker();
    await loadFor(picker, REPO);
    select().value = 'Alpha';
    cwdInput().value = OTHER; // changed without an input event reaching the picker
    expect(picker.chosen()).toBeNull();
  });

  it('branches the picked track of the project the list belongs to', async () => {
    const picker = new TrackPicker();
    await loadFor(picker, REPO);
    select().value = 'Alpha';

    await expect(picker.resolve()).resolves.toEqual({ track: 'Alpha', worktreePath: 'C:\\wt\\tracks\\alpha' });
    expect(branchCalls).toEqual([{ cwd: REPO, track: 'Alpha' }]);
  });

  it('refuses "New track…" with no name, and says why', async () => {
    const picker = new TrackPicker();
    await loadFor(picker, REPO);
    select().value = '__new__';
    picker.sync();

    await expect(picker.resolve()).resolves.toBe(false);
    expect(document.getElementById('session-track-note')!.textContent).toContain('Name the new track');
    expect(branchCalls).toEqual([]);
  });
});
