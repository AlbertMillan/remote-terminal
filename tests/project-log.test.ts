import { describe, it, expect } from 'vitest';
import {
  buildMarker,
  parseLogEntries,
  buildEntrySkeleton,
  type LogEntryMeta,
} from '../src/server/sessions/session-log-format.js';
import { transcriptHasEdits, countUserTurns } from '../src/server/sessions/transcript.js';
import { pathKey } from '../src/server/sessions/project-discovery.js';

const meta = (over: Partial<LogEntryMeta> = {}): LogEntryMeta => ({
  date: '2026-06-28T10:00:00.000Z',
  session: 'Refactor auth',
  branch: 'main',
  claudeSessionId: '9040b75a-a9d8-41b6-a9f0-f0d0d04c174e',
  blockers: 0,
  openItems: 1,
  ...over,
});

describe('session-log-format: marker round-trip', () => {
  it('buildMarker output parses back to the same meta', () => {
    const m = meta();
    const parsed = parseLogEntries(buildMarker(m) + '\n## heading\nbody');
    expect(parsed).toHaveLength(1);
    expect(parsed[0].meta).toEqual(m);
  });

  it('preserves session names containing special characters', () => {
    const m = meta({ session: 'fix: thing (with) "quotes" & dashes' });
    const parsed = parseLogEntries(buildMarker(m));
    expect(parsed[0].meta?.session).toBe(m.session);
  });

  it('splits multiple entries newest-first by marker boundary', () => {
    const doc =
      '# Session Log\n\n' +
      buildMarker(meta({ session: 'second' })) +
      '\n## b\n**Done:** later\n\n' +
      buildMarker(meta({ session: 'first' })) +
      '\n## a\n**Done:** earlier\n';
    const parsed = parseLogEntries(doc);
    expect(parsed.map((p) => p.meta?.session)).toEqual(['second', 'first']);
    expect(parsed[0].body).toContain('later');
    expect(parsed[1].body).toContain('earlier');
  });

  it('yields null meta for a malformed marker but still returns the body', () => {
    const parsed = parseLogEntries('<!-- claude-remote-log {not json} -->\n## x\nbody');
    expect(parsed).toHaveLength(1);
    expect(parsed[0].meta).toBeNull();
    expect(parsed[0].body).toContain('## x');
  });

  it('returns nothing for content with no markers', () => {
    expect(parseLogEntries('# Just a readme\n\nno entries here')).toEqual([]);
  });
});

describe('session-log-format: skeleton', () => {
  it('embeds the marker and all field labels', () => {
    const skeleton = buildEntrySkeleton({
      meta: meta(),
      headingDate: '2026-06-28',
      headingTitle: 'Refactor auth',
      hints: { done: 'D', changed: 'C', planProgress: 'P', openNext: 'O', blockers: 'B' },
    });
    // The skeleton's marker must itself be parseable (keeps generator ⇄ parser aligned).
    expect(parseLogEntries(skeleton)[0].meta?.session).toBe('Refactor auth');
    for (const label of ['**Done:**', '**Changed:**', '**Plan progress:**', '**Open / next:**', '**Blockers:**']) {
      expect(skeleton).toContain(label);
    }
    expect(skeleton).toContain('## 2026-06-28 · Refactor auth · main');
  });
});

describe('transcript skip-gate signals', () => {
  it('detects edit tool calls', () => {
    expect(transcriptHasEdits('{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Edit"}]}}')).toBe(true);
    expect(transcriptHasEdits('...{"name":"Write"}...')).toBe(true);
    expect(transcriptHasEdits('...{"name": "MultiEdit"}...')).toBe(true);
    expect(transcriptHasEdits('...{"name":"NotebookEdit"}...')).toBe(true);
  });

  it('ignores read-only tool calls and plain conversation', () => {
    expect(transcriptHasEdits('{"name":"Read"}{"name":"Grep"}{"name":"Bash"}')).toBe(false);
    expect(transcriptHasEdits('just a question and an answer')).toBe(false);
  });

  it('counts user turns', () => {
    const t = '{"type":"user"}\n{"type":"assistant"}\n{"type":"user"}\n{"type":"summary"}';
    expect(countUserTurns(t)).toBe(2);
    expect(countUserTurns('no turns')).toBe(0);
  });
});

describe('project-discovery: pathKey', () => {
  it('normalizes separators, trailing slashes, and case', () => {
    expect(pathKey('C:\\Users\\Albert\\proj')).toBe('c:\\users\\albert\\proj');
    expect(pathKey('C:/Users/Albert/proj/')).toBe('c:\\users\\albert\\proj');
    expect(pathKey('C:\\Users\\Albert\\proj\\')).toBe(pathKey('c:/users/albert/proj'));
  });
});
