import Database from 'better-sqlite3';
import { join } from 'path';
import { getConfig } from '../config.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('database');

let db: Database.Database | null = null;

export function getDatabase(): Database.Database {
  if (!db) {
    throw new Error('Database not initialized. Call initDatabase() first.');
  }
  return db;
}

export function initDatabase(): Database.Database {
  const config = getConfig();
  const dbPath = join(config.persistence.dataDir, 'sessions.db');

  logger.info({ path: dbPath }, 'Initializing database');

  db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  runMigrations(db);

  return db;
}

export function closeDatabase(): void {
  if (db) {
    db.close();
    db = null;
    logger.info('Database closed');
  }
}

function runMigrations(database: Database.Database): void {
  // Create migrations table
  database.exec(`
    CREATE TABLE IF NOT EXISTS migrations (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      applied_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  const migrations: { name: string; sql: string }[] = [
    {
      name: '001_create_sessions',
      sql: `
        CREATE TABLE IF NOT EXISTS sessions (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          shell TEXT NOT NULL,
          cwd TEXT NOT NULL,
          created_at TEXT NOT NULL,
          last_accessed_at TEXT NOT NULL,
          owner_id TEXT,
          status TEXT NOT NULL DEFAULT 'active',
          cols INTEGER NOT NULL DEFAULT 80,
          rows INTEGER NOT NULL DEFAULT 24,
          tmux_session TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_sessions_owner ON sessions(owner_id);
        CREATE INDEX IF NOT EXISTS idx_sessions_status ON sessions(status);
      `,
    },
    {
      name: '002_create_scrollback',
      sql: `
        CREATE TABLE IF NOT EXISTS scrollback (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          session_id TEXT NOT NULL,
          content TEXT NOT NULL,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_scrollback_session ON scrollback(session_id);
      `,
    },
    {
      name: '003_create_session_logs',
      sql: `
        CREATE TABLE IF NOT EXISTS session_logs (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          session_id TEXT NOT NULL,
          event_type TEXT NOT NULL,
          details TEXT,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_session_logs_session ON session_logs(session_id);
      `,
    },
  ];

  const appliedMigrations = database
    .prepare('SELECT name FROM migrations')
    .all()
    .map((row) => (row as { name: string }).name);

  for (const migration of migrations) {
    if (!appliedMigrations.includes(migration.name)) {
      logger.info({ migration: migration.name }, 'Running migration');
      database.exec(migration.sql);
      database.prepare('INSERT INTO migrations (name) VALUES (?)').run(migration.name);
    }
  }
}
