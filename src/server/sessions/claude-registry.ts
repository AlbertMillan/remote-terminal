/**
 * Claude's own name for each running Claude session, read from its live registry
 * (`<account configDir>/sessions/<pid>.json`: `{ pid, sessionId, name, … }`). `name` is what
 * `ListAgents` shows and what other agents address with `SendMessage`, so the sidebar
 * shows it beside a session whose claude-remote name differs (docs/session-orchestration.md).
 *
 * The registry is Claude Code's internal format: every read degrades to "no name", never
 * throws, and nothing here writes to it. A killed Claude leaves its file behind, so an
 * entry counts only while its pid is alive.
 */
import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { createLogger } from '../utils/logger.js';
import { allSessionsDirs } from '../accounts.js';

const logger = createLogger('claude-registry');

/** Every account's live registry: each session's `claude` writes to its own account's. */
export function claudeRegistryDirs(): string[] {
  return allSessionsDirs();
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: the process exists but isn't ours to signal.
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Claude session id → Claude's name, for every live entry in `dirs`. */
export function readClaudeNames(
  dirs: string | string[] = claudeRegistryDirs(),
  isAlive: (pid: number) => boolean = pidAlive
): Map<string, string> {
  const names = new Map<string, string>();
  for (const dir of Array.isArray(dirs) ? dirs : [dirs]) readRegistryDir(dir, isAlive, names);
  return names;
}

function readRegistryDir(dir: string, isAlive: (pid: number) => boolean, names: Map<string, string>): void {
  let files: string[];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith('.json'));
  } catch {
    return;
  }
  for (const file of files) {
    try {
      const entry = JSON.parse(readFileSync(join(dir, file), 'utf8')) as Record<string, unknown>;
      const { pid, sessionId, name } = entry;
      if (typeof pid !== 'number' || typeof sessionId !== 'string' || typeof name !== 'string') continue;
      if (!name || !isAlive(pid)) continue;
      names.set(sessionId, name);
    } catch {
      // Mid-write or not ours to understand: skip it.
    }
  }
}

let latest = new Map<string, string>();

/** The last read's name for a Claude session id, or null. */
export function claudeNameFor(claudeSessionId: string | null | undefined): string | null {
  return claudeSessionId ? latest.get(claudeSessionId) ?? null : null;
}

const POLL_MS = 5000;
let timer: NodeJS.Timeout | null = null;

/**
 * Re-read the registry every few seconds and call `onChange` with claude-remote session id
 * → Claude name whenever that mapping changes. Polled: Claude starts, exits and `/rename`s
 * without telling us, and the claude-session hook only says which conversation a session
 * holds, not what Claude calls it.
 */
export function startClaudeNameWatch(
  sessions: () => { id: string; claudeSessionId: string | null }[],
  onChange: (names: Record<string, string>) => void
): void {
  let last = '';
  const tick = () => {
    try {
      latest = readClaudeNames();
      const names: Record<string, string> = {};
      for (const s of sessions()) {
        const name = claudeNameFor(s.claudeSessionId);
        if (name) names[s.id] = name;
      }
      const key = JSON.stringify(names);
      if (key !== last) {
        last = key;
        onChange(names);
      }
    } catch (error) {
      logger.warn({ error }, 'claude-registry: poll failed');
    }
  };
  tick();
  timer = setInterval(tick, POLL_MS);
  timer.unref?.();
}

export function stopClaudeNameWatch(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
