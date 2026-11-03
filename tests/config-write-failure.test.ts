import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

/**
 * setMaxSessions writes config.json through config.json.tmp. When the rename fails
 * (a locked file on Windows, a full disk), the temp file is removed, the original is
 * untouched, the error reaches the caller and the live limit stays as it was.
 */

const failRename = { on: false };
vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  return {
    ...actual,
    renameSync: (from: string, to: string) => {
      if (failRename.on) throw Object.assign(new Error(`EPERM: operation not permitted, rename '${from}'`), { code: 'EPERM' });
      return actual.renameSync(from, to);
    },
  };
});

vi.mock('../src/server/utils/logger.js', () => ({
  createLogger: vi.fn(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() })),
}));

import { getConfig, loadConfig, setMaxSessions } from '../src/server/config.js';

let dir: string;
let configPath: string;
const previousEnv = process.env.CLAUDE_REMOTE_CONFIG;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cr-config-'));
  configPath = join(dir, 'config.json');
  process.env.CLAUDE_REMOTE_CONFIG = configPath;
});

afterEach(() => {
  failRename.on = false;
  if (previousEnv === undefined) delete process.env.CLAUDE_REMOTE_CONFIG;
  else process.env.CLAUDE_REMOTE_CONFIG = previousEnv;
  rmSync(dir, { recursive: true, force: true });
});

describe('setMaxSessions when the write fails', () => {
  it('removes the temp file and rethrows, leaving the file and the live limit alone', () => {
    const original = JSON.stringify({ sessions: { maxSessions: 12 } });
    writeFileSync(configPath, original);
    loadConfig();
    failRename.on = true;
    expect(() => setMaxSessions(20)).toThrow(/EPERM/);
    expect(readdirSync(dir)).toEqual(['config.json']);
    expect(readFileSync(configPath, 'utf-8')).toBe(original);
    expect(getConfig().sessions.maxSessions).toBe(12);
  });
});
