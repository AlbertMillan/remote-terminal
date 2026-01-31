import type Database from 'better-sqlite3';
import { getDatabase } from './schema.js';
import type { SessionMetadata, SessionStatus } from '../sessions/types.js';

// Prepared statement cache for performance
const stmtCache = new Map<string, Database.Statement>();

function getStatement(key: string, sql: string): Database.Statement {
  if (!stmtCache.has(key)) {
    stmtCache.set(key, getDatabase().prepare(sql));
  }
  return stmtCache.get(key)!;
}

// Clear cache when database is closed (call from schema.ts closeDatabase)
export function clearStatementCache(): void {
  stmtCache.clear();
}

export function insertSession(session: SessionMetadata): void {
  const stmt = getStatement('insertSession', `
    INSERT INTO sessions (id, name, shell, cwd, created_at, last_accessed_at, owner_id, status, cols, rows, tmux_session)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  stmt.run(
    session.id,
    session.name,
    session.shell,
    session.cwd,
    session.createdAt,
    session.lastAccessedAt,
    session.ownerId,
    session.status,
    session.cols,
    session.rows,
    session.tmuxSession
  );
}

export function updateSession(
  id: string,
  updates: Partial<Pick<SessionMetadata, 'name' | 'lastAccessedAt' | 'status' | 'cols' | 'rows'>>
): void {
  const fields: string[] = [];
  const values: unknown[] = [];

  if (updates.name !== undefined) {
    fields.push('name = ?');
    values.push(updates.name);
  }
  if (updates.lastAccessedAt !== undefined) {
    fields.push('last_accessed_at = ?');
    values.push(updates.lastAccessedAt);
  }
  if (updates.status !== undefined) {
    fields.push('status = ?');
    values.push(updates.status);
  }
  if (updates.cols !== undefined) {
    fields.push('cols = ?');
    values.push(updates.cols);
  }
  if (updates.rows !== undefined) {
    fields.push('rows = ?');
    values.push(updates.rows);
  }

  if (fields.length === 0) return;

  values.push(id);
  // Dynamic queries can't be cached, but updateSession is debounced so this is acceptable
  const stmt = getDatabase().prepare(`UPDATE sessions SET ${fields.join(', ')} WHERE id = ?`);
  stmt.run(...values);
}

export function getSession(id: string): SessionMetadata | null {
  const stmt = getStatement('getSession', `
    SELECT id, name, shell, cwd, created_at as createdAt, last_accessed_at as lastAccessedAt,
           owner_id as ownerId, status, cols, rows, tmux_session as tmuxSession
    FROM sessions WHERE id = ?
  `);
  const row = stmt.get(id) as SessionMetadata | undefined;
  return row || null;
}

export function getAllSessions(ownerId?: string): SessionMetadata[] {
  if (ownerId) {
    const stmt = getStatement('getAllSessionsByOwner', `
      SELECT id, name, shell, cwd, created_at as createdAt, last_accessed_at as lastAccessedAt,
             owner_id as ownerId, status, cols, rows, tmux_session as tmuxSession
      FROM sessions WHERE owner_id = ? OR owner_id IS NULL
      ORDER BY last_accessed_at DESC
    `);
    return stmt.all(ownerId) as SessionMetadata[];
  } else {
    const stmt = getStatement('getAllSessions', `
      SELECT id, name, shell, cwd, created_at as createdAt, last_accessed_at as lastAccessedAt,
             owner_id as ownerId, status, cols, rows, tmux_session as tmuxSession
      FROM sessions
      ORDER BY last_accessed_at DESC
    `);
    return stmt.all() as SessionMetadata[];
  }
}

export function getActiveSessions(): SessionMetadata[] {
  const stmt = getStatement('getActiveSessions', `
    SELECT id, name, shell, cwd, created_at as createdAt, last_accessed_at as lastAccessedAt,
           owner_id as ownerId, status, cols, rows, tmux_session as tmuxSession
    FROM sessions WHERE status != 'terminated'
    ORDER BY last_accessed_at DESC
  `);
  return stmt.all() as SessionMetadata[];
}

export function deleteSession(id: string): void {
  const stmt = getStatement('deleteSession', 'DELETE FROM sessions WHERE id = ?');
  stmt.run(id);
}

export function saveScrollback(sessionId: string, content: string): void {
  const deleteStmt = getStatement('deleteScrollback', 'DELETE FROM scrollback WHERE session_id = ?');
  const insertStmt = getStatement('insertScrollback', 'INSERT INTO scrollback (session_id, content) VALUES (?, ?)');
  deleteStmt.run(sessionId);
  insertStmt.run(sessionId, content);
}

export function getScrollback(sessionId: string): string | null {
  const stmt = getStatement('getScrollback', 'SELECT content FROM scrollback WHERE session_id = ? ORDER BY id DESC LIMIT 1');
  const row = stmt.get(sessionId) as { content: string } | undefined;
  return row?.content || null;
}

export function logSessionEvent(sessionId: string, eventType: string, details?: string): void {
  const stmt = getStatement('logSessionEvent', 'INSERT INTO session_logs (session_id, event_type, details) VALUES (?, ?, ?)');
  stmt.run(sessionId, eventType, details || null);
}

export function getSessionLogs(sessionId: string, limit = 100): { eventType: string; details: string | null; createdAt: string }[] {
  const stmt = getStatement('getSessionLogs', `
    SELECT event_type as eventType, details, created_at as createdAt
    FROM session_logs WHERE session_id = ?
    ORDER BY created_at DESC LIMIT ?
  `);
  return stmt.all(sessionId, limit) as { eventType: string; details: string | null; createdAt: string }[];
}

export function countActiveSessions(): number {
  const stmt = getStatement('countActiveSessions', "SELECT COUNT(*) as count FROM sessions WHERE status != 'terminated'");
  const row = stmt.get() as { count: number };
  return row.count;
}
