import * as pty from 'node-pty';
import type { IPty } from 'node-pty';
import { getDefaultShell, getShellArgs, isWindows } from '../utils/platform.js';
import { createLogger } from '../utils/logger.js';
import { getConfig } from '../config.js';

const logger = createLogger('pty-handler');

export interface PtyOptions {
  shell?: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  cols?: number;
  rows?: number;
}

export function createPty(options: PtyOptions = {}): IPty {
  const shell = options.shell || getDefaultShell();
  const args = options.args || getShellArgs();
  const cwd = options.cwd || process.cwd();
  const cols = options.cols || 80;
  const rows = options.rows || 24;

  const env = {
    ...process.env,
    ...options.env,
    TERM: 'xterm-256color',
    COLORTERM: 'truecolor',
  };

  logger.debug({ shell, args, cwd, cols, rows }, 'Creating PTY');

  const ptyProcess = pty.spawn(shell, args, {
    name: 'xterm-256color',
    cols,
    rows,
    cwd,
    env: env as Record<string, string>,
    useConpty: isWindows(), // Use ConPTY on Windows
  });

  logger.info({ pid: ptyProcess.pid, shell }, 'PTY process spawned');

  return ptyProcess;
}

export function resizePty(ptyProcess: IPty, cols: number, rows: number): void {
  try {
    ptyProcess.resize(cols, rows);
    logger.debug({ pid: ptyProcess.pid, cols, rows }, 'PTY resized');
  } catch (error) {
    logger.error({ error, pid: ptyProcess.pid }, 'Failed to resize PTY');
  }
}

export function writeToPty(ptyProcess: IPty, data: string): void {
  try {
    ptyProcess.write(data);
  } catch (error) {
    logger.error({ error, pid: ptyProcess.pid }, 'Failed to write to PTY');
  }
}

export function killPty(ptyProcess: IPty): void {
  try {
    ptyProcess.kill();
    logger.info({ pid: ptyProcess.pid }, 'PTY process killed');
  } catch (error) {
    logger.error({ error, pid: ptyProcess.pid }, 'Failed to kill PTY');
  }
}

export class ScrollbackBuffer {
  private buffer: string[] = [];
  private maxLines: number;

  constructor(maxLines?: number) {
    this.maxLines = maxLines || getConfig().persistence.scrollbackLines;
  }

  push(data: string): void {
    // Split by newlines and add to buffer
    const lines = data.split(/\r?\n/);
    for (const line of lines) {
      if (line.length > 0) {
        this.buffer.push(line);
        if (this.buffer.length > this.maxLines) {
          this.buffer.shift();
        }
      }
    }
  }

  getAll(): string[] {
    return [...this.buffer];
  }

  getRecent(count: number): string[] {
    return this.buffer.slice(-count);
  }

  clear(): void {
    this.buffer = [];
  }

  get length(): number {
    return this.buffer.length;
  }
}
