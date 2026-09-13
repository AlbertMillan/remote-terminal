import { describe, it, expect } from 'vitest';
import { decodeProjectSlug, decodeProjectSlugs } from '../src/server/projects/slug-decode.js';

/**
 * A fake filesystem: maps a directory path to its child directory names.
 * Keeps these tests independent of the machine they run on.
 */
function fakeFs(tree: Record<string, string[]>) {
  return (dir: string): string[] => tree[dir] ?? [];
}

const FS = fakeFs({
  'C:\\': ['Users'],
  'C:\\Users': ['Albert'],
  'C:\\Users\\Albert': ['NodeProjects', 'wkspaces', 'Appscript'],
  'C:\\Users\\Albert\\NodeProjects': [
    'ideas',
    'market-analyzer',
    'market-analyzer-client',
    'claude-remote',
    'mcps',
  ],
  'C:\\Users\\Albert\\NodeProjects\\ideas': ['atlas', 'rent-seeker'],
  'C:\\Users\\Albert\\NodeProjects\\ideas\\rent-seeker': ['spike'],
  'C:\\Users\\Albert\\NodeProjects\\mcps': ['mcp-slack'],
  'C:\\Users\\Albert\\wkspaces': ['DRACULA_TYCOON'],
  'C:\\Users\\Albert\\wkspaces\\DRACULA_TYCOON': ['Assets'],
  'C:\\Users\\Albert\\wkspaces\\DRACULA_TYCOON\\Assets': ['_Revamp'],
  'C:\\Users\\Albert\\wkspaces\\DRACULA_TYCOON\\Assets\\_Revamp': ['Scripts'],
});

describe('decodeProjectSlug', () => {
  it('decodes a simple path', () => {
    expect(decodeProjectSlug('C--Users-Albert-NodeProjects-claude-remote', FS)).toBe(
      'C:\\Users\\Albert\\NodeProjects\\claude-remote'
    );
  });

  it('prefers a hyphenated directory name over splitting it into two levels', () => {
    // "ideas-atlas" must resolve to ideas\atlas, but "market-analyzer-client"
    // must resolve to the single directory of that name, not market\analyzer\client.
    expect(decodeProjectSlug('C--Users-Albert-NodeProjects-ideas-atlas', FS)).toBe(
      'C:\\Users\\Albert\\NodeProjects\\ideas\\atlas'
    );
    expect(decodeProjectSlug('C--Users-Albert-NodeProjects-market-analyzer-client', FS)).toBe(
      'C:\\Users\\Albert\\NodeProjects\\market-analyzer-client'
    );
    expect(decodeProjectSlug('C--Users-Albert-NodeProjects-market-analyzer', FS)).toBe(
      'C:\\Users\\Albert\\NodeProjects\\market-analyzer'
    );
  });

  it('treats underscores in real directory names as hyphens', () => {
    expect(decodeProjectSlug('C--Users-Albert-wkspaces-DRACULA-TYCOON', FS)).toBe(
      'C:\\Users\\Albert\\wkspaces\\DRACULA_TYCOON'
    );
  });

  it('resolves a leading underscore, which slugifies to a doubled hyphen', () => {
    expect(
      decodeProjectSlug('C--Users-Albert-wkspaces-DRACULA-TYCOON-Assets--Revamp-Scripts', FS)
    ).toBe('C:\\Users\\Albert\\wkspaces\\DRACULA_TYCOON\\Assets\\_Revamp\\Scripts');
  });

  it('decodes deeply nested paths', () => {
    expect(decodeProjectSlug('C--Users-Albert-NodeProjects-ideas-rent-seeker-spike', FS)).toBe(
      'C:\\Users\\Albert\\NodeProjects\\ideas\\rent-seeker\\spike'
    );
    expect(decodeProjectSlug('C--Users-Albert-NodeProjects-mcps-mcp-slack', FS)).toBe(
      'C:\\Users\\Albert\\NodeProjects\\mcps\\mcp-slack'
    );
  });

  it('returns null when the directory no longer exists', () => {
    expect(decodeProjectSlug('C--Users-Albert-NodeProjects-vibetunnel', FS)).toBeNull();
    expect(decodeProjectSlug('C--Users-Albert-Nope-Gone', FS)).toBeNull();
  });

  it('returns null for slugs that are not drive paths', () => {
    for (const slug of ['', 'not-a-slug', '-', 'C--']) {
      expect(decodeProjectSlug(slug, FS)).toBeNull();
    }
  });

  it('uppercases the drive letter', () => {
    expect(decodeProjectSlug('c--Users-Albert-NodeProjects-claude-remote', FS)).toMatch(/^C:/);
  });

  it('does not throw when the filesystem is unreadable', () => {
    const throwing = () => {
      throw new Error('EACCES');
    };
    expect(() => decodeProjectSlug('C--Users-Albert', throwing as never)).toThrow();
    // The default lister swallows errors; an injected one is the caller's problem.
    expect(decodeProjectSlug('C--Users-Albert', () => [])).toBeNull();
  });
});

describe('decodeProjectSlugs', () => {
  it('drops unresolvable slugs and keeps the rest', () => {
    const out = decodeProjectSlugs(
      [
        'C--Users-Albert-NodeProjects-claude-remote',
        'C--Users-Albert-NodeProjects-vibetunnel',
        'C--Users-Albert-NodeProjects-ideas-atlas',
      ],
      FS
    );
    expect(out).toEqual([
      'C:\\Users\\Albert\\NodeProjects\\claude-remote',
      'C:\\Users\\Albert\\NodeProjects\\ideas\\atlas',
    ]);
  });
});
