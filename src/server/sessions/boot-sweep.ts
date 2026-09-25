import { unlinkSync } from 'fs';
import { generateSessionLog } from './project-log.js';
import { getConfig } from '../config.js';
import { createLogger } from '../utils/logger.js';
import {
  getAllSessions as getAllSessionsFromDb,
  updateSession,
  getUnloggedSessionsForLog,
} from '../db/queries.js';

const logger = createLogger('session-manager');

/**
 * Called on server startup to recover from crashes mid-fork.
 * Any fork session that isn't 'terminated' at startup has no live PTY —
 * delete its JSONL and mark it terminated so it doesn't reappear as stale.
 */
export function cleanupOrphanedForkFiles(): void {
  const dbSessions = getAllSessionsFromDb();
  for (const session of dbSessions) {
    if (!session.isFork || session.status === 'terminated') continue;
    if (session.forkJsonlPath) {
      try {
        unlinkSync(session.forkJsonlPath);
        logger.info({ id: session.id, path: session.forkJsonlPath }, 'Cleaned up orphaned fork JSONL');
      } catch {
        // File may not exist if crash happened before copy completed
      }
    }
    updateSession(session.id, { status: 'terminated', lastAccessedAt: new Date().toISOString() });
  }
}

/**
 * Startup reconciliation sweep for the project-log feature. Sessions that ended
 * because the machine shut down or the server crashed never ran through the
 * close triggers, so they have no logged_at stamp. After a restart no PTY is
 * alive, so every un-stamped non-fork session with a known Claude session id is
 * safe to process now. generateSessionLog applies its own skip-gate and stamps
 * each session so this never double-logs. No-op when the feature is disabled.
 */
export function sweepUnloggedSessions(): void {
  if (!getConfig().projectLog?.enabled) return;
  const sessions = getUnloggedSessionsForLog();
  if (sessions.length === 0) return;
  logger.info({ count: sessions.length }, 'project-log: startup sweep processing unlogged sessions');
  for (const s of sessions) {
    void generateSessionLog({
      sessionId: s.id,
      name: s.name,
      cwd: s.cwd,
      claudeSessionId: s.claudeSessionId,
      createdAt: s.createdAt,
    });
  }
}
