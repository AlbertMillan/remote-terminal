import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { buildMarker, parseLogEntries, type LogEntryMeta } from '../src/server/sessions/session-log-format.js';

// A temp HOME so the "transcript must live under ~/.claude/projects" guard can be
// exercised without touching the developer's real Claude directory.
const FAKE_HOME = mkdtempSync(join(tmpdir(), 'cr-home-'));
const TRANSCRIPTS_DIR = join(FAKE_HOME, '.claude', 'projects', 'proj');

const SID_A = '11111111-1111-4111-8111-111111111111';
const SID_B = '22222222-2222-4222-8222-222222222222';

let projectCwd = '';
let liveClaudeSessionIds: string[] = [];
const invalidateProjectCache = vi.fn();

vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>();
  return { ...actual, homedir: () => FAKE_HOME };
});

vi.mock('../src/server/config.js', () => ({
  getConfig: () => ({ projectLog: { fileName: 'SESSION-LOG.md' } }),
}));

vi.mock('../src/server/utils/logger.js', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

vi.mock('../src/server/sessions/project-discovery.js', () => ({
  findProjectByCwd: (cwd: string) =>
    cwd === projectCwd ? { cwd: projectCwd, name: 'proj', hasLog: true, lastActivity: null, transcriptCount: 1, transcriptPaths: [] } : undefined,
  invalidateProjectCache: () => invalidateProjectCache(),
}));

// A live session is one whose DB row carries the Claude session id.
vi.mock('../src/server/sessions/manager.js', () => ({
  sessionManager: { getAllSessions: () => liveClaudeSessionIds.map((sid) => ({ id: `s-${sid}` })) },
}));
vi.mock('../src/server/db/queries.js', () => ({
  getSession: (id: string) => ({ claudeSessionId: id.replace(/^s-/, '') }),
}));

const { deleteHistoryEntry, HistoryDeleteError } = await import('../src/server/sessions/history-delete.js');

const META: LogEntryMeta = {
  date: '2026-06-28T10:00:00.000Z',
  session: 'Work',
  branch: 'main',
  claudeSessionId: SID_A,
  blockers: 0,
  openItems: 0,
};

const entry = (sid: string, body: string): string =>
  `${buildMarker({ ...META, claudeSessionId: sid })}\n## entry\n${body}\n`;

const logPath = (): string => join(projectCwd, 'SESSION-LOG.md');
const transcript = (sid: string): string => join(TRANSCRIPTS_DIR, `${sid}.jsonl`);

function writeLog(markdown: string): void {
  writeFileSync(logPath(), markdown, 'utf-8');
}

function writeTranscript(sid: string): void {
  writeFileSync(transcript(sid), '{"cwd":"x"}\n', 'utf-8');
}

beforeEach(() => {
  projectCwd = mkdtempSync(join(tmpdir(), 'cr-proj-'));
  mkdirSync(TRANSCRIPTS_DIR, { recursive: true });
  liveClaudeSessionIds = [];
  invalidateProjectCache.mockClear();
});

afterEach(() => {
  rmSync(projectCwd, { recursive: true, force: true });
  rmSync(TRANSCRIPTS_DIR, { recursive: true, force: true });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('deleteHistoryEntry', () => {
  it('removes the entry and unlinks the transcript nothing else references', () => {
    writeLog(`# Session Log\n\n${entry(SID_A, 'body A')}\n${entry(SID_B, 'body B')}`);
    writeTranscript(SID_A);

    const result = deleteHistoryEntry({ cwd: projectCwd, entryIndex: 0, expectedClaudeSessionId: SID_A });

    expect(result.removedEntries).toBe(1);
    expect(result.remainingEntries).toBe(1);
    expect(result.transcriptDeleted).toBe(true);
    expect(result.transcriptKeptReason).toBeNull();
    expect(existsSync(transcript(SID_A))).toBe(false);
    expect(parseLogEntries(readFileSync(logPath(), 'utf-8')).map((e) => e.meta?.claudeSessionId)).toEqual([SID_B]);
    expect(invalidateProjectCache).toHaveBeenCalled();
  });

  it('keeps the transcript while a sibling entry still references it', () => {
    writeLog(`# Session Log\n\n${entry(SID_A, 'first')}\n${entry(SID_A, 'second')}`);
    writeTranscript(SID_A);

    const result = deleteHistoryEntry({ cwd: projectCwd, entryIndex: 0, expectedClaudeSessionId: SID_A });

    expect(result.removedEntries).toBe(1);
    expect(result.transcriptDeleted).toBe(false);
    expect(result.transcriptKeptReason).toBe('still-referenced');
    expect(existsSync(transcript(SID_A))).toBe(true);
  });

  it("scope 'conversation' clears every entry for that session id and deletes the transcript", () => {
    writeLog(`# Session Log\n\n${entry(SID_A, 'first')}\n${entry(SID_B, 'other')}\n${entry(SID_A, 'second')}`);
    writeTranscript(SID_A);
    writeTranscript(SID_B);

    const result = deleteHistoryEntry({
      cwd: projectCwd,
      entryIndex: 0,
      expectedClaudeSessionId: SID_A,
      scope: 'conversation',
    });

    expect(result.removedEntries).toBe(2);
    expect(result.remainingEntries).toBe(1);
    expect(result.transcriptDeleted).toBe(true);
    expect(existsSync(transcript(SID_A))).toBe(false);
    expect(existsSync(transcript(SID_B))).toBe(true);
    expect(parseLogEntries(readFileSync(logPath(), 'utf-8')).map((e) => e.meta?.claudeSessionId)).toEqual([SID_B]);
  });

  it('refuses to unlink a transcript a running session is using', () => {
    writeLog(`# Session Log\n\n${entry(SID_A, 'body A')}`);
    writeTranscript(SID_A);
    liveClaudeSessionIds = [SID_A];

    const result = deleteHistoryEntry({ cwd: projectCwd, entryIndex: 0, expectedClaudeSessionId: SID_A });

    expect(result.removedEntries).toBe(1);
    expect(result.transcriptKeptReason).toBe('session-live');
    expect(existsSync(transcript(SID_A))).toBe(true);
  });

  it('removes a backfill entry without touching any transcript', () => {
    writeLog(`# Session Log\n\n${entry('backfill', 'historic')}\n${entry(SID_A, 'body A')}`);
    writeTranscript(SID_A);

    const result = deleteHistoryEntry({ cwd: projectCwd, entryIndex: 0, expectedClaudeSessionId: 'backfill' });

    expect(result.removedEntries).toBe(1);
    expect(result.transcriptKeptReason).toBe('no-session-id');
    expect(existsSync(transcript(SID_A))).toBe(true);
  });

  it('refuses to unlink when the marker session id is not a plain UUID', () => {
    const sneaky = '../../../etc/passwd';
    writeLog(`# Session Log\n\n${entry(sneaky, 'body')}`);

    const result = deleteHistoryEntry({ cwd: projectCwd, entryIndex: 0, expectedClaudeSessionId: sneaky });

    expect(result.removedEntries).toBe(1);
    expect(result.transcriptKeptReason).toBe('unsafe-id');
  });

  it('reports not-found when the transcript is already gone', () => {
    writeLog(`# Session Log\n\n${entry(SID_A, 'body A')}`);

    const result = deleteHistoryEntry({ cwd: projectCwd, entryIndex: 0, expectedClaudeSessionId: SID_A });

    expect(result.transcriptDeleted).toBe(false);
    expect(result.transcriptKeptReason).toBe('not-found');
  });

  it('rejects a stale index/session-id pair without modifying the log (409)', () => {
    const markdown = `# Session Log\n\n${entry(SID_A, 'body A')}\n${entry(SID_B, 'body B')}`;
    writeLog(markdown);
    writeTranscript(SID_A);

    expect(() =>
      deleteHistoryEntry({ cwd: projectCwd, entryIndex: 0, expectedClaudeSessionId: SID_B })
    ).toThrow(HistoryDeleteError);
    expect(readFileSync(logPath(), 'utf-8')).toBe(markdown);
    expect(existsSync(transcript(SID_A))).toBe(true);
  });

  it('rejects an out-of-range index (409) and an unknown project (404)', () => {
    writeLog(`# Session Log\n\n${entry(SID_A, 'body A')}`);

    try {
      deleteHistoryEntry({ cwd: projectCwd, entryIndex: 5 });
      throw new Error('expected throw');
    } catch (err) {
      expect((err as InstanceType<typeof HistoryDeleteError>).status).toBe(409);
    }
    try {
      deleteHistoryEntry({ cwd: join(tmpdir(), 'not-a-project'), entryIndex: 0 });
      throw new Error('expected throw');
    } catch (err) {
      expect((err as InstanceType<typeof HistoryDeleteError>).status).toBe(404);
    }
  });

  it('404s when the project has no log file', () => {
    try {
      deleteHistoryEntry({ cwd: projectCwd, entryIndex: 0 });
      throw new Error('expected throw');
    } catch (err) {
      expect((err as InstanceType<typeof HistoryDeleteError>).status).toBe(404);
    }
  });
});
