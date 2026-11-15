/**
 * Claude's own name for each running Claude session, read from its live registry
 * (`<account configDir>/sessions/<pid>.json`: `{ pid, sessionId, name, … }`). `name` is what
 * `ListAgents` shows and what other agents address with `SendMessage`, so the sidebar
 * shows it beside a session whose claude-remote name differs (docs/session-orchestration.md).
 *
 * The registry is Claude Code's internal format: every read degrades to "no name", never
 * throws. A killed Claude leaves its file behind, so an entry counts only while its pid is
 * alive. The only writes are the cross-account copies (registry-mirror.ts), and reads skip
 * them: a stale copy must never name a session.
 */
import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { createLogger } from '../utils/logger.js';
import { allSessionsDirs } from '../accounts.js';
import { getConfig } from '../config.js';
import {
  isMirrorTarget,
  loadMirrorManifest,
  mirrorTargets,
  saveMirrorManifest,
  syncRegistryMirrors,
  type MirrorManifest,
} from './registry-mirror.js';

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
  isAlive: (pid: number) => boolean = pidAlive,
  skip: Set<string> = new Set()
): Map<string, string> {
  const names = new Map<string, string>();
  for (const dir of Array.isArray(dirs) ? dirs : [dirs]) readRegistryDir(dir, isAlive, names, skip);
  return names;
}

function readRegistryDir(
  dir: string,
  isAlive: (pid: number) => boolean,
  names: Map<string, string>,
  skip: Set<string>
): void {
  let files: string[];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith('.json'));
  } catch {
    return;
  }
  for (const file of files) {
    if (isMirrorTarget(skip, join(dir, file))) continue;
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

// Cross-account copies (project/cross-account-messaging.md). Never on an isolated boot
// (CLAUDE_REMOTE_CONFIG) or under the tests: both would write into the real config folders,
// and with the setting off would delete the live server's copies.
let manifest: MirrorManifest | null = null;

function manifestPath(): string {
  return join(getConfig().persistence.dataDir, 'registry-mirrors.json');
}

function mirrorsActive(): boolean {
  return !process.env.CLAUDE_REMOTE_CONFIG && !process.env.VITEST;
}

/** One mirror pass; returns the copies to skip when reading names. */
function syncMirrors(enabled: boolean): Set<string> {
  if (!mirrorsActive()) return new Set();
  manifest ??= loadMirrorManifest(manifestPath());
  const result = syncRegistryMirrors({ dirs: claudeRegistryDirs(), enabled, isAlive: pidAlive, manifest });
  if (result.changed) saveMirrorManifest(manifestPath(), manifest);
  return mirrorTargets(manifest);
}

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
      const copies = syncMirrors(getConfig().sessions.crossAccountMessaging === true);
      latest = readClaudeNames(claudeRegistryDirs(), pidAlive, copies);
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

/** Stops the poll and removes every cross-account copy: none may outlive the server. */
export function stopClaudeNameWatch(): void {
  if (timer) clearInterval(timer);
  timer = null;
  try {
    syncMirrors(false);
  } catch (error) {
    logger.warn({ error }, 'claude-registry: could not remove cross-account copies');
  }
}
