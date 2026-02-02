import { exec, spawn } from 'child_process';
import { promisify } from 'util';
import { isWindows } from '../utils/platform.js';
import { createLogger } from '../utils/logger.js';
import { saveScrollback, getScrollback } from '../db/queries.js';

const execAsync = promisify(exec);
const logger = createLogger('persistence');

export interface TmuxSession {
  name: string;
  attached: boolean;
  windows: number;
}

export async function isTmuxAvailable(): Promise<boolean> {
  if (isWindows()) return false;

  try {
    await execAsync('which tmux');
    return true;
  } catch {
    return false;
  }
}

export async function createTmuxSession(sessionName: string, shell: string, cwd: string): Promise<boolean> {
  if (!(await isTmuxAvailable())) {
    logger.warn('tmux not available, session will not persist across server restarts');
    return false;
  }

  try {
    // Create detached tmux session
    await execAsync(
      `tmux new-session -d -s "${sessionName}" -c "${cwd}" "${shell}"`,
      { cwd }
    );
    logger.info({ sessionName, shell, cwd }, 'Created tmux session');
    return true;
  } catch (error) {
    logger.error({ error, sessionName }, 'Failed to create tmux session');
    return false;
  }
}

export async function attachToTmuxSession(sessionName: string): Promise<{ stdin: NodeJS.WritableStream; stdout: NodeJS.ReadableStream } | null> {
  if (!(await isTmuxAvailable())) return null;

  try {
    const tmux = spawn('tmux', ['attach-session', '-t', sessionName], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return {
      stdin: tmux.stdin,
      stdout: tmux.stdout,
    };
  } catch (error) {
    logger.error({ error, sessionName }, 'Failed to attach to tmux session');
    return null;
  }
}

export async function killTmuxSession(sessionName: string): Promise<boolean> {
  if (!(await isTmuxAvailable())) return false;

  try {
    await execAsync(`tmux kill-session -t "${sessionName}"`);
    logger.info({ sessionName }, 'Killed tmux session');
    return true;
  } catch (error) {
    logger.error({ error, sessionName }, 'Failed to kill tmux session');
    return false;
  }
}

export async function listTmuxSessions(): Promise<TmuxSession[]> {
  if (!(await isTmuxAvailable())) return [];

  try {
    const { stdout } = await execAsync('tmux list-sessions -F "#{session_name}:#{session_attached}:#{session_windows}"');
    return stdout
      .trim()
      .split('\n')
      .filter((line) => line.length > 0)
      .map((line) => {
        const [name, attached, windows] = line.split(':');
        return {
          name,
          attached: attached === '1',
          windows: parseInt(windows, 10),
        };
      });
  } catch {
    // No sessions or tmux not running
    return [];
  }
}

export async function tmuxSessionExists(sessionName: string): Promise<boolean> {
  const sessions = await listTmuxSessions();
  return sessions.some((s) => s.name === sessionName);
}

// Windows persistence - store scrollback and allow reconnection
export function persistScrollback(sessionId: string, scrollback: string[]): void {
  const content = scrollback.join('\n');
  saveScrollback(sessionId, content);
  logger.debug({ sessionId, lines: scrollback.length }, 'Persisted scrollback');
}

export function restoreScrollback(sessionId: string): string[] {
  const content = getScrollback(sessionId);
  if (!content) return [];
  const lines = content.split('\n');
  logger.debug({ sessionId, lines: lines.length }, 'Restored scrollback');
  return lines;
}

// Get persistence strategy for current platform
export function getPersistenceStrategy(): 'tmux' | 'scrollback' {
  // tmux is available on Linux and macOS, Windows uses scrollback persistence
  return isWindows() ? 'scrollback' : 'tmux';
}
