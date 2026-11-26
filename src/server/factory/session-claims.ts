import { getDatabase } from '../db/schema.js';
import { pathKey } from '../utils/paths.js';
import { factoryEvents } from './events.js';

/**
 * Terminal sessions holding factory units (project/code-factory.md, "Sessions
 * and the factory share one model of work (phase 2)").
 *
 * A session's claim lives on the items (store.ts, `claim_kind = 'session'`,
 * owner `session:<id>`), with no lease: liveness is the open terminal, never a
 * heartbeat. A session that closes keeps its claim, and the unit shows as
 * paused and claimed by you until Return to factory or Done. Nothing here
 * releases a claim on its own.
 *
 * Each claim also leaves a RECORD (`factory_session_claims`, migration 028):
 * the session, the worktree, the commits it spans and the Claude transcripts
 * it ran. That is what makes a claimed session's work job-like
 * (docs/change-provenance.md): attribution reads the record instead of
 * guessing from transcripts.
 */

const OWNER_PREFIX = 'session:';

export function sessionOwner(sessionId: string): string {
  return `${OWNER_PREFIX}${sessionId}`;
}

/** The claude-remote session id behind a session claim's owner, or null for any other owner. */
export function sessionOfOwner(owner: string | null | undefined): string | null {
  return owner && owner.startsWith(OWNER_PREFIX) ? owner.slice(OWNER_PREFIX.length) : null;
}

// ---------------------------------------------------------------------------
// Liveness, from the session manager. A seam so the factory's data layer and
// its tests never import PTYs: boot wires the real one (installSessionLiveness).

export interface SessionLiveness {
  /** Its shell is running (a PTY that has not exited). */
  isRunning(sessionId: string): boolean;
  /** Its display name, or null when the row is gone. */
  nameOf(sessionId: string): string | null;
}

let liveness: SessionLiveness = { isRunning: () => false, nameOf: () => null };

export function setSessionLiveness(source: SessionLiveness): void {
  liveness = source;
}

export function sessionLiveness(): SessionLiveness {
  return liveness;
}

/**
 * Wire the session manager in: liveness reads, and a feed push whenever a
 * session holding a claim starts, stops or exits, so its unit turns "paused,
 * claimed by you" (or live again on a revive) without waiting for another
 * factory write.
 */
export function installSessionLiveness(
  source: SessionLiveness,
  onLiveChange: (listener: (sessionId: string) => void) => () => void
): () => void {
  setSessionLiveness(source);
  return onLiveChange((sessionId) => {
    if (holdsClaim(sessionId)) factoryEvents.emitChange();
  });
}

function holdsClaim(sessionId: string): boolean {
  return !!getDatabase()
    .prepare(`SELECT 1 FROM factory_items WHERE claim_owner = ? AND claim_kind = 'session' LIMIT 1`)
    .get(sessionOwner(sessionId));
}

// ---------------------------------------------------------------------------
// Records

export type ClaimEnd = 'returned' | 'done';

export interface SessionClaimRecord {
  id: number;
  projectCwd: string;
  unitId: string;
  trackName: string;
  featureIds: string[];
  sessionId: string;
  /** Claude transcripts the session ran while it held the unit. */
  transcriptIds: string[];
  worktreePath: string | null;
  /** HEAD when the claim began: the session's commits are base..end. */
  baseCommit: string | null;
  endCommit: string | null;
  claimedAt: string;
  releasedAt: string | null;
  endedBy: ClaimEnd | null;
}

interface Row {
  id: number;
  project_cwd: string;
  unit_id: string;
  track_name: string;
  feature_ids: string;
  session_id: string;
  transcript_ids: string;
  worktree_path: string | null;
  base_commit: string | null;
  end_commit: string | null;
  claimed_at: string;
  released_at: string | null;
  ended_by: string | null;
}

function list(json: string): string[] {
  try {
    const parsed = JSON.parse(json);
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

function toRecord(row: Row): SessionClaimRecord {
  return {
    id: row.id,
    projectCwd: row.project_cwd,
    unitId: row.unit_id,
    trackName: row.track_name,
    featureIds: list(row.feature_ids),
    sessionId: row.session_id,
    transcriptIds: list(row.transcript_ids),
    worktreePath: row.worktree_path,
    baseCommit: row.base_commit,
    endCommit: row.end_commit,
    claimedAt: row.claimed_at,
    releasedAt: row.released_at,
    endedBy: row.ended_by === 'returned' || row.ended_by === 'done' ? row.ended_by : null,
  };
}

export interface StartClaimInput {
  projectCwd: string;
  unitId: string;
  trackName: string;
  featureIds: string[];
  sessionId: string;
  worktreePath: string | null;
  baseCommit: string | null;
  /** The transcript the session resumes, when it resumes one. */
  transcriptId?: string | null;
}

/** Record a claim's start. Returns the record. */
export function recordClaimStart(input: StartClaimInput, now = Date.now()): SessionClaimRecord {
  const info = getDatabase()
    .prepare(
      `INSERT INTO factory_session_claims
         (project_key, project_cwd, unit_id, track_name, feature_ids, session_id, transcript_ids,
          worktree_path, base_commit, claimed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      pathKey(input.projectCwd),
      input.projectCwd,
      input.unitId,
      input.trackName,
      JSON.stringify(input.featureIds),
      input.sessionId,
      JSON.stringify(input.transcriptId ? [input.transcriptId] : []),
      input.worktreePath,
      input.baseCommit,
      new Date(now).toISOString()
    );
  return getClaimRecord(Number(info.lastInsertRowid)) as SessionClaimRecord;
}

export function getClaimRecord(id: number): SessionClaimRecord | null {
  const row = getDatabase().prepare('SELECT * FROM factory_session_claims WHERE id = ?').get(id) as Row | undefined;
  return row ? toRecord(row) : null;
}

/** The open record of a session's claim on a unit, if any. */
export function openClaimRecord(projectCwd: string, unitId: string, sessionId: string): SessionClaimRecord | null {
  const row = getDatabase()
    .prepare(
      `SELECT * FROM factory_session_claims
        WHERE project_key = ? AND unit_id = ? AND session_id = ? AND released_at IS NULL
        ORDER BY id DESC LIMIT 1`
    )
    .get(pathKey(projectCwd), unitId, sessionId) as Row | undefined;
  return row ? toRecord(row) : null;
}

/** Add a transcript the session ran (a resume changes the session row's id; the record keeps every one). */
export function addClaimTranscript(id: number, transcriptId: string | null | undefined): void {
  if (!transcriptId) return;
  const record = getClaimRecord(id);
  if (!record || record.transcriptIds.includes(transcriptId)) return;
  getDatabase()
    .prepare('UPDATE factory_session_claims SET transcript_ids = ? WHERE id = ?')
    .run(JSON.stringify([...record.transcriptIds, transcriptId]), id);
}

export function recordClaimEnd(
  id: number,
  end: { endCommit: string | null; endedBy: ClaimEnd; transcriptId?: string | null },
  now = Date.now()
): void {
  addClaimTranscript(id, end.transcriptId);
  getDatabase()
    .prepare('UPDATE factory_session_claims SET end_commit = ?, ended_by = ?, released_at = ? WHERE id = ?')
    .run(end.endCommit, end.endedBy, new Date(now).toISOString(), id);
}

/** Every claim record of a project, oldest first. */
export function listClaimRecords(projectCwd: string): SessionClaimRecord[] {
  const rows = getDatabase()
    .prepare('SELECT * FROM factory_session_claims WHERE project_key = ? ORDER BY id')
    .all(pathKey(projectCwd)) as Row[];
  return rows.map(toRecord);
}
