import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtempSync, existsSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import pino from 'pino';

// The logger picks its destination when the module loads, so each case sets the env,
// points homedir() at a temp folder, and imports a fresh copy.
const dirs: string[] = [];
const loggers: pino.Logger[] = [];
const saved = { ...process.env };
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), 'cr-logger-'));
  dirs.push(d);
  return d;
};

async function loadLogger(home: string) {
  vi.resetModules();
  vi.doMock('os', async (orig) => ({ ...(await orig<typeof import('os')>()), homedir: () => home }));
  const mod = await import('../src/server/utils/logger.js');
  loggers.push(mod.logger);
  return mod;
}

// A non-test logger's rotating file stream opens asynchronously, so it re-creates its
// logs folder after a plain rmSync; end it (which waits for the open) before removing.
async function closeFileStreams(logger: pino.Logger): Promise<void> {
  const multi = (logger as unknown as Record<symbol, { streams?: { stream: NodeJS.WritableStream }[] }>)[pino.symbols.streamSym];
  for (const { stream } of multi?.streams ?? []) {
    if (stream === process.stdout) continue;
    await new Promise<void>((done) => {
      stream.once('close', () => done());
      stream.end();
    });
  }
}

afterEach(async () => {
  for (const logger of loggers.splice(0)) await closeFileStreams(logger);
  process.env = { ...saved };
  vi.doUnmock('os');
  vi.resetModules();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('logger destination', () => {
  it('writes no log file under test, so test runs never reach the live log', async () => {
    const home = tmp();
    delete process.env.CLAUDE_REMOTE_CONFIG;
    delete process.env.LOG_LEVEL;
    const { logger } = await loadLogger(home);
    logger.warn('from a test');
    expect(existsSync(join(home, '.claude-remote', 'logs'))).toBe(false);
  });

  it('logs next to CLAUDE_REMOTE_CONFIG on an isolated boot, never in the home log', async () => {
    const home = tmp();
    const isolated = tmp();
    delete process.env.VITEST;
    process.env.NODE_ENV = 'production';
    process.env.LOG_LEVEL = 'silent';
    process.env.CLAUDE_REMOTE_CONFIG = join(isolated, 'config.json');
    const { getLogDirectory } = await loadLogger(home);
    expect(getLogDirectory()).toBe(join(isolated, 'logs'));
    expect(existsSync(join(isolated, 'logs'))).toBe(true);
    expect(existsSync(join(home, '.claude-remote', 'logs'))).toBe(false);
  });

  it('uses ~/.claude-remote/logs for the live server', async () => {
    const home = tmp();
    delete process.env.VITEST;
    delete process.env.CLAUDE_REMOTE_CONFIG;
    process.env.NODE_ENV = 'production';
    process.env.LOG_LEVEL = 'silent';
    const { getLogDirectory } = await loadLogger(home);
    expect(getLogDirectory()).toBe(join(home, '.claude-remote', 'logs'));
  });
});
