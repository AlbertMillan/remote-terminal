import { findTranscript } from '../accounts.js';

/** The fields of a session row that decide whether it can be revived. */
export interface RevivableRow {
  status: string;
  isFork?: boolean | null;
  claudeSessionId?: string | null;
  cwd: string;
  account?: string | null;
}

/**
 * Why a session row cannot be revived, or null when it can. The one rule for both
 * `reviveSession()` (which throws this reason) and the sidebar's play button (which shows
 * when it is null), so the two can never disagree about which rows come back.
 *
 * `running` is true when a PTY for the row is alive in memory (in memory, not `terminated`).
 *
 * - Forks are refused: `cleanupOrphanedForkFiles()` unlinks their transcript at boot.
 * - A stale row (its PTY died with the server, status not `terminated`) is always revivable:
 *   with a conversation it resumes, without one it respawns the shell in its cwd.
 * - A `terminated` row is revivable only with a conversation whose transcript still exists.
 *   `terminated` means the shell exited while the server ran, which a Windows reboot causes
 *   too (docs/session-revive.md), so it is no proof the conversation was closed on purpose.
 *   Its transcript is checked because terminated rows linger for months and Claude Code
 *   deletes transcripts after `cleanupPeriodDays`; resuming a missing one leaves a shell
 *   with a failed `claude --resume` in it, holding a session slot.
 */
export function reviveRefusal(row: RevivableRow, running: boolean): string | null {
  if (running) return 'Session is already running';
  if (row.isFork) return 'Forked sessions cannot be revived; their transcript is removed on restart';
  if (row.status !== 'terminated') return null;
  if (!row.claudeSessionId) return 'Session has been terminated and has no conversation to resume';
  if (!findTranscript(row.cwd, row.claudeSessionId, row.account)) {
    return 'Session has been terminated and its conversation transcript no longer exists';
  }
  return null;
}
