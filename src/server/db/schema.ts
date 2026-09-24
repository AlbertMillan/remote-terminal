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
    {
      // A track's own branch and worktree, so everything implemented for the
      // track — by an interactive session or by jobs — can be told apart and
      // later landed or deleted as one unit. See docs/track-branches.md.
      //
      // Unique only among rows not yet landed: a landed row is kept for its
      // merge_sha (deleting the track later reverts it), and re-opening the
      // same track after a land starts a new row.
      //
      // jobs.merge_sha: the commit the merge stage created. The message alone
      // ("Merge job: <title>") is shared by any two jobs with the same title.
      name: '014_track_branches',
      sql: `
        CREATE TABLE IF NOT EXISTS track_branches (
          id TEXT PRIMARY KEY,
          project_cwd TEXT NOT NULL,
          project_key TEXT NOT NULL,
          track_name TEXT NOT NULL,
          branch TEXT NOT NULL,
          worktree_path TEXT NOT NULL,
          base_branch TEXT NOT NULL,
          created_at TEXT NOT NULL,
          landed_at TEXT,
          merge_sha TEXT
        );
        CREATE UNIQUE INDEX IF NOT EXISTS idx_track_branches_active
          ON track_branches(project_key, track_name) WHERE landed_at IS NULL;
        CREATE INDEX IF NOT EXISTS idx_track_branches_project
          ON track_branches(project_key);
        ALTER TABLE jobs ADD COLUMN merge_sha TEXT;
      `,
    },
    {
      // The usage ledger: one row per API response read from Claude Code's own
      // transcripts, deduped by message id. It replaces 012's stage counters,
      // which only ever saw a run's final envelope — so a killed run recorded
      // nothing, a resumed run re-added the whole session, and Discard deleted
      // the history. See docs/token-usage-feature.md.
      //
      // agent_runs: every headless run, written BEFORE it spawns, so its
      // transcript is attributed to a job/stage/kind even if it is killed a
      // second later. A session can hold several runs (--resume keeps the id),
      // so a message belongs to the run whose [started_at, ended_at] holds it.
      //
      // None of these rows is deleted by Discard, Delete track or history
      // Delete: spend outlives the job that incurred it.
      name: '015_usage_ledger',
      sql: `
        CREATE TABLE IF NOT EXISTS usage_messages (
          message_id TEXT PRIMARY KEY,
          session_id TEXT NOT NULL,
          project_cwd TEXT NOT NULL,
          job_id TEXT,
          track_id TEXT,
          model TEXT NOT NULL,
          speed TEXT,
          ts TEXT NOT NULL,
          input_tokens INTEGER NOT NULL DEFAULT 0,
          output_tokens INTEGER NOT NULL DEFAULT 0,
          cache_read_tokens INTEGER NOT NULL DEFAULT 0,
          cache_write_5m_tokens INTEGER NOT NULL DEFAULT 0,
          cache_write_1h_tokens INTEGER NOT NULL DEFAULT 0
        );
        CREATE INDEX IF NOT EXISTS idx_usage_messages_project ON usage_messages(project_cwd, ts);
        CREATE INDEX IF NOT EXISTS idx_usage_messages_session ON usage_messages(session_id);
        CREATE INDEX IF NOT EXISTS idx_usage_messages_job ON usage_messages(job_id);

        CREATE TABLE IF NOT EXISTS usage_files (
          path TEXT PRIMARY KEY,
          size INTEGER NOT NULL,
          mtime_ms REAL NOT NULL,
          offset INTEGER NOT NULL,
          cwd TEXT,
          session_id TEXT NOT NULL,
          parent_session_id TEXT,
          project_cwd TEXT,
          job_id TEXT,
          track_id TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_usage_files_session ON usage_files(session_id);

        CREATE TABLE IF NOT EXISTS agent_runs (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          session_id TEXT NOT NULL,
          project_cwd TEXT NOT NULL,
          kind TEXT NOT NULL,
          job_id TEXT,
          stage TEXT,
          started_at TEXT NOT NULL,
          ended_at TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_agent_runs_session ON agent_runs(session_id, started_at);
        CREATE INDEX IF NOT EXISTS idx_agent_runs_job ON agent_runs(job_id);

        ALTER TABLE job_stages DROP COLUMN input_tokens;
        ALTER TABLE job_stages DROP COLUMN output_tokens;
        ALTER TABLE job_stages DROP COLUMN cache_read_tokens;
        ALTER TABLE job_stages DROP COLUMN cache_creation_tokens;
        ALTER TABLE job_stages DROP COLUMN cost_usd;
        ALTER TABLE job_stages DROP COLUMN run_count;
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
      // One transaction per migration, its record included. A multi-statement
      // migration that failed half-way would otherwise stay unrecorded with
      // half its statements applied, and the next boot would re-run the rest
      // against a schema it no longer matches (e.g. DROP COLUMN on a column
      // already gone) and refuse to start.
      database.transaction(() => {
        database.exec(migration.sql);
        database.prepare('INSERT INTO migrations (name) VALUES (?)').run(migration.name);
      })();
    }
  }
}
