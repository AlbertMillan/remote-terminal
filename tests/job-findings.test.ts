import { describe, it, expect } from 'vitest';
import {
  parseFindings,
  applySelection,
  selectedFindings,
  summarize,
  findingsRelPath,
  type FindingsFile,
} from '../src/server/jobs/findings.js';
import { extractUnresolved } from '../src/server/jobs/stages/fix.js';
import { loadReviewCriteria } from '../src/server/jobs/stages/review.js';

const JOB = 'job-1';

const raw = {
  findings: [
    {
      id: 'r1',
      severity: 'nice',
      file: 'src/a.ts',
      line: 10,
      title: 'Could extract a helper',
      detail: 'd',
      suggestion: 's',
    },
    {
      id: 'r2',
      severity: 'critical',
      file: 'src/b.ts',
      line: 42,
      title: 'Null deref',
      detail: 'd',
      suggestion: 's',
    },
    {
      id: 'r3',
      severity: 'important',
      file: 'src/c.ts',
      title: 'Missing validation',
      detail: 'd',
      suggestion: 's',
    },
  ],
};

describe('parseFindings', () => {
  it('parses findings and orders them most severe first', () => {
    const file = parseFindings(raw, JOB);
    expect(file.findings.map((f) => f.id)).toEqual(['r2', 'r3', 'r1']);
    expect(file.jobId).toBe(JOB);
  });

  it('starts everything unselected — acting is the user’s decision', () => {
    expect(parseFindings(raw, JOB).findings.every((f) => !f.selected)).toBe(true);
  });

  it('accepts a bare array as well as a wrapped object', () => {
    expect(parseFindings(raw.findings, JOB).findings).toHaveLength(3);
  });

  it('degrades junk input to an empty list rather than throwing', () => {
    for (const input of [null, undefined, 42, 'nope', {}, { findings: 'no' }]) {
      expect(parseFindings(input, JOB).findings).toEqual([]);
    }
  });

  it('normalizes wordier severity labels from the review headings', () => {
    const file = parseFindings(
      {
        findings: [
          { title: 'a', severity: 'Critical' },
          { title: 'b', severity: 'Important' },
          { title: 'c', severity: 'Nice-to-have' },
          { title: 'd', severity: 'Major' },
          { title: 'e', severity: 'whatever' },
        ],
      },
      JOB
    );
    const bySeverity = Object.fromEntries(file.findings.map((f) => [f.title, f.severity]));
    expect(bySeverity).toEqual({
      a: 'critical',
      b: 'important',
      c: 'nice',
      d: 'important',
      e: 'nice',
    });
  });

  it('drops entries with neither a title nor a file', () => {
    const file = parseFindings({ findings: [{ detail: 'orphan' }, { title: 'kept' }] }, JOB);
    expect(file.findings.map((f) => f.title)).toEqual(['kept']);
  });

  it('falls back to the file name when a title is missing', () => {
    expect(parseFindings({ findings: [{ file: 'src/x.ts' }] }, JOB).findings[0].title).toBe(
      'src/x.ts'
    );
  });

  it('generates ids for entries that omit them', () => {
    const file = parseFindings({ findings: [{ title: 'a' }, { title: 'b' }] }, JOB);
    expect(file.findings.map((f) => f.id)).toEqual(['r1', 'r2']);
  });

  it('rejects nonsense line numbers rather than showing them', () => {
    const file = parseFindings(
      { findings: [{ title: 'a', line: 0 }, { title: 'b', line: -3 }, { title: 'c', line: 'x' }] },
      JOB
    );
    expect(file.findings.every((f) => f.line === null)).toBe(true);
  });
});

describe('selection', () => {
  const file = (): FindingsFile => parseFindings(raw, JOB);

  it('marks exactly the ticked ids', () => {
    const updated = applySelection(file(), ['r2']);
    expect(selectedFindings(updated).map((f) => f.id)).toEqual(['r2']);
  });

  it('deselects everything when given an empty list', () => {
    const all = applySelection(file(), ['r1', 'r2', 'r3']);
    expect(selectedFindings(applySelection(all, []))).toEqual([]);
  });

  it('ignores unknown ids', () => {
    expect(selectedFindings(applySelection(file(), ['nope']))).toEqual([]);
  });

  it('selectedFindings handles a missing file', () => {
    expect(selectedFindings(null)).toEqual([]);
  });
});

describe('summarize', () => {
  it('counts by severity', () => {
    expect(summarize(parseFindings(raw, JOB))).toBe('1 critical, 1 important, 1 nice-to-have');
  });

  it('reports an empty review honestly', () => {
    expect(summarize(parseFindings({ findings: [] }, JOB))).toBe('no findings');
    expect(summarize(null)).toBe('no findings');
  });
});

describe('findingsRelPath', () => {
  it('lives in the gitignored reviews folder beside PROJECT.md', () => {
    expect(findingsRelPath('abc')).toBe('project/reviews/abc.json');
  });
});

describe('extractUnresolved', () => {
  it('pulls out the lines the fix run could not apply', () => {
    const summary = [
      'Fixed r1 by adding a guard.',
      'UNRESOLVED: r2 needs a schema change out of scope',
      'unresolved: r3 could not reproduce',
      'Ran npm test — 12 passing.',
    ].join('\n');
    expect(extractUnresolved(summary)).toEqual([
      'r2 needs a schema change out of scope',
      'r3 could not reproduce',
    ]);
  });

  it('returns nothing when everything applied', () => {
    expect(extractUnresolved('Fixed all three. Tests pass.')).toEqual([]);
  });
});

describe('loadReviewCriteria', () => {
  it('falls back to built-in criteria when the command file is absent', () => {
    const { criteria, source } = loadReviewCriteria('C:/definitely/not/here.md');
    expect(source).toBe('(built-in default)');
    expect(criteria.length).toBeGreaterThan(0);
  });
});
