import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { resolvePlanDocs } from '../src/server/sessions/project-log.js';

const GLOBS = ['*plan*.md', '*design*.md', 'docs/**/*.md'];

describe('resolvePlanDocs', () => {
  let root: string;
  const touch = (rel: string) => {
    const p = join(root, ...rel.split('/'));
    mkdirSync(join(p, '..'), { recursive: true });
    writeFileSync(p, '# x\n');
  };

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'plan-docs-'));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('matches the configured globs at any depth they allow, case-insensitively', () => {
    touch('PLAN.md');
    touch('ui-design.md');
    touch('README.md');
    touch('docs/a.md');
    touch('docs/deep/b.md');
    touch('src/plan.md'); // root-only pattern: not matched
    expect(resolvePlanDocs(root, GLOBS)).toEqual(['PLAN.md', 'docs/a.md', 'docs/deep/b.md', 'ui-design.md']);
  });

  it('skips excluded files, node_modules and dot folders', () => {
    touch('session-plan.md');
    touch('docs/node_modules/x.md');
    touch('docs/.cache/y.md');
    expect(resolvePlanDocs(root, GLOBS, ['SESSION-PLAN.md'])).toEqual([]);
  });

  it('returns an empty list for a project with none, and null past the cap', () => {
    expect(resolvePlanDocs(root, GLOBS)).toEqual([]);
    for (let i = 0; i < 45; i++) touch(`docs/d${i}.md`);
    expect(resolvePlanDocs(root, GLOBS)).toBeNull();
  });
});
