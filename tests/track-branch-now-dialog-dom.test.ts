// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { openBranchNowDialog } from '../src/client/track-branch-now-dialog.js';

/**
 * Branch now moves a GUESSED file list, so what matters is that the user's
 * unticks are honoured: only the files still ticked are sent.
 */

describe('openBranchNowDialog', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    document.body.innerHTML = '';
    fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({ moved: body.files, branch: { branch: 'track/usage-1' } }), {
        status: 200,
      });
    });
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => vi.unstubAllGlobals());

  it('sends only the files left ticked, and reports where they went', async () => {
    const done = openBranchNowDialog(
      'C:\\p',
      'Usage',
      [
        { path: 'src/a.ts', status: 'modified' },
        { path: 'src/b.ts', status: 'untracked' },
      ],
      2
    );
    expect(document.body.textContent).toContain('2 commits on main also look like this');

    const b = document.querySelector<HTMLInputElement>('input.bn-file[value="src/b.ts"]')!;
    b.checked = false;
    b.dispatchEvent(new Event('change', { bubbles: true }));
    document.querySelector<HTMLButtonElement>('.bn-confirm')!.click();

    expect(await done).toBe('Moved 1 file to track/usage-1.');
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({
      cwd: 'C:\\p',
      track: 'Usage',
      files: ['src/a.ts'],
    });
  });

  it('cannot be confirmed with nothing ticked', () => {
    void openBranchNowDialog('C:\\p', 'Usage', [{ path: 'src/a.ts', status: 'modified' }], 0);
    const a = document.querySelector<HTMLInputElement>('input.bn-file')!;
    a.checked = false;
    a.dispatchEvent(new Event('change', { bubbles: true }));
    expect(document.querySelector<HTMLButtonElement>('.bn-confirm')!.disabled).toBe(true);
  });
});
