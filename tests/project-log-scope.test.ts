import { describe, it, expect } from 'vitest';
import { isAllowedPath } from '../src/server/sessions/project-log.js';

// The allowed-write set used by the post-run scope-revert. Getting this wrong
// either reverts legitimate plan edits (false positive) or lets out-of-scope
// writes survive (false negative), so pin the tricky cases down.
const ALLOWED = ['SESSION-LOG.md', '*plan*.md', '*design*.md', 'docs/**/*.md'];

describe('isAllowedPath', () => {
  it('allows the log file at root', () => {
    expect(isAllowedPath('SESSION-LOG.md', ALLOWED)).toBe(true);
  });

  it('allows a plan doc directly under docs/ (globstar zero-segment case)', () => {
    expect(isAllowedPath('docs/project-onboarding.md', ALLOWED)).toBe(true);
  });

  it('allows a plan doc nested deeper under docs/', () => {
    expect(isAllowedPath('docs/sub/dir/spec.md', ALLOWED)).toBe(true);
  });

  it('allows root-level *plan*/*design* files case-insensitively', () => {
    expect(isAllowedPath('PLANNING.md', ALLOWED)).toBe(true);
    expect(isAllowedPath('feature-design.md', ALLOWED)).toBe(true);
  });

  it('handles Windows backslash paths', () => {
    expect(isAllowedPath('docs\\project-onboarding.md', ALLOWED)).toBe(true);
  });

  it('rejects source files (the out-of-scope edit it must catch)', () => {
    expect(isAllowedPath('src/server/app.ts', ALLOWED)).toBe(false);
    expect(isAllowedPath('package.json', ALLOWED)).toBe(false);
  });

  it('rejects CLAUDE.md so a poisoned run cannot edit it', () => {
    expect(isAllowedPath('CLAUDE.md', ALLOWED)).toBe(false);
  });

  it('does not let a non-docs .md slip through docs/**', () => {
    expect(isAllowedPath('README.md', ALLOWED)).toBe(false);
  });

  it('keeps `*` within a single segment (no slash crossing)', () => {
    expect(isAllowedPath('a/plan.md', ['*plan*.md'])).toBe(false);
  });
});
