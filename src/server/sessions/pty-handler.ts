import * as pty from 'node-pty';
import type { IPty } from 'node-pty';
import { getDefaultShell, getShellArgs, isWindows } from '../utils/platform.js';
import { createLogger } from '../utils/logger.js';
import { withoutInheritedClaudeSession } from '../utils/claude-env.js';
import { accountEnv } from '../accounts.js';

const logger = createLogger('pty-handler');

export interface PtyOptions {
  shell?: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  cols?: number;
  rows?: number;
  /** The Claude login it runs under: its `CLAUDE_CONFIG_DIR` and the stripped auth env (accounts.ts). */
  account: string;
}

export function createPty(options: PtyOptions): IPty {
  const shell = options.shell || getDefaultShell();
  const args = options.args || getShellArgs();
  let cwd = options.cwd || process.cwd();
  // Normalize the Windows drive letter to uppercase (e.g. c:\ -> C:\). This is the single
  // chokepoint for every PTY spawn, so it guarantees the cwd `claude` records is uppercase
  // no matter what the new-session form, recent-paths dropdown, or DB supplied. claude --resume
  // matches a session's recorded cwd case-sensitively, so a lowercase drive letter would hide
  // the session from the resume picker.
  if (isWindows()) {
    cwd = cwd.replace(/^([a-z]):/, (_, d) => `${d.toUpperCase()}:`);
  }
  const cols = options.cols || 80;
  const rows = options.rows || 24;

  // Drop the parent-session markers a `claude` that launched this server stamped on
  // it (see utils/claude-env.ts). A terminal we hand out is a top-level session; left
  // in, CLAUDE_CODE_CHILD_SESSION makes every `claude` in it skip saving its
  // transcript, which silently breaks Fork, resume history and SESSION-LOG.
  //
  // accountEnv: the account's CLAUDE_CONFIG_DIR, and no inherited API key, OAuth token or
  // telemetry switch, or every `claude` in it runs under whatever login those name.
  const env: Record<string, string | undefined> = {
    ...accountEnv({ ...withoutInheritedClaudeSession(process.env), ...options.env }, options.account),
    TERM: 'xterm-256color',
    COLORTERM: 'truecolor',
  };
  // The PTY is a truecolor xterm, so drop a NO_COLOR the server inherited: a server
  // restarted from a tool shell (e.g. a `claude` Bash call) carries NO_COLOR=1, and
  // every terminal it hands out then renders `claude` without color.
  delete env.NO_COLOR;

  logger.debug({ shell, args, cwd, cols, rows, account: options.account }, 'Creating PTY');

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

/**
 * Resolves when the PTY's own process (the shell) exits, or after `timeoutMs`,
 * whichever is first. Says nothing about the shell's children. Never rejects:
 * a PTY that ignores its kill must not hang the caller.
 */
export function ptyExit(ptyProcess: IPty, timeoutMs: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      listener.dispose();
      logger.warn({ pid: ptyProcess.pid, timeoutMs }, 'PTY did not report its exit in time');
      resolve();
    }, timeoutMs);
    timer.unref?.();
    const listener = ptyProcess.onExit(() => {
      clearTimeout(timer);
      listener.dispose();
      resolve();
    });
  });
}

export function killPty(ptyProcess: IPty): void {
  try {
    ptyProcess.kill();
    logger.info({ pid: ptyProcess.pid }, 'PTY process killed');
  } catch (error) {
    logger.error({ error, pid: ptyProcess.pid }, 'Failed to kill PTY');
  }
}
