// @vitest-environment happy-dom
import { describe, it, expect } from 'vitest';
import {
  ghostFor,
  leafName,
  tildeForm,
  verdictHtml as verdictMarkup,
  type FolderCompletion,
  type FolderItem,
} from '../src/client/new-session-modal.js';

/**
 * The New Session folder field's pure helpers (project/new-session-folder-picker.md): the grey
 * completion, the `~` form, the session's default name and the hint under the field.
 */

const HOME = 'C:\\Users\\Albert';

function item(display: string): FolderItem {
  const name = display.split('/').pop() ?? display;
  return { path: `${HOME}\\${display.slice(2)}`, display, name, git: false, projectDoc: false, recent: false };
}

function completion(mode: 'path' | 'search', displays: string[]): FolderCompletion {
  return {
    mode,
    items: displays.map(item),
    newFolder: null,
    verdict: { kind: 'empty', path: HOME, display: '~' },
    home: HOME,
    defaultDisplay: '~/NodeProjects',
  };
}

describe('ghostFor', () => {
  const c = completion('path', ['~/NodeProjects/market-analyzer', '~/NodeProjects/market-analyzer-client']);

  it('shows the rest of the top match, ending in a slash', () => {
    expect(ghostFor('~/NodeProjects/ma', c)).toBe('rket-analyzer/');
  });

  it('ignores case and slash direction', () => {
    expect(ghostFor('~\\nodeprojects\\MA', c)).toBe('rket-analyzer/');
  });

  it('continues a full path typed inside the home folder', () => {
    expect(ghostFor('C:\\Users\\Albert\\NodeProjects\\ma', c)).toBe('rket-analyzer/');
  });

  it('shows nothing for a search, a mismatch, or an empty field', () => {
    expect(ghostFor('ma', completion('search', ['~/NodeProjects/market-analyzer']))).toBe('');
    expect(ghostFor('~/NodeProjects/zz', c)).toBe('');
    expect(ghostFor('', c)).toBe('');
    expect(ghostFor('~/NodeProjects/ma', null)).toBe('');
  });
});

describe('tildeForm', () => {
  it('writes a path inside the home folder as ~/…, with forward slashes', () => {
    expect(tildeForm('C:\\Users\\Albert\\NodeProjects\\x', HOME)).toBe('~/NodeProjects/x');
    expect(tildeForm('c:/users/albert/NodeProjects', HOME)).toBe('~/NodeProjects');
    expect(tildeForm('C:\\Users\\Albert', HOME)).toBe('~');
  });

  it('leaves a folder that only shares the home prefix, or no home, alone', () => {
    expect(tildeForm('C:\\Users\\Albertx\\proj', HOME)).toBe('C:\\Users\\Albertx\\proj');
    expect(tildeForm('D:\\work', HOME)).toBe('D:\\work');
    expect(tildeForm('C:\\Users\\Albert\\x', '')).toBe('C:\\Users\\Albert\\x');
  });
});

describe('leafName', () => {
  it('is the last folder, whatever the slashes', () => {
    expect(leafName('~/NodeProjects/recipe-scaler/')).toBe('recipe-scaler');
    expect(leafName('C:\\Users\\Albert\\proj')).toBe('proj');
    expect(leafName('steam')).toBe('steam');
  });
});

/** The hint's markup as a string. */
const verdictHtml = (...args: Parameters<typeof verdictMarkup>) => verdictMarkup(...args).value;

describe('verdictHtml', () => {
  const options = { git: true, projectDoc: false };

  it('counts the folders to create and highlights the new part', () => {
    const one = verdictHtml(
      { kind: 'creatable', path: 'p', display: '~/NodeProjects/a', existing: 'e', create: ['a'] },
      options
    );
    expect(one).toContain('Creates 1 new folder<');
    const two = verdictHtml(
      { kind: 'creatable', path: 'p', display: '~/NodeProjects/a/b', existing: 'e', create: ['a', 'b'] },
      options
    );
    expect(two).toContain('Creates 2 new folders');
    expect(two).toContain('~/NodeProjects/<span class="cwd-new-part">a/b</span>');
  });

  it('keeps the checkboxes as the user left them', () => {
    const html = verdictHtml(
      { kind: 'creatable', path: 'p', display: '~/x', existing: 'e', create: ['x'] },
      options
    );
    expect(html).toMatch(/id="session-cwd-git" checked/);
    expect(html).not.toMatch(/id="session-cwd-doc" checked/);
  });

  it('escapes what came from the server', () => {
    expect(verdictHtml({ kind: 'refused', reason: '<img src=x>' }, options)).toContain('&lt;img src=x&gt;');
    expect(verdictHtml({ kind: 'exists', path: 'p', display: 'd', project: '<b>' }, options)).toContain('&lt;b&gt;');
  });
});
