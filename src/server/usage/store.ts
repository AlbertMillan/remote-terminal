import { getDatabase } from '../db/schema.js';
import { createLogger } from '../utils/logger.js';
import { pathKey } from '../sessions/project-discovery.js';
import { priceTokens } from './prices.js';
import { addUsage, ZERO_USAGE, type Usage } from './types.js';

export type { Usage } from './types.js';

const logger = createLogger('usage-store');

/**
 * What a headless run is for. Every `runClaude` caller tags its run so the
 * transcript it writes can be attributed without guessing.
 */
export type RunKind = 'stage' | 'session-log' | 'migrate' | 'qa-generate';

export interface RunTag {
  projectCwd: string;
  kind: RunKind;
  jobId?: string;
  stage?: string;
}

/**
 * Record a run BEFORE it spawns and return its row id, or null when the
 * database is unavailable. Never throws: accounting must not be able to stop a
 * run from happening.
 *
 * Written first on purpose. A run killed a second after starting has already
 * written transcript lines, and those lines are only attributable if this row
 * exists by the time the ledger reads them.
 */
export function recordRunStart(sessionId: string, tag: RunTag): number | null {
  try {
    const info = getDatabase()
      .prepare(
        `INSERT INTO agent_runs (session_id, project_cwd, kind, job_id, stage, started_at)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(sessionId, tag.projectCwd, tag.kind, tag.jobId ?? null, tag.stage ?? null, new Date().toISOString());
    invalidateUsageCache();
    return Number(info.lastInsertRowid);
  } catch (error) {
    logger.warn({ error, sessionId }, 'usage: could not record run start');
    return null;
  }
}

/**
 * Close a run's window. A later run in the same session (an answer resumes the
 * asking session) or a Take over then reads as its own spend rather than this
 * run's. Never throws.
 */
export function recordRunEnd(runId: number | null): void {
  if (runId === null) return;
  try {
    getDatabase()
      .prepare('UPDATE agent_runs SET ended_at = ? WHERE id = ?')
      .run(new Date().toISOString(), runId);
    invalidateUsageCache();
  } catch (error) {
    logger.warn({ error, runId }, 'usage: could not record run end');
  }
}

// --- Reads -----------------------------------------------------------------

/** One GROUP BY row: a bucket of one model's tokens. */
interface TokenRow {
  model: string;
  speed: string | null;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_5m_tokens: number;
  cache_write_1h_tokens: number;
}

/** Price one bucket. Rows are grouped by model and speed, because rates are. */
function usageOfRow(row: TokenRow): Usage {
  const cost = priceTokens(
    row.model,
    {
      inputTokens: row.input_tokens,
      outputTokens: row.output_tokens,
      cacheReadTokens: row.cache_read_tokens,
      cacheWrite5mTokens: row.cache_write_5m_tokens,
      cacheWrite1hTokens: row.cache_write_1h_tokens,
    },
    row.speed
  );
  return {
    inputTokens: row.input_tokens,
    outputTokens: row.output_tokens,
    cacheReadTokens: row.cache_read_tokens,
    cacheCreationTokens: row.cache_write_5m_tokens + row.cache_write_1h_tokens,
    costUsd: cost ?? 0,
    runCount: 0,
    unpriced: cost === null,
  };
}

const TOKEN_SUMS = `
  SUM(m.input_tokens) AS input_tokens,
  SUM(m.output_tokens) AS output_tokens,
  SUM(m.cache_read_tokens) AS cache_read_tokens,
  SUM(m.cache_write_5m_tokens) AS cache_write_5m_tokens,
  SUM(m.cache_write_1h_tokens) AS cache_write_1h_tokens`;

/**
 * The run a message belongs to: same session, and inside that run's window.
 * A session can span several runs (--resume keeps the id) and a Take over, so
 * the session alone does not say which stage spent a token. A message outside
 * every window — Take over, or history from before runs were recorded — belongs
 * to the job with no stage.
 */
const STAGE_OF_MESSAGE = `(
  SELECT r.stage FROM agent_runs r
   WHERE r.session_id = m.session_id
     AND r.started_at <= m.ts
     AND (r.ended_at IS NULL OR r.ended_at >= m.ts)
   ORDER BY r.started_at DESC LIMIT 1)`;

export interface JobUsage {
  total: Usage;
  /** Keyed by stage name. Spend outside any stage run is in `total` only. */
  stages: Map<string, Usage>;
}

/**
 * Everything a project spent, split by who spent it. `pipeline` is job runs and
 * Take over; `background` is session-log, migration and QA generation; the rest
 * is interactive sessions (including ones in a track worktree).
 */
export interface ProjectUsage {
  total: Usage;
  pipeline: Usage;
  background: Usage;
  sessions: Usage;
}

// --- Cache -------------------------------------------------------------------
//
// Both reads sit on poll paths — the job board every few seconds, the overlay
// on every job write, the project list on every load — and both aggregate the
// whole ledger, with a correlated subquery per message. The ledger changes far
// less often than that: only when a run starts or ends, or a pass inserts rows.
// Each of those bumps the generation; a read at the same generation is served
// from memory.

let generation = 0;
let jobCache: { generation: number; value: Map<string, JobUsage> } | null = null;
let projectCache: { generation: number; value: Map<string, ProjectUsage> } | null = null;

/**
 * Mark cached usage stale. Called by everything in this module that writes, and
 * by the ledger after a pass that inserted rows; anything else writing ledger
 * tables directly (a test, a migration) must call it too.
 */
export function invalidateUsageCache(): void {
  generation++;
}

/**
 * Usage per job, per stage and in total — for the given jobs, or all of them.
 * The returned maps are shared with the cache: read them, never mutate them.
 * Never throws: a board that cannot read the ledger still renders.
 */
export function usageByJob(jobIds?: string[]): Map<string, JobUsage> {
  if (!jobCache || jobCache.generation !== generation) {
    const value = readJobUsage();
    // A failed read is not cached, so the next poll tries again.
    if (value) jobCache = { generation, value };
    else return new Map();
  }
  const all = jobCache.value;
  if (!jobIds) return all;
  const out = new Map<string, JobUsage>();
  for (const id of jobIds) {
    const usage = all.get(id);
    if (usage) out.set(id, usage);
  }
  return out;
}

/** Everything each project spent, keyed by the project cwd the ledger stored. Shared: never mutate. */
export function usageByProject(): Map<string, ProjectUsage> {
  if (!projectCache || projectCache.generation !== generation) {
    const value = readProjectUsage();
    if (value) projectCache = { generation, value };
    else return new Map();
  }
  return projectCache.value;
}

/**
 * Each project with what it spent, or `usage: null` before anything was read.
 * Matched by path, not string: the ledger stores the cwd the board reported
 * when it attributed a file, which may differ in case or separators from how
 * the board spells it today.
 */
export function withProjectUsage<T extends { cwd: string }>(projects: T[]): (T & { usage: ProjectUsage | null })[] {
  const spent = new Map([...usageByProject()].map(([cwd, usage]) => [pathKey(cwd), usage]));
  return projects.map((p) => ({ ...p, usage: spent.get(pathKey(p.cwd)) ?? null }));
}

// --- Queries -------------------------------------------------------------------

function readJobUsage(): Map<string, JobUsage> | null {
  const out = new Map<string, JobUsage>();
  try {
    const db = getDatabase();
    const rows = db
      .prepare(
        `SELECT m.job_id AS job_id, ${STAGE_OF_MESSAGE} AS stage, m.model AS model, m.speed AS speed,
                ${TOKEN_SUMS}
           FROM usage_messages m
          WHERE m.job_id IS NOT NULL
          GROUP BY job_id, stage, model, speed`
      )
      .all() as (TokenRow & { job_id: string; stage: string | null })[];

    const runRows = db
      .prepare(
        `SELECT job_id, stage, COUNT(*) AS runs FROM agent_runs
          WHERE job_id IS NOT NULL
          GROUP BY job_id, stage`
      )
      .all() as { job_id: string; stage: string | null; runs: number }[];

    const entry = (jobId: string): JobUsage => {
      let e = out.get(jobId);
      if (!e) {
        e = { total: { ...ZERO_USAGE }, stages: new Map() };
        out.set(jobId, e);
      }
      return e;
    };
    const addTo = (e: JobUsage, stage: string | null, u: Usage) => {
      e.total = addUsage(e.total, u);
      if (stage) e.stages.set(stage, addUsage(e.stages.get(stage) ?? ZERO_USAGE, u));
    };

    for (const row of rows) addTo(entry(row.job_id), row.stage, usageOfRow(row));
    for (const row of runRows) {
      addTo(entry(row.job_id), row.stage, { ...ZERO_USAGE, runCount: row.runs });
    }
    return out;
  } catch (error) {
    logger.warn({ error }, 'usage: could not read job usage');
    return null;
  }
}

function readProjectUsage(): Map<string, ProjectUsage> | null {
  const out = new Map<string, ProjectUsage>();
  try {
    const rows = getDatabase()
      .prepare(
        `SELECT m.project_cwd AS project_cwd,
                CASE WHEN m.job_id IS NOT NULL THEN 'pipeline'
                     WHEN r.kind IS NOT NULL THEN 'background'
                     ELSE 'sessions' END AS bucket,
                m.model AS model, m.speed AS speed,
                ${TOKEN_SUMS}
           FROM usage_messages m
           LEFT JOIN (SELECT session_id, MIN(kind) AS kind FROM agent_runs GROUP BY session_id) r
             ON r.session_id = m.session_id
          GROUP BY project_cwd, bucket, model, speed`
      )
      .all() as (TokenRow & { project_cwd: string; bucket: 'pipeline' | 'background' | 'sessions' })[];

    for (const row of rows) {
      let e = out.get(row.project_cwd);
      if (!e) {
        e = { total: ZERO_USAGE, pipeline: ZERO_USAGE, background: ZERO_USAGE, sessions: ZERO_USAGE };
        out.set(row.project_cwd, e);
      }
      const u = usageOfRow(row);
      e.total = addUsage(e.total, u);
      e[row.bucket] = addUsage(e[row.bucket], u);
    }
    return out;
  } catch (error) {
    logger.warn({ error }, 'usage: could not read project usage');
    return null;
  }
}
