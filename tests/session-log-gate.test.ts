import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, utimesSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  transcriptSince,
  transcriptHasEditsSince,
  countUserTurnsSince,
} from '../src/server/sessions/transcript.js';
import { anyDirtyFileTouchedSince } from '../src/server/sessions/project-log.js';
import {
  findEntryForSession,
  entryBodyOnly,
  buildMarker,
  type LogEntryMeta,
} from '../src/server/sessions/session-log-format.js';

/**
 * Regression tests for the duplicate-entry defect: one conversation produced a
 * near-identical entry every morning for five days. Each block below pins one
 * of the four compounding causes.
 */

const SESSION_START = '2026-09-13T12:00:00.000Z';
const BEFORE = '2026-09-10T09:00:00.000Z';
const AFTER = '2026-09-13T13:30:00.000Z';

function line(timestamp: string | null, body: Record<string, unknown>): string {
  return JSON.stringify(timestamp ? { timestamp, ...body } : body);
}

describe('transcriptSince — the transcript belongs to the conversation, not the session', () => {
  const transcript = [
    line(BEFORE, { type: 'user' }),
    line(BEFORE, { type: 'assistant', message: { content: [{ name: 'Edit' }] } }),
    line(AFTER, { type: 'user' }),
  ].join('\n');

  it('keeps only lines at or after the session start', () => {
    expect(transcriptSince(transcript, SESSION_START).lines).toHaveLength(1);
  });

  it('does NOT report an old edit as this session’s work', () => {
    // The defect: a resumed conversation carries every edit it ever made, so
    // scanning the whole file made every resume look like it did development.
    expect(transcriptHasEditsSince(transcript, SESSION_START)).toBe(false);
  });

  it('does report an edit made during the session', () => {
    const withEdit = `${transcript}\n${line(AFTER, {
      type: 'assistant',
      message: { content: [{ name: 'Write' }] },
    })}`;
    expect(transcriptHasEditsSince(withEdit, SESSION_START)).toBe(true);
  });

  it('counts only this session’s user turns', () => {
    expect(countUserTurnsSince(transcript, SESSION_START)).toBe(1);
  });

  it('excludes undated lines rather than assuming they are recent', () => {
    const withUndated = `${transcript}\n${line(null, { type: 'user' })}`;
    const window = transcriptSince(withUndated, SESSION_START);
    expect(window.undated).toBe(1);
    expect(window.lines).toHaveLength(1);
  });

  it('falls back to the whole transcript when the start time is unusable', () => {
    expect(transcriptSince(transcript, 'not-a-date').lines).toHaveLength(3);
  });

  it('handles an empty transcript', () => {
    expect(transcriptHasEditsSince('', SESSION_START)).toBe(false);
    expect(countUserTurnsSince('', SESSION_START)).toBe(0);
  });
});

describe('anyDirtyFileTouchedSince — a dirty tree is not evidence about this session', () => {
  let dir: string;
  const cutoffMs = Date.parse(SESSION_START);

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cr-gate-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const writeAt = (rel: string, whenMs: number) => {
    const abs = join(dir, rel);
    mkdirSync(join(abs, '..'), { recursive: true });
    writeFileSync(abs, 'x');
    utimesSync(abs, whenMs / 1000, whenMs / 1000);
  };

  it('ignores a file left dirty before the session started', () => {
    // This is the defect that made the gate permanently true: work sitting
    // uncommitted since last week kept `git status` non-empty forever.
    writeAt('old.ts', cutoffMs - 7 * 86400_000);
    expect(anyDirtyFileTouchedSince(dir, ' M old.ts', SESSION_START)).toBe(false);
  });

  it('counts a file modified during the session', () => {
    writeAt('fresh.ts', cutoffMs + 60_000);
    expect(anyDirtyFileTouchedSince(dir, ' M fresh.ts', SESSION_START)).toBe(true);
  });

  it('counts an untracked file created during the session', () => {
    writeAt('new.ts', cutoffMs + 60_000);
    expect(anyDirtyFileTouchedSince(dir, '?? new.ts', SESSION_START)).toBe(true);
  });

  it('sees the new path of a rename', () => {
    writeAt('after.ts', cutoffMs + 60_000);
    expect(anyDirtyFileTouchedSince(dir, 'R  before.ts -> after.ts', SESSION_START)).toBe(true);
  });

  it('unquotes paths git has quoted', () => {
    writeAt('odd name.ts', cutoffMs + 60_000);
    expect(anyDirtyFileTouchedSince(dir, ' M "odd name.ts"', SESSION_START)).toBe(true);
  });

  it('does not count a deleted file, whose mtime cannot be read', () => {
    expect(anyDirtyFileTouchedSince(dir, ' D gone.ts', SESSION_START)).toBe(false);
  });

  it('handles empty status output and an unusable cutoff', () => {
    expect(anyDirtyFileTouchedSince(dir, '', SESSION_START)).toBe(false);
    expect(anyDirtyFileTouchedSince(dir, ' M x.ts', 'nonsense')).toBe(false);
  });

  it('is true when any one of several dirty files is fresh', () => {
    writeAt('old.ts', cutoffMs - 86400_000);
    writeAt('fresh.ts', cutoffMs + 60_000);
    expect(anyDirtyFileTouchedSince(dir, ' M old.ts\n M fresh.ts', SESSION_START)).toBe(true);
  });
});

describe('findEntryForSession — claudeSessionId as the real idempotency key', () => {
  const meta = (over: Partial<LogEntryMeta>): LogEntryMeta => ({
    date: '2026-09-13T10:00:00.000Z',
    session: 's',
    branch: 'main',
    claudeSessionId: 'aaa',
    blockers: 0,
    openItems: 0,
    ...over,
  });

  const log = [
    '# Session Log',
    '',
    buildMarker(meta({ claudeSessionId: 'bbb' })),
    '## 2026-09-13 · newer · main',
    '**Done:** Second conversation.',
    '',
    buildMarker(meta({ claudeSessionId: 'aaa' })),
    '## 2026-09-12 · older · main',
    '**Done:** First conversation.',
    '',
  ].join('\n');

  it('finds the entry belonging to a conversation', () => {
    const found = findEntryForSession(log, 'aaa');
    expect(found?.index).toBe(1);
    expect(found?.entry.meta?.claudeSessionId).toBe('aaa');
  });

  it('returns null for a conversation with no entry yet', () => {
    expect(findEntryForSession(log, 'ccc')).toBeNull();
  });

  it('ignores the sentinel ids the generator writes when it has none', () => {
    expect(findEntryForSession(log, 'backfill')).toBeNull();
    expect(findEntryForSession(log, 'unknown')).toBeNull();
    expect(findEntryForSession(log, '')).toBeNull();
  });

  it('strips the marker and heading from the body it hands back', () => {
    const body = entryBodyOnly(findEntryForSession(log, 'aaa')!.entry);
    expect(body).toBe('**Done:** First conversation.');
    expect(body).not.toContain('claude-remote-log');
    expect(body).not.toContain('##');
  });

  it('handles a log with no entries at all', () => {
    expect(findEntryForSession('# Session Log\n', 'aaa')).toBeNull();
  });
});
