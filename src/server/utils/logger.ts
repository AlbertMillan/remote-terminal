import pino from 'pino';
import { createStream } from 'rotating-file-stream';
import { mkdirSync, existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

const isDev = process.env.NODE_ENV !== 'production';

// Ensure log directory exists
const logDir = join(homedir(), '.claude-remote', 'logs');
if (!existsSync(logDir)) {
  mkdirSync(logDir, { recursive: true });
}

// Create rotating file stream (rotates every 3 days, keeps 7 files)
const fileStream = createStream('server.log', {
  path: logDir,
  interval: '3d',
  maxFiles: 7,
});

// Create multistream for both console and file
const streams: pino.StreamEntry[] = [
  // Always write to file (JSON format for structured logging)
  { stream: fileStream },
];

// In dev mode, also write to console with pretty printing
if (isDev) {
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
    level: process.env.LOG_LEVEL || (isDev ? 'debug' : 'info'),
  },
  pino.multistream(streams)
);

export function createLogger(name: string) {
  return logger.child({ component: name });
}

export function getLogDirectory(): string {
  return logDir;
}
