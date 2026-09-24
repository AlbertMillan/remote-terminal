// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  describeChoice,
  openTrackDeleteDialog,
  renderTrackDeletePlan,
  type TrackDeletePlan,
} from '../src/client/track-delete-dialog.js';

/**
 * The Delete track dialog.
 *
 * What it must get right is what it sends: only the ticked reverts and specs,
 * with the plan's token, and never a spec the server said it may not offer.
 * And a revert must not be sendable while main has uncommitted files, since the
 * server would refuse it after the user had already confirmed.
 */

const plan = (over: Partial<TrackDeletePlan> = {}): TrackDeletePlan => ({
  token: 'tok-1',
  track: 'Alpha',
  inDoc: true,
  features: [{ id: 'f-aaaaaa', title: 'First', status: 'done' }],
  cancel: [{ id: 'j-live', title: 'Second <b>', status: 'parked' }],
  discard: [
    { id: 'j-live', title: 'Second <b>', status: 'parked' },
    { id: 'j-done', title: 'First', status: 'done' },
  ],
  branch: { name: 'track/alpha-1234', worktreePath: 'C:/wt', uncommittedFiles: 2, sessionsToClose: 1 },
  currentBranch: 'main',
  merges: [
    { sha: 'aaaaaaaa1111', subject: 'Merge track: Alpha', via: 'track', baseBranch: 'main' },
    { sha: 'bbbbbbbb2222', subject: 'Merge job: First', via: 'message', baseBranch: 'main' },
  ],
  unresolved: [{ title: 'Old', reason: '2 merges share the message' }],
  specs: [
    { path: 'project/alpha.md', state: 'committed', defaultDelete: true, offered: true, note: 'recoverable from git', referencedBy: [] },
    { path: 'project/shared.md', state: 'committed', defaultDelete: false, offered: false, note: 'kept — still referenced by f-x', referencedBy: ['f-x'] },
  ],
  sessionLogGroup: true,
  mainDirty: [],
  unattributed: null,
  ...over,
});

describe('renderTrackDeletePlan', () => {
  it('lists what goes, escapes titles, and ticks merges and default specs', () => {
    document.body.innerHTML = `<div>${renderTrackDeletePlan(plan())}</div>`;
    const text = document.body.textContent ?? '';
    expect(text).toContain('Cancel 1 active job: Second <b>');
    expect(text).toContain('2 uncommitted files lost');
    expect(text).toContain('closes 1 open session');
    expect(text).toContain('2 merges share the message');
    expect(document.querySelectorAll('input.td-revert:checked')).toHaveLength(2);

    const specs = [...document.querySelectorAll<HTMLInputElement>('input.td-spec')];
    expect(specs.map((s) => [s.value, s.checked, s.disabled])).toEqual([
      ['project/alpha.md', true, false],
      ['project/shared.md', false, true],
    ]);
  });

  it('says a branchless track’s code on main is left alone', () => {
    document.body.innerHTML = renderTrackDeletePlan(
      plan({ branch: null, merges: [], unattributed: { dirtyFiles: 3 } })
    );
    expect(document.body.textContent).toContain('3 files have uncommitted changes on main');
  });
});

describe('describeChoice', () => {
  it('blocks a revert while main is dirty, but not a delete with no revert', () => {
    const dirty = plan({ mainDirty: ['x.ts'] });
    expect(describeChoice(dirty, 1).error).toContain('x.ts');
    expect(describeChoice(dirty, 0).error).toBeNull();
    expect(describeChoice(plan(), 2).commit).toContain('Delete track: Alpha');
  });
});

describe('openTrackDeleteDialog', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    document.body.innerHTML = '';
    fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.startsWith('/api/projects/track/delete-plan')) {
        return new Response(JSON.stringify({ plan: plan() }), { status: 200 });
      }
      if (url === '/api/projects/track' && init?.method === 'DELETE') {
        return new Response(JSON.stringify({ detail: 'Deleted "Alpha".' }), { status: 200 });
      }
      return new Response('{}', { status: 404 });
    });
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => vi.unstubAllGlobals());

  const settle = () => new Promise((r) => setTimeout(r, 0));

  it('sends only what is ticked, with the plan’s token', async () => {
    const done = openTrackDeleteDialog('C:\\p', 'Alpha', () => {});
    await settle();
    await settle();

    const second = document.querySelector<HTMLInputElement>('input.td-revert[value="bbbbbbbb2222"]')!;
    second.checked = false;
    second.dispatchEvent(new Event('change', { bubbles: true }));
    document.querySelector<HTMLButtonElement>('.td-confirm')!.click();

    expect(await done).toBe('Deleted "Alpha".');
    const [, init] = fetchMock.mock.calls.find(([u]) => u === '/api/projects/track')!;
    expect(JSON.parse(init.body)).toEqual({
      cwd: 'C:\\p',
      track: 'Alpha',
      token: 'tok-1',
      revert: ['aaaaaaaa1111'],
      deleteSpecs: ['project/alpha.md'],
    });
    expect(document.querySelector('.td-modal')).toBeNull();
  });

  it('shows a conflict in the dialog and keeps it open', async () => {
    fetchMock.mockImplementation(async (url: string) =>
      url.startsWith('/api/projects/track/delete-plan')
        ? new Response(JSON.stringify({ plan: plan() }), { status: 200 })
        : new Response(JSON.stringify({ error: 'Reverting conflicts', conflicts: ['shared.ts'] }), {
            status: 409,
          })
    );
    void openTrackDeleteDialog('C:\\p', 'Alpha', () => {});
    await settle();
    await settle();

    document.querySelector<HTMLButtonElement>('.td-confirm')!.click();
    await settle();
    await settle();

    expect(document.querySelector('.td-error')?.textContent).toContain('Conflicting: shared.ts');
    expect(document.querySelector('.td-modal')).not.toBeNull();
  });
});
