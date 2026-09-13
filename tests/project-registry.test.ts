import { describe, it, expect } from 'vitest';
import {
  normalizeRegistry,
  rollUpProjects,
  isDescendantOf,
  docPathFor,
  type Registry,
} from '../src/server/projects/registry.js';
import { capabilitiesFor } from '../src/server/projects/vcs.js';

// Real directory shapes from the machine this feature targets: one Unity project
// that discovery reports as five separate dirs, and an `ideas` folder whose
// children are unrelated projects.
const UNITY = 'C:\\Users\\Albert\\wkspaces\\DRACULA_TYCOON';
const IDEAS = 'C:\\Users\\Albert\\NodeProjects\\ideas';

const DISCOVERED = [
  'C:\\Users\\Albert\\NodeProjects\\claude-remote',
  UNITY,
  UNITY + '\\UnityProjects\\Revamp_DSCore\\Revamp_DSCore',
  UNITY + '\\UnityProjects\\Revamp_DSCore\\Revamp_DSCore\\Assets\\_Revamp\\Scripts',
  UNITY + '\\UnityProjects\\Revamp_DSCore\\Revamp_DSCore\\Assets\\_Revamp\\Content',
  IDEAS,
  IDEAS + '\\atlas',
  IDEAS + '\\noesis',
  IDEAS + '\\rent-seeker',
  IDEAS + '\\rent-seeker\\spike',
];

function registry(partial: Partial<Registry> = {}): Registry {
  return { projects: [], splitChildren: [], ...partial };
}

describe('isDescendantOf', () => {
  it('matches nested paths case- and separator-insensitively', () => {
    expect(isDescendantOf(UNITY + '\\UnityProjects', UNITY)).toBe(true);
    expect(isDescendantOf(UNITY.toLowerCase() + '/UnityProjects', UNITY)).toBe(true);
  });

  it('is false for the path itself', () => {
    expect(isDescendantOf(UNITY, UNITY)).toBe(false);
  });

  it('requires a separator at the boundary so sibling prefixes do not match', () => {
    expect(isDescendantOf(IDEAS + '-archive', IDEAS)).toBe(false);
  });
});

describe('rollUpProjects', () => {
  it('folds nested dirs into a registered parent', () => {
    const result = rollUpProjects(DISCOVERED, registry({ projects: [{ cwd: UNITY }] }));
    const unity = result.find((p) => p.cwd === UNITY);
    expect(unity).toBeDefined();
    expect(unity?.nested).toHaveLength(3);
    // The five Unity dirs collapse to a single board entry.
    expect(result.filter((p) => p.cwd.includes('DRACULA_TYCOON'))).toHaveLength(1);
  });

  it('keeps splitChildren roots exploded into one project per child', () => {
    const result = rollUpProjects(DISCOVERED, registry({ splitChildren: [IDEAS] }));
    const cwds = result.map((p) => p.cwd);
    expect(cwds).toContain(IDEAS + '\\atlas');
    expect(cwds).toContain(IDEAS + '\\noesis');
    expect(cwds).toContain(IDEAS + '\\rent-seeker');
  });

  it('rolls a grandchild into its split child, not the split root', () => {
    const result = rollUpProjects(DISCOVERED, registry({ splitChildren: [IDEAS] }));
    const rentSeeker = result.find((p) => p.cwd === IDEAS + '\\rent-seeker');
    expect(rentSeeker?.nested).toEqual([IDEAS + '\\rent-seeker\\spike']);
  });

  it('lets a deeper registered project win over a shallower one', () => {
    const inner = UNITY + '\\UnityProjects\\Revamp_DSCore\\Revamp_DSCore';
    const result = rollUpProjects(
      DISCOVERED,
      registry({ projects: [{ cwd: UNITY }, { cwd: inner }] })
    );
    expect(result.find((p) => p.cwd === inner)?.nested).toHaveLength(2);
    expect(result.find((p) => p.cwd === UNITY)?.nested).toEqual([]);
  });

  it('keeps unregistered directories as standalone projects — nothing is hidden', () => {
    const result = rollUpProjects(DISCOVERED, registry());
    expect(result).toHaveLength(DISCOVERED.length);
  });

  it('handles an empty discovery list', () => {
    expect(rollUpProjects([], registry({ projects: [{ cwd: UNITY }] }))).toEqual([]);
  });
});

describe('normalizeRegistry', () => {
  it('degrades junk input to an empty registry', () => {
    for (const input of [null, undefined, 42, 'nope', []]) {
      expect(normalizeRegistry(input)).toEqual({ projects: [], splitChildren: [] });
    }
  });

  it('drops malformed project entries but keeps valid ones', () => {
    const out = normalizeRegistry({
      projects: [{ cwd: UNITY }, { nope: 1 }, null, { cwd: '' }, { cwd: IDEAS, doc: 'DOCS.md' }],
      splitChildren: [IDEAS, 42, ''],
    });
    expect(out.projects).toEqual([{ cwd: UNITY }, { cwd: IDEAS, doc: 'DOCS.md' }]);
    expect(out.splitChildren).toEqual([IDEAS]);
  });
});

describe('docPathFor', () => {
  it('defaults to PROJECT.md and honours an override', () => {
    expect(docPathFor({ cwd: UNITY })).toBe(UNITY + '\\PROJECT.md');
    expect(docPathFor({ cwd: UNITY, doc: 'docs/INDEX.md' })).toBe(UNITY + '\\docs\\INDEX.md');
  });
});

describe('capabilitiesFor', () => {
  it('gives git the full pipeline', () => {
    expect(capabilitiesFor('git')).toMatchObject({ canDispatch: true, needsInit: false, canPush: true });
  });

  it('lets a non-VCS folder dispatch after init but never push', () => {
    const caps = capabilitiesFor('none');
    expect(caps).toMatchObject({ canDispatch: true, needsInit: true, canPush: false });
    expect(caps.note).toMatch(/never pushed/);
  });

  it('blocks dispatch on Plastic and says why', () => {
    const caps = capabilitiesFor('plastic');
    expect(caps.canDispatch).toBe(false);
    expect(caps.note).toMatch(/Plastic/);
  });
});
