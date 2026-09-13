import { describe, it, expect } from 'vitest';
import {
  parseProjectDoc,
  renderProjectDoc,
  allFeatures,
  featuresOf,
  addFeature,
  updateFeature,
  removeFeature,
  reorderFeatures,
  healMissingIds,
  generateFeatureId,
  findFeature,
} from '../src/server/projects/project-doc-format.js';

const SAMPLE = [
  '---',
  'name: claude-remote',
  'status: active',
  'verify:',
  '  - npm run lint',
  '  - npm test',
  '---',
  '',
  'Some preamble prose.',
  '',
  '## Track: Feature roadmap',
  '- [~] `f-a1b2` P1 Task dispatch queue → project/task-dispatch.md',
  '- [ ] `f-c3d4` P2 Idea inbox',
  '- [x] `f-e5f6` Phases board',
  '',
  '## Track: Infrastructure',
  '- [!] `f-g7h8` Plastic SCM support',
  '',
].join('\n');

describe('parseProjectDoc', () => {
  it('parses frontmatter including list values', () => {
    const doc = parseProjectDoc(SAMPLE);
    expect(doc.frontmatter.name).toBe('claude-remote');
    expect(doc.frontmatter.status).toBe('active');
    expect(doc.frontmatter.verify).toEqual(['npm run lint', 'npm test']);
  });

  it('parses tracks and features with status, priority and spec link', () => {
    const doc = parseProjectDoc(SAMPLE);
    expect(doc.tracks.map((t) => t.name)).toEqual(['Feature roadmap', 'Infrastructure']);

    const [first, second, third] = featuresOf(doc.tracks[0]);
    expect(first).toEqual({
      id: 'f-a1b2',
      status: 'in_progress',
      priority: 1,
      title: 'Task dispatch queue',
      spec: 'project/task-dispatch.md',
    });
    expect(second.status).toBe('pending');
    expect(second.priority).toBe(2);
    expect(second.spec).toBeNull();
    expect(third.status).toBe('done');
    expect(third.priority).toBeNull();

    expect(featuresOf(doc.tracks[1])[0].status).toBe('blocked');
  });

  it('keeps preamble prose out of the tracks', () => {
    const doc = parseProjectDoc(SAMPLE);
    expect(doc.preamble.join('\n')).toContain('Some preamble prose.');
    expect(allFeatures(doc)).toHaveLength(4);
  });

  it('accepts an ASCII arrow for the spec link', () => {
    const doc = parseProjectDoc('## Track: T\n- [ ] `f-x1` Thing -> project/thing.md\n');
    expect(featuresOf(doc.tracks[0])[0].spec).toBe('project/thing.md');
  });

  it('handles CRLF line endings', () => {
    const doc = parseProjectDoc(SAMPLE.replace(/\n/g, '\r\n'));
    expect(doc.frontmatter.name).toBe('claude-remote');
    expect(allFeatures(doc)).toHaveLength(4);
  });
});

describe('parseProjectDoc — degradation (never throws)', () => {
  it('returns an empty doc for empty or junk input', () => {
    for (const input of ['', '\n\n', 'just some text', '# Title only']) {
      const doc = parseProjectDoc(input);
      expect(doc.tracks).toEqual([]);
      expect(allFeatures(doc)).toEqual([]);
    }
  });

  it('treats an unterminated frontmatter fence as body', () => {
    const doc = parseProjectDoc('---\nname: x\n\n## Track: T\n- [ ] `f-1` A\n');
    expect(doc.frontmatter.name).toBeNull();
    expect(doc.preamble.some((l) => l.includes('name: x'))).toBe(true);
  });

  it('keeps unknown checkbox characters as raw lines rather than features', () => {
    const doc = parseProjectDoc('## Track: T\n- [q] `f-1` Mystery\n- [ ] `f-2` Real\n');
    expect(featuresOf(doc.tracks[0]).map((f) => f.id)).toEqual(['f-2']);
    expect(doc.tracks[0].items.some((i) => i.kind === 'raw' && i.text.includes('Mystery'))).toBe(
      true
    );
  });

  it('parses a feature line missing its id and priority', () => {
    const doc = parseProjectDoc('## Track: T\n- [ ] Bare feature\n');
    const f = featuresOf(doc.tracks[0])[0];
    expect(f.id).toBe('');
    expect(f.title).toBe('Bare feature');
  });

  it('preserves unknown frontmatter keys', () => {
    const doc = parseProjectDoc('---\nname: x\nowner: albert\n---\n');
    expect(doc.frontmatter.extra.owner).toBe('albert');
    expect(renderProjectDoc(doc)).toContain('owner: albert');
  });
});

describe('renderProjectDoc', () => {
  it('round-trips an unmodified document', () => {
    expect(renderProjectDoc(parseProjectDoc(SAMPLE))).toBe(SAMPLE);
  });

  it('preserves prose interleaved between features', () => {
    const src = '## Track: T\n- [ ] `f-1` A\n\nA note between.\n\n- [ ] `f-2` B\n';
    expect(renderProjectDoc(parseProjectDoc(src))).toBe(src);
  });

  it('omits the frontmatter fence when there is nothing to put in it', () => {
    expect(renderProjectDoc(parseProjectDoc('## Track: T\n- [ ] `f-1` A\n'))).not.toContain('---');
  });
});

describe('mutations', () => {
  it('adds a feature with a generated id into the first track by default', () => {
    const doc = parseProjectDoc(SAMPLE);
    const f = addFeature(doc, { title: 'New thing', priority: 3 });
    expect(f.id).toMatch(/^f-[a-z0-9]{6}$/);
    expect(featuresOf(doc.tracks[0]).at(-1)?.id).toBe(f.id);
    expect(renderProjectDoc(doc)).toContain('- [ ] `' + f.id + '` P3 New thing');
  });

  it('creates a named track on demand', () => {
    const doc = parseProjectDoc(SAMPLE);
    addFeature(doc, { title: 'Docs', track: 'Documentation' });
    expect(doc.tracks.map((t) => t.name)).toContain('Documentation');
  });

  it('patches only the provided fields', () => {
    const doc = parseProjectDoc(SAMPLE);
    updateFeature(doc, 'f-c3d4', { status: 'done' });
    const f = findFeature(doc, 'f-c3d4')?.feature;
    expect(f?.status).toBe('done');
    expect(f?.title).toBe('Idea inbox');
    expect(f?.priority).toBe(2);
  });

  it('moves a feature between tracks', () => {
    const doc = parseProjectDoc(SAMPLE);
    updateFeature(doc, 'f-a1b2', { track: 'Infrastructure' });
    expect(featuresOf(doc.tracks[0]).map((f) => f.id)).not.toContain('f-a1b2');
    expect(featuresOf(doc.tracks[1]).map((f) => f.id)).toContain('f-a1b2');
  });

  it('returns null when updating an unknown id', () => {
    expect(updateFeature(parseProjectDoc(SAMPLE), 'f-nope', { status: 'done' })).toBeNull();
  });

  it('removes a feature and reports whether anything went', () => {
    const doc = parseProjectDoc(SAMPLE);
    expect(removeFeature(doc, 'f-e5f6')).toBe(true);
    expect(removeFeature(doc, 'f-e5f6')).toBe(false);
    expect(allFeatures(doc)).toHaveLength(3);
  });

  it('reorders within a track, keeping omitted ids at the end', () => {
    const doc = parseProjectDoc(SAMPLE);
    reorderFeatures(doc, 'Feature roadmap', ['f-e5f6', 'f-a1b2']);
    expect(featuresOf(doc.tracks[0]).map((f) => f.id)).toEqual(['f-e5f6', 'f-a1b2', 'f-c3d4']);
  });

  it('reorder leaves interleaved prose in place', () => {
    const doc = parseProjectDoc('## Track: T\n- [ ] `f-1` A\nnote\n- [ ] `f-2` B\n');
    reorderFeatures(doc, 'T', ['f-2', 'f-1']);
    expect(renderProjectDoc(doc)).toBe('## Track: T\n- [ ] `f-2` B\nnote\n- [ ] `f-1` A\n');
  });

  it('heals ids on hand-written lines without touching existing ones', () => {
    const doc = parseProjectDoc('## Track: T\n- [ ] `f-keep` A\n- [ ] B\n');
    healMissingIds(doc);
    const [a, b] = featuresOf(doc.tracks[0]);
    expect(a.id).toBe('f-keep');
    expect(b.id).toMatch(/^f-[a-z0-9]{6}$/);
  });

  it('never generates an id that is already taken', () => {
    const taken = new Set<string>();
    for (let i = 0; i < 200; i++) {
      const id = generateFeatureId(taken);
      expect(taken.has(id)).toBe(false);
      taken.add(id);
    }
  });
});
