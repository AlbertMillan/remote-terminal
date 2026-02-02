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

/**
 * Circular buffer implementation for terminal scrollback.
 * Uses O(1) operations instead of O(n) array shifts.
 */
export class ScrollbackBuffer {
  private buffer: string[];
  private maxLines: number;
  private head: number = 0; // Next write position
  private size: number = 0; // Current number of lines
  private partialLine: string = '';

  constructor(maxLines?: number) {
    this.maxLines = maxLines || getConfig().persistence.scrollbackLines;
    this.buffer = new Array(this.maxLines);
  }

  push(data: string): void {
    // Combine with any partial line from previous push
    const combined = this.partialLine + data;
    const lines = combined.split(/\r?\n/);

    // Last element might be a partial line (no trailing newline)
    this.partialLine = lines.pop() || '';

    // Add complete lines to circular buffer
    for (const line of lines) {
      this.buffer[this.head] = line;
      this.head = (this.head + 1) % this.maxLines;
      if (this.size < this.maxLines) {
        this.size++;
      }
    }
  }

  getAll(): string[] {
    if (this.size === 0) {
      return this.partialLine ? [this.partialLine] : [];
    }

    const result: string[] = new Array(this.size);
    // Start reading from the oldest entry
    const start = this.size < this.maxLines ? 0 : this.head;

    for (let i = 0; i < this.size; i++) {
      result[i] = this.buffer[(start + i) % this.maxLines];
    }

    // Include partial line if present
    if (this.partialLine) {
      result.push(this.partialLine);
    }
    return result;
  }

  getRecent(count: number): string[] {
    const all = this.getAll();
    return all.slice(-count);
  }

  clear(): void {
    this.head = 0;
    this.size = 0;
    this.partialLine = '';
    // Clear references to allow GC
    this.buffer = new Array(this.maxLines);
  }

  get length(): number {
    return this.size + (this.partialLine ? 1 : 0);
  }
}
