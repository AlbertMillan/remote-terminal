import type Database from 'better-sqlite3';
import { getDatabase } from './schema.js';
import type { SessionMetadata, CategoryMetadata } from '../sessions/types.js';

// Prepared statement cache for performance
const stmtCache = new Map<string, Database.Statement>();

function getStatement(key: string, sql: string): Database.Statement {
  if (!stmtCache.has(key)) {
    stmtCache.set(key, getDatabase().prepare(sql));
  }
  return stmtCache.get(key)!;
}

/**
 * Execute a cached statement with automatic cache invalidation on error.
 * Clears the specific cache entry if the statement fails (e.g., schema changed).
 */
function executeStatement<T>(
  key: string,
  sql: string,
  executor: (stmt: Database.Statement) => T
): T {
  try {
    const stmt = getStatement(key, sql);
    return executor(stmt);
  } catch (error) {
    // Clear this specific cache entry on error - statement may be stale
    stmtCache.delete(key);
    throw error;
  }
}

// Clear cache when database is closed (call from schema.ts closeDatabase)
export function clearStatementCache(): void {
  stmtCache.clear();
}

export function insertSession(session: SessionMetadata): void {
  executeStatement('insertSession', `
    INSERT INTO sessions (id, name, shell, cwd, created_at, last_accessed_at, owner_id, status, cols, rows, tmux_session, category_id, sort_order)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `, (stmt) => stmt.run(
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
    session.tmuxSession,
    session.categoryId,
    session.sortOrder
  ));
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
  return executeStatement('getSession', `
    SELECT id, name, shell, cwd, created_at as createdAt, last_accessed_at as lastAccessedAt,
           owner_id as ownerId, status, cols, rows, tmux_session as tmuxSession, category_id as categoryId,
           sort_order as sortOrder
    FROM sessions WHERE id = ?
  `, (stmt) => {
    const row = stmt.get(id) as SessionMetadata | undefined;
    return row || null;
  });
}

export function getAllSessions(ownerId?: string): SessionMetadata[] {
  if (ownerId) {
    const stmt = getStatement('getAllSessionsByOwner', `
      SELECT id, name, shell, cwd, created_at as createdAt, last_accessed_at as lastAccessedAt,
             owner_id as ownerId, status, cols, rows, tmux_session as tmuxSession, category_id as categoryId,
             sort_order as sortOrder
      FROM sessions WHERE owner_id = ? OR owner_id IS NULL
      ORDER BY sort_order ASC
    `);
    return stmt.all(ownerId) as SessionMetadata[];
  } else {
    const stmt = getStatement('getAllSessions', `
      SELECT id, name, shell, cwd, created_at as createdAt, last_accessed_at as lastAccessedAt,
             owner_id as ownerId, status, cols, rows, tmux_session as tmuxSession, category_id as categoryId,
             sort_order as sortOrder
      FROM sessions
      ORDER BY sort_order ASC
    `);
    return stmt.all() as SessionMetadata[];
  }
}

export function getActiveSessions(): SessionMetadata[] {
  const stmt = getStatement('getActiveSessions', `
    SELECT id, name, shell, cwd, created_at as createdAt, last_accessed_at as lastAccessedAt,
           owner_id as ownerId, status, cols, rows, tmux_session as tmuxSession, category_id as categoryId,
           sort_order as sortOrder
    FROM sessions WHERE status != 'terminated'
    ORDER BY sort_order ASC
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
  return executeStatement('countActiveSessions',
    "SELECT COUNT(*) as count FROM sessions WHERE status != 'terminated'",
    (stmt) => {
      const row = stmt.get() as { count: number };
      return row.count;
    }
  );
}

// Category CRUD functions

export function insertCategory(category: CategoryMetadata): void {
  const stmt = getStatement('insertCategory', `
    INSERT INTO categories (id, name, sort_order, collapsed, owner_id, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  stmt.run(
    category.id,
    category.name,
    category.sortOrder,
    category.collapsed ? 1 : 0,
    category.ownerId,
    category.createdAt
  );
}

export function updateCategory(
  id: string,
  updates: Partial<Pick<CategoryMetadata, 'name' | 'sortOrder' | 'collapsed'>>
): void {
  const fields: string[] = [];
  const values: unknown[] = [];

  if (updates.name !== undefined) {
    fields.push('name = ?');
    values.push(updates.name);
  }
  if (updates.sortOrder !== undefined) {
    fields.push('sort_order = ?');
    values.push(updates.sortOrder);
  }
  if (updates.collapsed !== undefined) {
    fields.push('collapsed = ?');
    values.push(updates.collapsed ? 1 : 0);
  }

  if (fields.length === 0) return;

  values.push(id);
  const stmt = getDatabase().prepare(`UPDATE categories SET ${fields.join(', ')} WHERE id = ?`);
  stmt.run(...values);
}

export function deleteCategory(id: string): void {
  const stmt = getStatement('deleteCategory', 'DELETE FROM categories WHERE id = ?');
  stmt.run(id);
}

export function getCategory(id: string): CategoryMetadata | null {
  const stmt = getStatement('getCategory', `
    SELECT id, name, sort_order as sortOrder, collapsed, owner_id as ownerId, created_at as createdAt
    FROM categories WHERE id = ?
  `);
  const row = stmt.get(id) as { id: string; name: string; sortOrder: number; collapsed: number; ownerId: string | null; createdAt: string } | undefined;
  if (!row) return null;
  return { ...row, collapsed: row.collapsed === 1 };
}

export function getAllCategories(ownerId?: string): CategoryMetadata[] {
  if (ownerId) {
    const stmt = getStatement('getAllCategoriesByOwner', `
      SELECT id, name, sort_order as sortOrder, collapsed, owner_id as ownerId, created_at as createdAt
      FROM categories WHERE owner_id = ? OR owner_id IS NULL
      ORDER BY sort_order ASC
    `);
    const rows = stmt.all(ownerId) as { id: string; name: string; sortOrder: number; collapsed: number; ownerId: string | null; createdAt: string }[];
    return rows.map(row => ({ ...row, collapsed: row.collapsed === 1 }));
  } else {
    const stmt = getStatement('getAllCategories', `
      SELECT id, name, sort_order as sortOrder, collapsed, owner_id as ownerId, created_at as createdAt
      FROM categories
      ORDER BY sort_order ASC
    `);
    const rows = stmt.all() as { id: string; name: string; sortOrder: number; collapsed: number; ownerId: string | null; createdAt: string }[];
    return rows.map(row => ({ ...row, collapsed: row.collapsed === 1 }));
  }
}

export function updateSessionCategory(sessionId: string, categoryId: string | null): void {
  const newSortOrder = getMaxSessionSortOrder(categoryId) + 1;
  executeStatement('updateSessionCategory',
    'UPDATE sessions SET category_id = ?, sort_order = ? WHERE id = ?',
    (stmt) => stmt.run(categoryId, newSortOrder, sessionId)
  );
}

export function getMaxSessionSortOrder(categoryId: string | null): number {
  if (categoryId) {
    return executeStatement('getMaxSessionSortOrderCat',
      'SELECT MAX(sort_order) as maxOrder FROM sessions WHERE category_id = ?',
      (stmt) => (stmt.get(categoryId) as { maxOrder: number | null })?.maxOrder ?? -1
    );
  }
  return executeStatement('getMaxSessionSortOrderNull',
    'SELECT MAX(sort_order) as maxOrder FROM sessions WHERE category_id IS NULL',
    (stmt) => (stmt.get() as { maxOrder: number | null })?.maxOrder ?? -1
  );
}

export function reorderSessions(sessions: { id: string; sortOrder: number }[]): void {
  const stmt = getStatement('reorderSession', 'UPDATE sessions SET sort_order = ? WHERE id = ?');
  const db = getDatabase();
  const transaction = db.transaction(() => {
    for (const s of sessions) {
      stmt.run(s.sortOrder, s.id);
    }
  });
  transaction();
}

export function reorderCategories(categories: { id: string; sortOrder: number }[]): void {
  const stmt = getStatement('reorderCategory', 'UPDATE categories SET sort_order = ? WHERE id = ?');
  const db = getDatabase();
  const transaction = db.transaction(() => {
    for (const cat of categories) {
      stmt.run(cat.sortOrder, cat.id);
    }
  });
  transaction();
}

// Notification preferences

export interface NotificationPreferences {
  userId: string;
  browserEnabled: boolean;
  visualEnabled: boolean;
  notifyOnInput: boolean;
  notifyOnCompleted: boolean;
}

export function getNotificationPreferences(userId: string): NotificationPreferences {
  const stmt = getStatement('getNotificationPreferences', `
    SELECT user_id as userId, browser_enabled as browserEnabled, visual_enabled as visualEnabled,
           notify_on_input as notifyOnInput, notify_on_completed as notifyOnCompleted
    FROM notification_preferences WHERE user_id = ?
  `);
  const row = stmt.get(userId) as {
    userId: string;
    browserEnabled: number;
    visualEnabled: number;
    notifyOnInput: number;
    notifyOnCompleted: number;
  } | undefined;

  if (!row) {
    // Return defaults
    return {
      userId,
      browserEnabled: true,
      visualEnabled: true,
      notifyOnInput: true,
      notifyOnCompleted: true,
    };
  }

  return {
    userId: row.userId,
    browserEnabled: row.browserEnabled === 1,
    visualEnabled: row.visualEnabled === 1,
    notifyOnInput: row.notifyOnInput === 1,
    notifyOnCompleted: row.notifyOnCompleted === 1,
  };
}

export function setNotificationPreferences(prefs: NotificationPreferences): void {
  const stmt = getStatement('setNotificationPreferences', `
    INSERT INTO notification_preferences (user_id, browser_enabled, visual_enabled, notify_on_input, notify_on_completed, updated_at)
    VALUES (?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(user_id) DO UPDATE SET
      browser_enabled = excluded.browser_enabled,
      visual_enabled = excluded.visual_enabled,
      notify_on_input = excluded.notify_on_input,
      notify_on_completed = excluded.notify_on_completed,
      updated_at = datetime('now')
  `);
  stmt.run(
    prefs.userId,
    prefs.browserEnabled ? 1 : 0,
    prefs.visualEnabled ? 1 : 0,
    prefs.notifyOnInput ? 1 : 0,
    prefs.notifyOnCompleted ? 1 : 0
  );
}
