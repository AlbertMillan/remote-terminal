import { describe, it, expect } from 'vitest';
import {
  buildMarker,
  parseLogEntries,
  parsePhasesBlock,
  buildEntrySkeleton,
  removeLogEntry,
  removeLogEntry,
  type LogEntryMeta,
} from '../src/server/sessions/session-log-format.js';
import { pathKey } from '../src/server/sessions/project-discovery.js';

const META: LogEntryMeta = {
  date: '2026-06-28T10:00:00.000Z',
  session: 'Refactor auth',
  branch: 'main',
  claudeSessionId: 'abc-123',
  blockers: 0,
  openItems: 1,
};

describe('buildMarker / parseLogEntries', () => {
  it('round-trips a marker through the parser', () => {
    const md = `# Session Log\n\n${buildMarker(META)}\n## 2026-06-28 · Refactor auth · main\n**Done:** x`;
    const entries = parseLogEntries(md);
    expect(entries).toHaveLength(1);
    expect(entries[0].meta).toEqual(META);
    expect(entries[0].body).toContain('**Done:** x');
  });

  it('parses multiple entries newest-first and bounds each body', () => {
    const a = buildMarker({ ...META, claudeSessionId: 'a' });
    const b = buildMarker({ ...META, claudeSessionId: 'b' });
    const md = `# Session Log\n\n${a}\n## entry A\nbody A\n\n${b}\n## entry B\nbody B\n`;
    const entries = parseLogEntries(md);
    expect(entries.map((e) => e.meta?.claudeSessionId)).toEqual(['a', 'b']);
    expect(entries[0].body).toContain('body A');
    expect(entries[0].body).not.toContain('body B');
  });

  it('surfaces a malformed marker with null meta rather than throwing', () => {
    const md = `<!-- claude-remote-log {not json} -->\n## broken\nbody`;
    const entries = parseLogEntries(md);
    expect(entries).toHaveLength(1);
    expect(entries[0].meta).toBeNull();
    expect(entries[0].body).toContain('broken');
  });

  it('returns [] when there are no markers', () => {
    expect(parseLogEntries('# Session Log\n\njust prose')).toEqual([]);
  });
});

describe('parsePhasesBlock', () => {
  const block = (json: string): string => `# Session Log\n\n<!-- claude-remote-phases\n${json}\n-->\n\n## entry`;

  it('parses grouped phases and normalizes status + sessionIds', () => {
    const groups = parsePhasesBlock(
      block(
        JSON.stringify([
          {
            group: 'Roadmap',
            source: 'PLANNING.md',
            items: [
              { id: 'Phase 1', title: 'Flagship', status: 'in_progress', sessionIds: ['s1', 's2'] },
              { id: 'Phase 2', title: 'Next', status: 'pending' },
            ],
          },
        ])
      )
    );
    expect(groups).toHaveLength(1);
    expect(groups[0].group).toBe('Roadmap');
    expect(groups[0].items[0].sessionIds).toEqual(['s1', 's2']);
    expect(groups[0].items[1].sessionIds).toEqual([]); // defaulted
  });

  it('coerces unknown status to pending', () => {
    const groups = parsePhasesBlock(
      block(JSON.stringify([{ group: 'G', source: '', items: [{ id: 'X', title: 'x', status: 'shipped' }] }]))
    );
    expect(groups[0].items[0].status).toBe('pending');
  });

  it('drops items lacking both id and title, and non-string sessionIds', () => {
    const groups = parsePhasesBlock(
      block(
        JSON.stringify([
          { group: 'G', source: '', items: [{ status: 'done' }, { id: 'A', title: 'a', sessionIds: ['ok', 42, null] }] },
        ])
      )
    );
    expect(groups[0].items).toHaveLength(1);
    expect(groups[0].items[0].sessionIds).toEqual(['ok']);
  });

  it('returns [] for missing block, malformed JSON, or non-array root', () => {
    expect(parsePhasesBlock('# Session Log\n\nno block')).toEqual([]);
    expect(parsePhasesBlock(block('{not json}'))).toEqual([]);
    expect(parsePhasesBlock(block('{"group":"G"}'))).toEqual([]);
  });
});

describe('buildEntrySkeleton', () => {
  it('emits a marker the parser can read back', () => {
    const skeleton = buildEntrySkeleton({
      meta: META,
      headingDate: '2026-06-28',
      headingTitle: 'Refactor auth',
      hints: { done: 'd', changed: 'c', planProgress: 'p', openNext: 'o', blockers: 'b' },
    });
    const entries = parseLogEntries(skeleton);
    expect(entries[0].meta).toEqual(META);
  });
});

describe('pathKey', () => {
  it('normalizes separators, trailing slash, and case', () => {
    expect(pathKey('C:/Users/Albert/Proj/')).toBe(pathKey('C:\\Users\\Albert\\Proj'));
    expect(pathKey('C:\\Users\\ALBERT\\Proj')).toBe('c:\\users\\albert\\proj');
  });
});


describe('removeLogEntry', () => {
  const entry = (sid: string, body: string): string =>
    `${buildMarker({ ...META, claudeSessionId: sid })}\n## entry ${sid}\n${body}\n`;
  const PHASES = `<!-- claude-remote-phases\n[{ "group": "T", "source": "d.md", "items": [] }]\n-->`;
  const file = `# Session Log\n\n${PHASES}\n\n${entry('a', 'body A')}\n${entry('b', 'body B')}\n${entry('c', 'body C')}`;

  it('removes the first (newest) entry, keeping the header and phases block', () => {
    const out = removeLogEntry(file, 0) as string;
    expect(parseLogEntries(out).map((e) => e.meta?.claudeSessionId)).toEqual(['b', 'c']);
    expect(out).toContain('# Session Log');
    expect(parsePhasesBlock(out)).toHaveLength(1);
    expect(out).not.toContain('body A');
  });

  it('removes a middle entry without touching its neighbours', () => {
    const out = removeLogEntry(file, 1) as string;
    expect(parseLogEntries(out).map((e) => e.meta?.claudeSessionId)).toEqual(['a', 'c']);
    expect(out).toContain('body A');
    expect(out).toContain('body C');
    expect(out).not.toContain('body B');
  });

  it('removes the last entry without eating the phases block', () => {
    const out = removeLogEntry(file, 2) as string;
    expect(parseLogEntries(out).map((e) => e.meta?.claudeSessionId)).toEqual(['a', 'b']);
    expect(parsePhasesBlock(out)).toHaveLength(1);
    expect(out).not.toContain('body C');
  });

  it('leaves a header-only file when the sole entry goes, ending in one newline', () => {
    const single = `# Session Log\n\n${PHASES}\n\n${entry('a', 'body A')}`;
    const out = removeLogEntry(single, 0) as string;
    expect(parseLogEntries(out)).toHaveLength(0);
    expect(parsePhasesBlock(out)).toHaveLength(1);
    expect(out.endsWith('\n')).toBe(true);
    expect(out.endsWith('\n\n')).toBe(false);
  });

  it('separates the surviving neighbours by exactly one blank line', () => {
    const out = removeLogEntry(file, 1) as string;
    expect(out).not.toMatch(/\n{3}/);
  });

  it('removes an entry whose marker JSON is malformed', () => {
    const md = `# Session Log\n\n<!-- claude-remote-log {not json} -->\n## broken\nbody\n\n${entry('b', 'body B')}`;
    const out = removeLogEntry(md, 0) as string;
    expect(parseLogEntries(out).map((e) => e.meta?.claudeSessionId)).toEqual(['b']);
    expect(out).not.toContain('broken');
  });

  it('returns null for an out-of-range or non-integer index', () => {
    expect(removeLogEntry(file, 3)).toBeNull();
    expect(removeLogEntry(file, -1)).toBeNull();
    expect(removeLogEntry(file, 1.5)).toBeNull();
    expect(removeLogEntry('# Session Log\n', 0)).toBeNull();
  });

  it('supports clearing every entry for one conversation, highest index first', () => {
    const shared = `# Session Log\n\n${entry('x', 'one')}\n${entry('y', 'other')}\n${entry('x', 'two')}`;
    let out = shared;
    for (const i of [2, 0]) out = removeLogEntry(out, i) as string;
    expect(parseLogEntries(out).map((e) => e.meta?.claudeSessionId)).toEqual(['y']);
    expect(out).toContain('other');
  });
});
