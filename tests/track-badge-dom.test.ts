// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ProjectWorkspace, type WorkspaceProject } from '../src/client/project-workspace.js';

/**
 * The "⚠ N files on main" badge on a track heading.
 *
 * It appears only for uncommitted files — the one thing Branch now can move.
 * Guessed commits alone flagged seven of this repo's own tracks with history
 * from before track branches existed, each badge leading to "nothing to move".
 */

const CWD = 'C:\\p\\demo';

const project: WorkspaceProject = {
  cwd: CWD,
  name: 'demo',
  nested: [],
  registered: true,
  vcs: { kind: 'git', canDispatch: true, needsInit: false, canPush: false, note: null },
  hasDoc: true,
  revision: 'r1',
  docPath: 'PROJECT.md',
  status: null,
  verify: [],
  tracks: [
    { name: 'Old history', features: [{ id: 'f-111111', status: 'done', priority: null, title: 'Shipped', spec: null }], branch: null },
    { name: 'Dirty work', features: [{ id: 'f-222222', status: 'pending', priority: null, title: 'WIP', spec: null }], branch: null },
  ],
  orphanBranches: [],
  counts: { total: 2, done: 1, in_progress: 0, pending: 1, blocked: 0 },
  lastActivity: null,
  lastModified: null,
  transcriptCount: 0,
};

const settle = () => new Promise((r) => setTimeout(r, 0));

describe('track badge', () => {
  beforeEach(() => {
    document.body.innerHTML = '<ul id="project-list"></ul><div id="project-features"></div>';
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url === '/api/projects') return new Response(JSON.stringify({ projects: [project] }));
        if (url.startsWith('/api/projects/unbranched-work')) {
          // Even if the server sent a commits-only track, the board must not badge it.
          return new Response(
            JSON.stringify({
              tracks: {
                'Old history': { files: [], commits: 3 },
                'Dirty work': { files: [{ path: 'src/a.ts', status: 'modified' }], commits: 1 },
              },
            })
          );
        }
        return new Response('{}', { status: 404 });
      })
    );
  });

  afterEach(() => vi.unstubAllGlobals());

  it('badges only the track with uncommitted files', async () => {
    const ws = new ProjectWorkspace(() => {}, () => {}, () => {}, () => {});
    await ws.loadBoard();
    ws.setSelected(CWD);
    const container = document.getElementById('project-features')!;
    ws.renderFeatures(container, CWD);
    await settle();
    await settle();

    const badges = [...container.querySelectorAll<HTMLElement>('.pw-track-branchnow')];
    expect(badges.map((b) => [b.dataset.track, b.textContent?.trim()])).toEqual([
      ['Dirty work', '⚠ 1 file on main'],
    ]);
  });

  it('shows Delete as loading while its plan is fetched, then opens the dialog', async () => {
    let releasePlan!: () => void;
    const planReply = new Promise<Response>((resolve) => {
      releasePlan = () =>
        resolve(
          new Response(
            JSON.stringify({
              plan: {
                token: 't', track: 'Old history', inDoc: true, features: [], cancel: [], discard: [],
                branch: null, currentBranch: 'main', merges: [], unresolved: [], specs: [],
                sessionLogGroup: false, mainDirty: [], guessedFiles: [], guessedCommits: [],
                unattributed: null,
              },
            })
          )
        );
    });
    const base = vi.mocked(fetch).getMockImplementation()!;
    vi.mocked(fetch).mockImplementation((url: string, init?: RequestInit) =>
      String(url).startsWith('/api/projects/track/delete-plan') ? planReply : base(url, init)
    );

    const ws = new ProjectWorkspace(() => {}, () => {}, () => {}, () => {});
    await ws.loadBoard();
    ws.setSelected(CWD);
    const container = document.getElementById('project-features')!;
    ws.renderFeatures(container, CWD);
    ws.attach(container);
    await settle();

    const button = () =>
      container.querySelector<HTMLButtonElement>('.pw-track-delete[data-track="Old history"]')!;
    button().click();
    await settle();
    expect(button().textContent).toBe('Loading…');
    expect(button().disabled).toBe(true);

    releasePlan();
    await settle();
    await settle();
    expect(button().textContent).toBe('Delete');
    expect(document.querySelector('.td-modal')).not.toBeNull();
  });
});
