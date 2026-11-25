import { readFileSync, unlinkSync, writeFileSync } from 'fs';
import { join } from 'path';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('revive-on-boot');

/**
 * The sessions Build & restart parked, for the next boot to revive
 * (project/revive-after-build-restart.md). Only that route writes the list;
 * every other restart, a crash or a reboot leaves sessions stale as before.
 */
export const REVIVE_LIST_FILE = 'revive-on-boot.json';

/**
 * A list older than this is dropped unread: the restart it was written for
 * never happened (the launcher failed and the server was restarted by hand
 * later), and reviving it then would resurrect sessions the user has since
 * stopped. A Build & restart takes seconds to come back.
 */
export const REVIVE_LIST_MAX_AGE_MS = 10 * 60 * 1000;

interface ReviveList {
  writtenAt: string;
  sessionIds: string[];
}

export function reviveListPath(dataDir: string): string {
  return join(dataDir, REVIVE_LIST_FILE);
}

export function writeReviveList(dataDir: string, sessionIds: string[], now = new Date()): void {
  const list: ReviveList = { writtenAt: now.toISOString(), sessionIds };
  writeFileSync(reviveListPath(dataDir), JSON.stringify(list));
}

export function deleteReviveList(dataDir: string): void {
  try {
    unlinkSync(reviveListPath(dataDir));
  } catch {
    // Nothing to delete.
  }
}

/**
 * Read the list and delete it, so it is acted on at most once: deleted before
 * any revive, so a crash mid-revive never revives the same list twice. Empty
 * when there is none, it is too old, or it doesn't parse.
 */
export function takeReviveList(dataDir: string, now = new Date()): string[] {
  let raw: string;
  try {
    raw = readFileSync(reviveListPath(dataDir), 'utf-8');
  } catch {
    return [];
  }
  deleteReviveList(dataDir);
  try {
    const parsed = JSON.parse(raw) as Partial<ReviveList>;
    const writtenAt = Date.parse(String(parsed.writtenAt));
    if (!Number.isFinite(writtenAt) || !Array.isArray(parsed.sessionIds)) return [];
    const age = now.getTime() - writtenAt;
    if (age > REVIVE_LIST_MAX_AGE_MS || age < -REVIVE_LIST_MAX_AGE_MS) {
      logger.info({ writtenAt: parsed.writtenAt, count: parsed.sessionIds.length }, 'Ignoring a stale revive list');
      return [];
    }
    return parsed.sessionIds.filter((id): id is string => typeof id === 'string' && id.length > 0);
  } catch {
    return [];
  }
}

/**
 * Revive each id in turn; a refusal (missing cwd, transcript gone, account not
 * ready, row deleted) is logged and leaves that session stale with its Play
 * button, and never stops the rest. Returns the ids revived.
 */
export function reviveListed(ids: string[], revive: (id: string) => void): string[] {
  const revived: string[] = [];
  for (const id of ids) {
    try {
      revive(id);
      revived.push(id);
    } catch (error) {
      logger.warn({ id, error: error instanceof Error ? error.message : String(error) }, 'Could not revive a session after Build & restart');
    }
  }
  if (ids.length > 0) logger.info({ revived: revived.length, listed: ids.length }, 'Revived sessions after Build & restart');
  return revived;
}

/**
 * At boot: revive what the last Build & restart parked. Never on an isolated
 * boot (CLAUDE_REMOTE_CONFIG) or under vitest, which have their own data dir
 * and must not touch the live server's list.
 */
export function reviveSessionsFromRestart(
  dataDir: string,
  revive: (id: string) => void,
  env: NodeJS.ProcessEnv = process.env
): string[] {
  if (env.CLAUDE_REMOTE_CONFIG || env.VITEST) return [];
  return reviveListed(takeReviveList(dataDir), revive);
}
