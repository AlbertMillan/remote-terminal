import { getConfig } from '../config.js';
import { countActiveSessions } from '../db/queries.js';

/**
 * Refuse a new session once `sessions.maxSessions` are counted; returns the count checked.
 *
 * Create, fork and history open call this. Revive never does: a stale row is already
 * counted (status != 'terminated'), so checking there would make every session unrevivable
 * after a restart at the limit (docs/session-revive.md).
 *
 * `reserved` counts sessions already admitted whose row isn't in the table yet: a caller
 * that awaits between this check and its insert passes its in-flight count, or concurrent
 * opens all count the same table and every one of them passes.
 */
export function assertSessionSlot(reserved = 0): number {
  const { maxSessions } = getConfig().sessions;
  const activeCount = countActiveSessions() + reserved;
  if (activeCount >= maxSessions) {
    throw new Error(`Maximum session limit (${maxSessions}) reached`);
  }
  return activeCount;
}
