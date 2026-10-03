import pino from 'pino';
import { createStream } from 'rotating-file-stream';
import { mkdirSync, existsSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { homedir } from 'os';

const isDev = process.env.NODE_ENV !== 'production';

// Only the live server may write ~/.claude-remote/logs. Tests (vitest sets VITEST) write
// no file, and log nothing unless LOG_LEVEL asks; a boot with CLAUDE_REMOTE_CONFIG (the
// isolated boot in project/QA.md) logs next to that config. Before this, one `npm test`
// added ~900 lines of fake sessions, lands and restart requests to the live log, and
// finding the real events in it meant filtering by hand.
const underTest = !!process.env.VITEST;
const configOverride = process.env.CLAUDE_REMOTE_CONFIG;
const logDir = configOverride
  ? join(dirname(resolve(configOverride)), 'logs')
  : join(homedir(), '.claude-remote', 'logs');

const streams: pino.StreamEntry[] = [];

if (underTest) {
  if (process.env.LOG_LEVEL) streams.push({ stream: process.stdout });
} else {
  if (!existsSync(logDir)) {
    mkdirSync(logDir, { recursive: true });
  }
  // Rotating file stream (rotates every 3 days, keeps 7 files), JSON for structured logging
  streams.push({
    stream: createStream('server.log', {
      path: logDir,
      interval: '3d',
      maxFiles: 7,
    }),
  });
}

// In dev mode, also write to console with pretty printing
if (underTest) {
  // Already decided above: stdout only when LOG_LEVEL asks for it.
} else if (isDev) {
  // Use pino-pretty for console output
  const prettyStream = pino.transport({
    target: 'pino-pretty',
    options: {
      colorize: true,
      translateTime: 'SYS:standard',
      ignore: 'pid,hostname',
    },
  });
  streams.push({ stream: prettyStream });
} else {
  // In production, write plain JSON to console as well
  streams.push({ stream: process.stdout });
}

export const logger = pino(
  {
    level: process.env.LOG_LEVEL || (underTest ? 'silent' : isDev ? 'debug' : 'info'),
  },
  pino.multistream(streams)
);

export function createLogger(name: string) {
  return logger.child({ component: name });
}

export function getLogDirectory(): string {
  return logDir;
}
