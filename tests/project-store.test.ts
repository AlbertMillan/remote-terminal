import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  readProjectDoc,
  writeProjectDoc,
  mutateProjectDoc,
  ProjectStoreError,
  revisionOf,
  ensureReviewsIgnored,
  resolveSpecPath,
  readSpec,
  hasProjectDoc,
  qaDocPath,
  reviewsDir,
} from '../src/server/projects/project-store.js';
import {
  addFeature,
  allFeatures,
  updateFeature,
  featuresOf,
} from '../src/server/projects/project-doc-format.js';

let dir: string;
const project = () => ({ cwd: dir });

const SAMPLE = [
  '---',
  'name: demo',
  'status: active',
  '---',
  '',
  '## Track: Feature roadmap',
  '- [ ] `f-aaa111` P1 First thing',
  '',
].join('\n');

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cr-store-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('readProjectDoc', () => {
  it('reports a missing file as absent with an empty doc', () => {
    const state = readProjectDoc(project());
    expect(state.exists).toBe(false);
    expect(state.revision).toBe('absent');
    expect(allFeatures(state.doc)).toEqual([]);
    expect(hasProjectDoc(project())).toBe(false);
  });

  it('distinguishes an empty file from a missing one', () => {
    writeFileSync(join(dir, 'PROJECT.md'), '');
    const state = readProjectDoc(project());
    expect(state.exists).toBe(true);
    expect(state.revision).not.toBe('absent');
  });

  it('parses an existing document', () => {
    writeFileSync(join(dir, 'PROJECT.md'), SAMPLE);
    const state = readProjectDoc(project());
    expect(state.doc.frontmatter.name).toBe('demo');
    expect(allFeatures(state.doc)).toHaveLength(1);
    expect(state.revision).toBe(revisionOf(SAMPLE));
  });

  it('honours a doc path override', () => {
    mkdirSync(join(dir, 'docs'));
    writeFileSync(join(dir, 'docs', 'INDEX.md'), SAMPLE);
    const state = readProjectDoc({ cwd: dir, doc: 'docs/INDEX.md' });
    expect(state.exists).toBe(true);
    expect(state.doc.frontmatter.name).toBe('demo');
  });
});

describe('writeProjectDoc — staleness precondition', () => {
  it('writes when the revision matches', () => {
    writeFileSync(join(dir, 'PROJECT.md'), SAMPLE);
    const state = readProjectDoc(project());
    addFeature(state.doc, { title: 'Second thing' });
    const written = writeProjectDoc(project(), state.doc, state.revision);

    expect(written.revision).not.toBe(state.revision);
    expect(readFileSync(join(dir, 'PROJECT.md'), 'utf-8')).toContain('Second thing');
  });

  it('rejects with 409 when the file changed underneath', () => {
    writeFileSync(join(dir, 'PROJECT.md'), SAMPLE);
    const state = readProjectDoc(project());

    // Someone edits the file (an agent, an editor, another request).
    writeFileSync(join(dir, 'PROJECT.md'), SAMPLE + '- [ ] `f-bbb222` Snuck in\n');

    addFeature(state.doc, { title: 'Racing write' });
    try {
      writeProjectDoc(project(), state.doc, state.revision);
      throw new Error('expected a conflict');
    } catch (error) {
      expect(error).toBeInstanceOf(ProjectStoreError);
      expect((error as ProjectStoreError).status).toBe(409);
    }
    // The competing edit survives untouched.
    expect(readFileSync(join(dir, 'PROJECT.md'), 'utf-8')).toContain('Snuck in');
    expect(readFileSync(join(dir, 'PROJECT.md'), 'utf-8')).not.toContain('Racing write');
  });

  it('creates the file when expecting absent', () => {
    const state = readProjectDoc(project());
    addFeature(state.doc, { title: 'First ever' });
    writeProjectDoc(project(), state.doc, state.revision);
    expect(readFileSync(join(dir, 'PROJECT.md'), 'utf-8')).toContain('First ever');
  });

  it('skips the check when passed null', () => {
    writeFileSync(join(dir, 'PROJECT.md'), SAMPLE);
    const state = readProjectDoc(project());
    writeFileSync(join(dir, 'PROJECT.md'), 'totally different\n');
    expect(() => writeProjectDoc(project(), state.doc, null)).not.toThrow();
  });

  it('leaves no temp file behind', () => {
    const state = readProjectDoc(project());
    addFeature(state.doc, { title: 'x' });
    writeProjectDoc(project(), state.doc, state.revision);
    const leftovers = readFileSync(join(dir, 'PROJECT.md'), 'utf-8');
    expect(leftovers).toContain('x');
    expect(() => readFileSync(join(dir, `PROJECT.md.tmp-${process.pid}`), 'utf-8')).toThrow();
  });
});

describe('mutateProjectDoc', () => {
  it('applies the mutation against fresh content and returns the result', () => {
    writeFileSync(join(dir, 'PROJECT.md'), SAMPLE);
    const { revision } = readProjectDoc(project());
    const { result, state } = mutateProjectDoc(project(), revision, (doc) =>
      addFeature(doc, { title: 'Added', priority: 2 })
    );
    expect(result.id).toMatch(/^f-[a-z0-9]{6}$/);
    expect(allFeatures(state.doc)).toHaveLength(2);
    expect(readFileSync(join(dir, 'PROJECT.md'), 'utf-8')).toContain('P2 Added');
  });

  it('conflicts when the revision is stale', () => {
    writeFileSync(join(dir, 'PROJECT.md'), SAMPLE);
    expect(() =>
      mutateProjectDoc(project(), 'deadbeefdeadbeef', (doc) => addFeature(doc, { title: 'x' }))
    ).toThrow(ProjectStoreError);
  });

  it('heals hand-written lines missing an id before mutating', () => {
    writeFileSync(join(dir, 'PROJECT.md'), '## Track: T\n- [ ] Written by hand\n');
    const { revision } = readProjectDoc(project());
    const { state } = mutateProjectDoc(project(), revision, (doc) =>
      updateFeature(doc, 'nope', { status: 'done' })
    );
    expect(featuresOf(state.doc.tracks[0])[0].id).toMatch(/^f-[a-z0-9]{6}$/);
  });
});

describe('companion paths', () => {
  it('places QA and reviews beside the index', () => {
    expect(qaDocPath(project())).toBe(join(dir, 'project', 'QA.md'));
    expect(reviewsDir(project())).toBe(join(dir, 'project', 'reviews'));
  });

  it('resolves a spec path inside the project', () => {
    expect(resolveSpecPath(project(), 'project/a.md')).toBe(join(dir, 'project', 'a.md'));
  });

  it('refuses spec paths that escape the project or are absolute', () => {
    expect(resolveSpecPath(project(), '../../etc/passwd')).toBeNull();
    expect(resolveSpecPath(project(), 'C:\\Windows\\system.ini')).toBeNull();
    expect(resolveSpecPath(project(), '')).toBeNull();
  });

  it('readSpec returns null for a traversing path instead of reading it', () => {
    expect(readSpec(project(), '../secrets.md')).toBeNull();
  });

  it('readSpec reads a valid spec', () => {
    mkdirSync(join(dir, 'project'), { recursive: true });
    writeFileSync(join(dir, 'project', 'a.md'), '# Spec');
    expect(readSpec(project(), 'project/a.md')).toBe('# Spec');
  });
});

describe('ensureReviewsIgnored', () => {
  it('creates .gitignore with the rule when absent', () => {
    expect(ensureReviewsIgnored(project())).toBe(true);
    expect(readFileSync(join(dir, '.gitignore'), 'utf-8')).toContain('project/reviews/');
  });

  it('appends without disturbing existing rules', () => {
    writeFileSync(join(dir, '.gitignore'), 'node_modules\ndist\n');
    expect(ensureReviewsIgnored(project())).toBe(true);
    const content = readFileSync(join(dir, '.gitignore'), 'utf-8');
    expect(content).toContain('node_modules');
    expect(content).toContain('dist');
    expect(content).toContain('project/reviews/');
  });

  it('is idempotent', () => {
    ensureReviewsIgnored(project());
    expect(ensureReviewsIgnored(project())).toBe(false);
    const occurrences = readFileSync(join(dir, '.gitignore'), 'utf-8').split('project/reviews/').length - 1;
    expect(occurrences).toBe(1);
  });

  it('recognises an existing equivalent rule', () => {
    writeFileSync(join(dir, '.gitignore'), '/project/reviews/\n');
    expect(ensureReviewsIgnored(project())).toBe(false);
  });

  it('handles a .gitignore with no trailing newline', () => {
    writeFileSync(join(dir, '.gitignore'), 'dist');
    ensureReviewsIgnored(project());
    const lines = readFileSync(join(dir, '.gitignore'), 'utf-8').split('\n');
    expect(lines).toContain('dist');
    expect(lines).toContain('project/reviews/');
  });
});
