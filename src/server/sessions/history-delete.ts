import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { join, resolve } from 'path';
import { getConfig } from '../config.js';
import { createLogger } from '../utils/logger.js';
import { getSession } from '../db/queries.js';
import { sessionManager } from './manager.js';
import { findProjectByCwd, invalidateProjectCache } from './project-discovery.js';
import { parseLogEntries, removeLogEntry } from './session-log-format.js';
import { tryGetTranscriptPath } from './transcript.js';

const logger = createLogger('history-delete');

// Only ever unlink a file whose name is a plain UUID. Session ids come out of a
// marker comment in a user-editable markdown file, so treat them as untrusted
// input and refuse anything that could traverse out of the transcripts dir.
const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/** Sentinel session ids the generator writes when it has no real id. */
function isRealSessionId(sid: string | null | undefined): sid is string {
  return !!sid && sid !== 'backfill' && sid !== 'unknown';
}

export class HistoryDeleteError extends Error {
  constructor(
    message: string,
    readonly status: number
  ) {
    super(message);
    this.name = 'HistoryDeleteError';
  }
}

export type TranscriptKeptReason =
  | 'no-session-id' // entry carries a backfill/unknown/malformed marker
  | 'still-referenced' // other surviving log entries point at the same transcript
  | 'session-live' // a running claude-remote session is using it right now
  | 'not-found' // already gone from ~/.claude/projects
  | 'unsafe-id' // marker session id isn't a plain UUID — refuse to unlink
  | 'failed'; // unlink threw (permissions, file lock)

export interface DeleteHistoryEntryOptions {
  cwd: string;
  entryIndex: number;
  /** Session id the client believes sits at entryIndex; verified before writing. */
  expectedClaudeSessionId?: string | null;
  /** 'entry' removes just that entry; 'conversation' removes every entry sharing its session id. */
  scope?: 'entry' | 'conversation';
}

export interface DeleteHistoryEntryResult {
  cwd: string;
  removedEntries: number;
  remainingEntries: number;
  transcriptDeleted: boolean;
  transcriptPath: string | null;
  transcriptKeptReason: TranscriptKeptReason | null;
}

/** True if any live session is currently driving this Claude session id. */
function isSessionLive(claudeSessionId: string): boolean {
  return sessionManager
    .getAllSessions()
    .some((s) => getSession(s.id)?.claudeSessionId === claudeSessionId);
}

/**
 * Delete one session-history entry (or every entry for one conversation) from a
 * project's SESSION-LOG.md, and unlink the backing Claude transcript once no
 * surviving entry references it.
 *
 * The log is re-read and re-parsed here rather than trusting the client's view of
 * it: the dashboard polls a snapshot, and the log generator may have prepended a
 * new entry since, which would shift every index. A mismatch between the index
 * and the session id the client expected there is reported as a 409 so the UI can
 * refresh instead of deleting the wrong entry.
 */
export function deleteHistoryEntry(options: DeleteHistoryEntryOptions): DeleteHistoryEntryResult {
  const { cwd, entryIndex, expectedClaudeSessionId, scope = 'entry' } = options;

  // Only operate inside a directory discovery actually knows about — never an
  // arbitrary path from the request body.
  const project = findProjectByCwd(cwd);
  if (!project) throw new HistoryDeleteError('Unknown project', 404);

  const fileName = getConfig().projectLog.fileName;
  const logPath = join(project.cwd, fileName);
  let markdown: string;
  try {
    markdown = readFileSync(logPath, 'utf-8');
  } catch {
    throw new HistoryDeleteError(`No ${fileName} in this project`, 404);
  }

  const entries = parseLogEntries(markdown);
  if (!Number.isInteger(entryIndex) || entryIndex < 0 || entryIndex >= entries.length) {
    throw new HistoryDeleteError('Entry no longer exists — refresh and try again', 409);
  }
  const sid = entries[entryIndex].meta?.claudeSessionId ?? null;
  if (expectedClaudeSessionId !== undefined && (expectedClaudeSessionId || null) !== sid) {
    throw new HistoryDeleteError('Session history changed — refresh and try again', 409);
  }

  // Which entries go: just this one, or every entry for the same conversation.
  const targets =
    scope === 'conversation' && isRealSessionId(sid)
      ? entries.map((e, i) => (e.meta?.claudeSessionId === sid ? i : -1)).filter((i) => i >= 0)
      : [entryIndex];

  // Remove highest index first so earlier marker offsets stay valid.
  let next = markdown;
  for (const i of [...targets].sort((a, b) => b - a)) {
    const rewritten = removeLogEntry(next, i);
    if (rewritten === null) throw new HistoryDeleteError('Entry no longer exists — refresh and try again', 409);
    next = rewritten;
  }
  writeFileSync(logPath, next, 'utf-8');

  const remaining = parseLogEntries(next);
  const result: DeleteHistoryEntryResult = {
    cwd: project.cwd,
    removedEntries: targets.length,
    remainingEntries: remaining.length,
    transcriptDeleted: false,
    transcriptPath: null,
    transcriptKeptReason: null,
  };

  // The transcript is shared: several entries can carry the same session id (one
  // per close of the same conversation). Only unlink it once nothing points at it.
  if (!isRealSessionId(sid)) {
    result.transcriptKeptReason = 'no-session-id';
  } else if (remaining.some((e) => e.meta?.claudeSessionId === sid)) {
    result.transcriptKeptReason = 'still-referenced';
  } else if (isSessionLive(sid)) {
    result.transcriptKeptReason = 'session-live';
  } else if (!UUID_RE.test(sid)) {
    result.transcriptKeptReason = 'unsafe-id';
    logger.warn({ cwd: project.cwd, sid }, 'history-delete: refusing to unlink non-UUID session id');
  } else {
    const path = tryGetTranscriptPath(homedir(), project.cwd, sid);
    const transcriptsRoot = resolve(join(homedir(), '.claude', 'projects'));
    if (!path || !existsSync(path)) {
      result.transcriptKeptReason = 'not-found';
    } else if (!resolve(path).startsWith(transcriptsRoot)) {
      result.transcriptKeptReason = 'unsafe-id';
    } else {
      result.transcriptPath = path;
      try {
        unlinkSync(path);
        result.transcriptDeleted = true;
      } catch (error) {
        result.transcriptKeptReason = 'failed';
        logger.warn({ path, error }, 'history-delete: failed to unlink transcript');
      }
    }
  }

  // Transcript counts / lastActivity just changed — don't serve them from cache.
  invalidateProjectCache();
  logger.info(
    {
      cwd: project.cwd,
      sid,
      scope,
      removedEntries: result.removedEntries,
      transcriptDeleted: result.transcriptDeleted,
      transcriptKeptReason: result.transcriptKeptReason,
    },
    'history-delete: entry removed'
  );
  return result;
}
