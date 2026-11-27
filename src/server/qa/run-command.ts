import { exec } from 'child_process';
import { promisify } from 'util';
import { createLogger } from '../utils/logger.js';

const execAsync = promisify(exec);
const logger = createLogger('qa-command');

/**
 * One declared QA command (project/QA.md's `commands:`), run with no agent
 * involved, so its pass/fail can be trusted: the merge queue re-verifies with
 * these before it merges.
 */

export type CheckStatus = 'passed' | 'failed' | 'skipped';

export interface QaCheck {
  name: string;
  status: CheckStatus;
  /** Failure output or skip reason, trimmed for display. */
  detail: string | null;
}

/** Per-command timeout; a hung test run must not hold the queue open. */
const COMMAND_TIMEOUT_MS = 5 * 60 * 1000;
const MAX_OUTPUT_CHARS = 1200;

function tail(text: string, limit = MAX_OUTPUT_CHARS): string {
  const trimmed = text.trim();
  return trimmed.length > limit ? `…${trimmed.slice(-limit)}` : trimmed;
}

/** Run one command in `cwd`. A non-zero exit is a failure, full stop: this half does not interpret. */
export async function runCommand(cwd: string, command: string): Promise<QaCheck> {
  try {
    const { stdout, stderr } = await execAsync(command, {
      cwd,
      timeout: COMMAND_TIMEOUT_MS,
      windowsHide: true,
      maxBuffer: 8 * 1024 * 1024,
    });
    logger.info({ command }, 'qa: command passed');
    return { name: command, status: 'passed', detail: tail(`${stdout}\n${stderr}`, 300) || null };
  } catch (error) {
    const e = error as { stdout?: string; stderr?: string; message?: string; killed?: boolean };
    const output = tail(`${e.stdout || ''}\n${e.stderr || ''}`) || e.message || 'failed';
    logger.warn({ command }, 'qa: command failed');
    return {
      name: command,
      status: 'failed',
      detail: e.killed ? `Timed out after ${COMMAND_TIMEOUT_MS / 1000}s` : output,
    };
  }
}
