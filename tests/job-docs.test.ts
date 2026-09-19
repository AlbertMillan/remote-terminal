import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { headingNumbers, listJobDocs, readDoc, resolveInWorktree } from '../src/server/jobs/docs.js';
import { specPathOf } from '../src/server/jobs/routes.js';

/**
 * The document list behind a parked job's question, against a real repository.
 *
 * Run over a stub these tests would prove nothing: every property that matters
 * here is a property of git's output — that an untracked file still appears,
 * that a branch with no commits yet is not reported as having changed nothing,
 * that a gitignored scratch file stays out. So this builds an actual repo.
 */

let repo: string;

function git(...args: string[]): string {
  return execFileSync('git', args, { cwd: repo, encoding: 'utf-8' });
}

beforeAll(() => {
  repo = mkdtempSync(join(tmpdir(), 'cr-docs-'));
  git('init', '-b', 'main');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'Test');
  git('config', 'commit.gpgsign', 'false');

  writeFileSync(join(repo, '.gitignore'), 'project/reviews/\n');
  writeFileSync(join(repo, 'PROJECT.md'), '# Project\n\n## 1.1 Scope\nAlready here.\n');
  git('add', '.');
  git('commit', '-m', 'base');

  // What a design stage does: write a spec, edit a doc that was already there.
  mkdirSync(join(repo, 'project'), { recursive: true });
  writeFileSync(
    join(repo, 'project', 'feature.md'),
    '# Feature\n\n### 3.2 Ingestion window\nThe pull covers 730 days.\n\n### 6.9 KYB\nStop.\n'
  );
  writeFileSync(join(repo, 'PROJECT.md'), '# Project\n\n## 1.1 Scope\nWidened by the run.\n');
  git('add', '-A');
  git('commit', '-m', 'design: spec');
});

afterAll(() => {
  rmSync(repo, { recursive: true, force: true });
});

describe('listJobDocs', () => {
  it('separates what the run changed from what it could only have read', async () => {
    const docs = await listJobDocs(repo, 'main~1', 'project/feature.md');
    const byPath = new Map(docs.map((d) => [d.path, d]));

    expect(byPath.get('project/feature.md')?.status).toBe('added');
    expect(byPath.get('PROJECT.md')?.status).toBe('edited');
    expect(byPath.get('PROJECT.md')?.insertions).toBeGreaterThan(0);
  });

  it('marks the spec and puts it first', async () => {
    const docs = await listJobDocs(repo, 'main~1', 'project/feature.md');
    expect(docs[0].path).toBe('project/feature.md');
    expect(docs[0].isSpec).toBe(true);
    expect(docs.filter((d) => d.isSpec)).toHaveLength(1);
  });

  it('indexes numbered headings so a §-reference can resolve', async () => {
    const docs = await listJobDocs(repo, 'main~1', null);
    const spec = docs.find((d) => d.path === 'project/feature.md');
    expect(spec?.headings).toEqual(expect.arrayContaining(['3.2', '6.9']));
    // A heading that lives in a different document must not be attributed here.
    expect(spec?.headings).not.toContain('1.1');
  });

  it('lists a document the run has written but not committed', async () => {
    writeFileSync(join(repo, 'project', 'draft.md'), '# Draft\n\n## 9.1 Later\nTBD.\n');
    try {
      const docs = await listJobDocs(repo, 'main', null);
      const draft = docs.find((d) => d.path === 'project/draft.md');
      // Untracked, so not in the diff — but it is still a document this job has.
      expect(draft).toBeDefined();
      expect(draft?.headings).toContain('9.1');
    } finally {
      rmSync(join(repo, 'project', 'draft.md'), { force: true });
    }
  });

  it('leaves gitignored scratch out', async () => {
    mkdirSync(join(repo, 'project', 'reviews'), { recursive: true });
    writeFileSync(join(repo, 'project', 'reviews', 'job-1.md'), '# Findings\n');
    try {
      const docs = await listJobDocs(repo, 'main~1', null);
      expect(docs.some((d) => d.path.includes('reviews/'))).toBe(false);
    } finally {
      rmSync(join(repo, 'project', 'reviews'), { recursive: true, force: true });
    }
  });

  it('reports the working tree when nothing has been committed past the base', async () => {
    writeFileSync(join(repo, 'PROJECT.md'), '# Project\n\n## 1.1 Scope\nEdited again.\n');
    try {
      // base === HEAD, so the three-dot diff is empty; the pane beside this one
      // falls back to the working tree and this must agree with it.
      const docs = await listJobDocs(repo, 'main', null);
      expect(docs.find((d) => d.path === 'PROJECT.md')?.status).toBe('edited');
    } finally {
      git('checkout', '--', 'PROJECT.md');
    }
  });

  it('answers empty for a worktree that has been torn down', async () => {
    expect(await listJobDocs(join(repo, 'gone'), 'main')).toEqual([]);
  });
});

describe('resolveInWorktree', () => {
  it('accepts a path inside the worktree', () => {
    expect(resolveInWorktree(repo, 'project/feature.md')).toBeTruthy();
  });

  it('refuses traversal, absolute paths and nulls', () => {
    expect(resolveInWorktree(repo, '../secrets.txt')).toBeNull();
    expect(resolveInWorktree(repo, 'project/../../secrets.txt')).toBeNull();
    expect(resolveInWorktree(repo, 'C:/Windows/win.ini')).toBeNull();
    expect(resolveInWorktree(repo, '/etc/passwd')).toBeNull();
    expect(resolveInWorktree(repo, '')).toBeNull();
    expect(resolveInWorktree(repo, 'project/\0.md')).toBeNull();
  });

  it('refuses a symlink that leaves the worktree', () => {
    const outside = mkdtempSync(join(tmpdir(), 'cr-outside-'));
    writeFileSync(join(outside, 'secret.md'), 'not yours');
    try {
      symlinkSync(join(outside, 'secret.md'), join(repo, 'link.md'), 'file');
    } catch {
      return; // Windows without developer mode: nothing to assert.
    }
    try {
      expect(resolveInWorktree(repo, 'link.md')).toBeNull();
      expect(readDoc(repo, 'link.md')).toBeNull();
    } finally {
      rmSync(join(repo, 'link.md'), { force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });
});

describe('headingNumbers', () => {
  it('finds numbered headings, with or without a §', () => {
    expect(headingNumbers('### 3.2 Ingestion\n## §6.9 KYB\n')).toEqual(['3.2', '6.9']);
  });

  it('accepts a bare numbered line as a heading when it is multi-level', () => {
    expect(headingNumbers('3.2 Ingestion window\n')).toEqual(['3.2']);
  });

  it('does not mistake prose for a heading', () => {
    // A single-level number outside a heading, a version, a measurement and a
    // list item are all things that would produce wrong jumps.
    expect(headingNumbers('3 files changed\n')).toEqual([]);
    expect(headingNumbers('It costs 0.5 of the budget\n')).toEqual([]);
    expect(headingNumbers('see 3.2\n')).toEqual([]);
  });

  it('accepts a single-level number under a heading marker', () => {
    expect(headingNumbers('# 3 Retries\n')).toEqual(['3']);
  });
});

describe('specPathOf', () => {
  const design = (status: string, detail: string | null) => [{ name: 'design', status, detail }];

  it('uses the path a design recorded, whether it passed or parked', () => {
    const job = { title: 'A feature', featureId: 'f-1', stages: design('needs_decision', 'project/a-feature.md') };
    expect(specPathOf(job)).toBe('project/a-feature.md');
    expect(specPathOf({ ...job, stages: design('passed', 'project/a-feature.md') })).toBe(
      'project/a-feature.md'
    );
  });

  it('falls back to where the design stage puts a spec for a park that predates the path', () => {
    // These rows carry the old label — and they are, by definition, the jobs
    // sitting in front of the user waiting for an answer.
    const job = {
      title: 'Phase 0 — bank feed spike (Enable Banking + Santander ES)',
      featureId: null,
      stages: design('needs_decision', 'Needs a decision'),
    };
    expect(specPathOf(job)).toBe('project/phase-0-bank-feed-spike-enable-banking-santander.md');
  });

  it('has no spec for a design that has not finished', () => {
    expect(specPathOf({ title: 'x', featureId: null, stages: design('running', null) })).toBeNull();
    expect(specPathOf({ title: 'x', featureId: null, stages: [] })).toBeNull();
  });
});
