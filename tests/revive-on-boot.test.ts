import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

vi.mock('../src/server/utils/logger.js', () => ({
  createLogger: vi.fn(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() })),
}));

import {
  REVIVE_LIST_MAX_AGE_MS,
  reviveListPath,
  reviveListed,
  reviveSessionsFromRestart,
  takeReviveList,
  writeReviveList,
} from '../src/server/sessions/revive-on-boot.js';

/**
 * The list Build & restart leaves for the next boot (project/revive-after-build-restart.md):
 * acted on once, never when stale, and one refused session never stops the rest.
 */

let dataDir: string;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'cr-revive-on-boot-'));
});

afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

describe('takeReviveList', () => {
  it('returns the ids once and deletes the file', () => {
    writeReviveList(dataDir, ['a', 'b']);
    expect(takeReviveList(dataDir)).toEqual(['a', 'b']);
    expect(existsSync(reviveListPath(dataDir))).toBe(false);
    expect(takeReviveList(dataDir)).toEqual([]);
  });

  it('is empty without a file', () => {
    expect(takeReviveList(dataDir)).toEqual([]);
  });

  it('drops a stale list, deleting it too', () => {
    const then = new Date('2026-11-25T10:00:00.000Z');
    writeReviveList(dataDir, ['a'], then);
    const later = new Date(then.getTime() + REVIVE_LIST_MAX_AGE_MS + 1);
    expect(takeReviveList(dataDir, later)).toEqual([]);
    expect(existsSync(reviveListPath(dataDir))).toBe(false);
  });

  it('keeps a list within the limit', () => {
    const then = new Date('2026-11-25T10:00:00.000Z');
    writeReviveList(dataDir, ['a'], then);
    expect(takeReviveList(dataDir, new Date(then.getTime() + 30_000))).toEqual(['a']);
  });

  it('drops a garbled file and keeps only string ids', () => {
    writeFileSync(reviveListPath(dataDir), '{not json');
    expect(takeReviveList(dataDir)).toEqual([]);
    expect(existsSync(reviveListPath(dataDir))).toBe(false);

    writeFileSync(reviveListPath(dataDir), JSON.stringify({ writtenAt: new Date().toISOString(), sessionIds: ['a', 3, '', null] }));
    expect(takeReviveList(dataDir)).toEqual(['a']);
  });
});

describe('reviveListed', () => {
  it('revives each in order, and a refusal does not stop the rest', () => {
    const revive = vi.fn((id: string) => {
      if (id === 'b') throw new Error('Failed to start shell in C:\\gone');
    });
    expect(reviveListed(['a', 'b', 'c'], revive)).toEqual(['a', 'c']);
    expect(revive.mock.calls.map(([id]) => id)).toEqual(['a', 'b', 'c']);
  });
});

describe('reviveSessionsFromRestart', () => {
  it('revives the listed sessions at boot', () => {
    writeReviveList(dataDir, ['a']);
    const revive = vi.fn();
    expect(reviveSessionsFromRestart(dataDir, revive, {})).toEqual(['a']);
    expect(revive).toHaveBeenCalledWith('a');
  });

  it('never runs on an isolated boot or under vitest, and leaves the list alone', () => {
    writeReviveList(dataDir, ['a']);
    const revive = vi.fn();
    expect(reviveSessionsFromRestart(dataDir, revive, { CLAUDE_REMOTE_CONFIG: 'x.json' })).toEqual([]);
    expect(reviveSessionsFromRestart(dataDir, revive, { VITEST: 'true' })).toEqual([]);
    expect(revive).not.toHaveBeenCalled();
    expect(existsSync(reviveListPath(dataDir))).toBe(true);
  });
});
