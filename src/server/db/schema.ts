import Database from 'better-sqlite3';
import { join } from 'path';
import { getConfig } from '../config.js';
import { createLogger } from '../utils/logger.js';
import { clearStatementCache } from './queries.js';

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
    clearStatementCache();
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
    {
      name: '004_create_categories',
      sql: `
        CREATE TABLE IF NOT EXISTS categories (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          sort_order INTEGER NOT NULL DEFAULT 0,
          collapsed INTEGER NOT NULL DEFAULT 0,
          owner_id TEXT,
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE INDEX IF NOT EXISTS idx_categories_owner ON categories(owner_id);
        ALTER TABLE sessions ADD COLUMN category_id TEXT REFERENCES categories(id) ON DELETE SET NULL;
        CREATE INDEX IF NOT EXISTS idx_sessions_category ON sessions(category_id);
      `,
    },
    {
      name: '005_create_notification_preferences',
      sql: `
        CREATE TABLE IF NOT EXISTS notification_preferences (
          user_id TEXT PRIMARY KEY,
          browser_enabled INTEGER NOT NULL DEFAULT 1,
          visual_enabled INTEGER NOT NULL DEFAULT 1,
          notify_on_input INTEGER NOT NULL DEFAULT 1,
          notify_on_completed INTEGER NOT NULL DEFAULT 1,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          updated_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
      `,
    },
    {
      name: '006_add_session_sort_order',
      sql: `
        ALTER TABLE sessions ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0;
      `,
    },
    {
      name: '007_add_fork_columns',
      sql: `
        ALTER TABLE sessions ADD COLUMN claude_session_id TEXT;
        ALTER TABLE sessions ADD COLUMN is_fork INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE sessions ADD COLUMN fork_jsonl_path TEXT;
      `,
    },
    {
      name: '008_add_logged_at',
      sql: `
        ALTER TABLE sessions ADD COLUMN logged_at TEXT;
      `,
    },
    {
      // Pipeline jobs: one feature carried through design -> ... -> merge in an
      // isolated worktree, parking at gates for approval.
      name: '009_create_jobs',
      sql: `
        CREATE TABLE IF NOT EXISTS jobs (
          id TEXT PRIMARY KEY,
          project_cwd TEXT NOT NULL,
          feature_id TEXT,
          title TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'queued',
          stage TEXT,
          gate TEXT,
          park_reason TEXT,
          detail TEXT,
          worktree_path TEXT,
          branch TEXT,
          claude_session_id TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_jobs_project ON jobs(project_cwd);
        CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status);

        CREATE TABLE IF NOT EXISTS job_stages (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          job_id TEXT NOT NULL,
          name TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'pending',
          detail TEXT,
          started_at TEXT,
          finished_at TEXT,
          FOREIGN KEY (job_id) REFERENCES jobs(id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_job_stages_job ON job_stages(job_id);
      `,
    },
    {
      // Which gate the user has approved. Distinct from `gate` (the gate a job
      // is waiting AT) because the merge gate precedes its stage: without a
      // separate record, approving would clear the gate and the stage would
      // simply park again.
      name: '010_add_job_approved_gate',
      sql: `
        ALTER TABLE jobs ADD COLUMN approved_gate TEXT;
      `,
    },
    {
      // base_branch: the branch a job actually branched from, so later stages
      // compare and merge against that rather than whatever the project happens
      // to have checked out now.
      // pending_answer: the user's answer to a parked question. In memory it was
      // lost on restart, silently re-asking the same question.
      name: '011_add_job_base_branch_and_answer',
      sql: `
        ALTER TABLE jobs ADD COLUMN base_branch TEXT;
        ALTER TABLE jobs ADD COLUMN pending_answer TEXT;
      `,
    },
    {
      // What each stage's agent runs consumed, accumulated per run. Token
      // counts stay split because a single total is dominated by cache reads.
      // run_count distinguishes "this stage ran nothing" from "it ran and
      // reported zeros" — which matters for jobs that predate this migration:
      // their zeros are unknown, not free.
      name: '012_add_stage_token_usage',
      sql: `
        ALTER TABLE job_stages ADD COLUMN input_tokens INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE job_stages ADD COLUMN output_tokens INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE job_stages ADD COLUMN cache_read_tokens INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE job_stages ADD COLUMN cache_creation_tokens INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE job_stages ADD COLUMN cost_usd REAL NOT NULL DEFAULT 0;
        ALTER TABLE job_stages ADD COLUMN run_count INTEGER NOT NULL DEFAULT 0;
      `,
    },
    {
      // When the stage's agent process actually started, as opposed to when the
      // stage was admitted (started_at). A stage waits in its project's run
      // queue first, and reporting that wait as execution is what made a job
      // behind another one look hung.
      //
      // Added rather than redefining started_at: every existing row would
      // otherwise claim it never ran, and the elapsed time a user reads on the
      // board would jump for jobs that are already finished.
      name: '013_add_stage_spawned_at',
      sql: `
        ALTER TABLE job_stages ADD COLUMN spawned_at TEXT;
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
