// @vitest-environment happy-dom
import { describe, it, expect } from 'vitest';
import { renderBehind } from '../src/client/project-feature-board.js';
import { updateConfirmText, type WorkspaceProject, type WorkspaceTrack } from '../src/client/project-workspace.js';

/**
 * "N behind main" on a branched track's heading, what merging it in would
 * conflict on, and Update from main. A conflict list the server couldn't
 * compute (null) shows the count alone — never as though the merge were clean.
 */

const project = { cwd: 'C:\\p\\demo' } as WorkspaceProject;
const branched = (extra: Partial<WorkspaceTrack>): WorkspaceTrack => ({
  name: 'Alpha',
  features: [],
  branch: { name: 'track/alpha-12345678', worktreePath: 'C:\\wt\\a', baseBranch: 'main' },
  ...extra,
});

function render(track: WorkspaceTrack): HTMLElement {
  const el = document.createElement('div');
  el.innerHTML = renderBehind(project, track);
  return el;
}

describe('renderBehind', () => {
  it('shows nothing when level with the base, or unbranched', () => {
    expect(renderBehind(project, branched({ behind: 0, wouldConflict: [] }))).toBe('');
    expect(renderBehind(project, branched({ behind: 2, branch: null }))).toBe('');
  });

  it('shows the count and Update when behind with no conflicts', () => {
    const el = render(branched({ behind: 3, wouldConflict: [] }));
    expect(el.querySelector('.pw-behind')?.textContent).toBe('3 behind main');
    expect(el.querySelector('.pw-behind-conflict')).toBeNull();
    const button = el.querySelector('.pw-track-update') as HTMLElement;
    expect(button.dataset.track).toBe('Alpha');
    expect(button.dataset.cwd).toBe('C:\\p\\demo');
  });

  it('names the conflicting files', () => {
    const el = render(branched({ behind: 1, wouldConflict: ['src/a.ts', 'src/b.ts'] }));
    expect(el.querySelector('.pw-behind-conflict')?.textContent).toBe('would conflict: src/a.ts, src/b.ts');
  });

  it('shows only the count when the dry run could not be made', () => {
    const el = render(branched({ behind: 1, wouldConflict: null }));
    expect(el.querySelector('.pw-behind')?.textContent).toBe('1 behind main');
    expect(el.querySelector('.pw-behind-conflict')).toBeNull();
  });

  it('names the base branch in the confirmation', () => {
    expect(updateConfirmText('Alpha', 'develop')).toContain('Merge develop into "Alpha"');
  });
});
