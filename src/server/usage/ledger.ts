import { closeSync, existsSync, openSync, readdirSync, readSync, statSync } from 'fs';
import { basename, join } from 'path';
import { setImmediate } from 'timers';
import type Database from 'better-sqlite3';
import { getDatabase } from '../db/schema.js';
import { createLogger } from '../utils/logger.js';
import { pathKey } from '../sessions/project-discovery.js';
import { worktreeRoot } from '../jobs/worktree.js';
import { jobEvents } from '../jobs/events.js';
import { onRunSettled } from '../agent/run-events.js';
import { invalidateUsageCache } from './store.js';
import { accountForConfigDir, accountNames, allProjectsDirs, expectedLoginCreatedAt, projectsDir as accountProjectsDir } from '../accounts.js';

const logger = createLogger('usage-ledger');

/**
 * The usage ledger: every model call Claude Code made in a workspace project,
 * read from the transcripts it already writes. See docs/token-usage-feature.md.
 *
 * Two facts about those transcripts shape everything here:
 *  - One API response is written once PER CONTENT BLOCK, each line carrying
 *    the same byte-identical usage. Summing lines roughly doubles every figure,
 *    so `message.id` is the primary key and a repeat is a no-op.
 *  - Subagents write to `<session>/subagents/agent-*.jsonl`, not the parent's
 *    file. Scanning top-level files only would drop all subagent spend.
 *
 * Transcripts only grow, so each file is read from where the last pass stopped,
 * and only up to its last newline — a line mid-write is picked up next time.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** A Claude Code scratchpad: `…\claude\<slug>\<parent session id>\scratchpad`. */
const SCRATCHPAD =
  /[\\/]claude[\\/][^\\/]+[\\/]([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})[\\/]scratchpad(?:[\\/]|$)/i;
/**
 * Bytes read per step. Small enough that no single step holds the event loop
 * for long — a first-boot import reads tens of megabytes, and every terminal
 * on the server stalls while a read is parsing.
 */
const READ_CHUNK = 1024 * 1024;
const SEP = '\\';

export interface IngestOptions {
  /** Every account's projects folder (accounts.ts) unless overridden (tests). */
  projectsDirs?: string[];
  /** Cwds of the projects that have a PROJECT.md. Defaults to the workspace board's. */
  docProjects?: string[];
  /** Bytes per read step (tests, to put a chunk boundary where they want it). */
  readChunkBytes?: number;
  /** The home folder accounts' `~` resolve against (tests). */
  home?: string;
}

export interface IngestStats {
  files: number;
  read: number;
  /** Rows written: new responses, plus copies re-homed to the session that made them. */
  inserted: number;
  /** `usage_files` rows dropped because their transcript no longer exists. */
  pruned: number;
}

interface FileRow {
  path: string;
  size: number;
  mtime_ms: number;
  offset: number;
  cwd: string | null;
  session_id: string;
  parent_session_id: string | null;
  project_cwd: string | null;
  job_id: string | null;
  track_id: string | null;
}

interface Attribution {
  projectCwd: string;
  jobId: string | null;
  trackId: string | null;
}

interface Candidate {
  path: string;
  sessionId: string;
  parentSessionId: string | null;
  size: number;
  mtimeMs: number;
}

/**
 * Yield to the event loop between steps of a long pass. setImmediate, not
 * setTimeout(0): on Windows a timer rounds up to ~15ms, and a first import
 * yields a few hundred times.
 */
const tick = () => new Promise<void>((r) => setImmediate(r));

// --- Statements ----------------------------------------------------------------

/** Every statement a pass runs, prepared once per pass rather than once per file. */
function prepare(db: Database.Database) {
  return {
    parentAttribution: db.prepare(
      `SELECT project_cwd, job_id, track_id FROM usage_files
        WHERE session_id = ? AND parent_session_id IS NULL AND project_cwd IS NOT NULL LIMIT 1`
    ),
    runOfSession: db.prepare('SELECT project_cwd, job_id FROM agent_runs WHERE session_id = ? ORDER BY id LIMIT 1'),
    trackProject: db.prepare('SELECT project_cwd FROM track_branches WHERE id = ?'),
    jobProject: db.prepare('SELECT project_cwd FROM jobs WHERE id = ?'),
    jobRunProject: db.prepare('SELECT project_cwd FROM agent_runs WHERE job_id = ? LIMIT 1'),
    /**
     * New responses are inserted. A response already stored is left alone —
     * unless the stored copy came from an untagged session and this one from a
     * tagged run: a Fork copies history into a new file under the same message
     * ids, and whichever file a pass happens to read first would otherwise own
     * the row, stripping a stage run's messages of their run window.
     */
    // The account is set once, at insert (or by the boot backfill): a re-home
    // moves a response to the run that made it, not to another login.
    insert: db.prepare(
      `INSERT INTO usage_messages (message_id, session_id, project_cwd, job_id, track_id, model, speed, ts,
         input_tokens, output_tokens, cache_read_tokens, cache_write_5m_tokens, cache_write_1h_tokens, account)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(message_id) DO UPDATE SET
         session_id = excluded.session_id, project_cwd = excluded.project_cwd,
         job_id = excluded.job_id, track_id = excluded.track_id
       WHERE EXISTS (SELECT 1 FROM agent_runs WHERE session_id = excluded.session_id)
         AND NOT EXISTS (SELECT 1 FROM agent_runs WHERE session_id = usage_messages.session_id)`
    ),
    upsertFile: db.prepare(
      `INSERT INTO usage_files (path, size, mtime_ms, offset, cwd, session_id, parent_session_id, project_cwd, job_id, track_id)
       VALUES (@path, @size, @mtime_ms, @offset, @cwd, @session_id, @parent_session_id, @project_cwd, @job_id, @track_id)
       ON CONFLICT(path) DO UPDATE SET size = @size, mtime_ms = @mtime_ms, offset = @offset, cwd = @cwd,
         project_cwd = @project_cwd, job_id = @job_id, track_id = @track_id`
    ),
  };
}

type Statements = ReturnType<typeof prepare>;

// --- Discovery -----------------------------------------------------------------

/** Every transcript: top-level session files, then subagent files beneath them. */
function listTranscripts(projectsDir: string): Candidate[] {
  const out: Candidate[] = [];
  let folders: string[];
  try {
    folders = readdirSync(projectsDir);
  } catch {
    return out;
  }
  for (const folder of folders) {
    const dir = join(projectsDir, folder);
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.isFile() && entry.name.endsWith('.jsonl')) {
        const path = join(dir, entry.name);
        const st = safeStat(path);
        if (st) out.push({ path, sessionId: basename(entry.name, '.jsonl'), parentSessionId: null, ...st });
      } else if (entry.isDirectory() && UUID.test(entry.name)) {
        const subDir = join(dir, entry.name, 'subagents');
        if (!existsSync(subDir)) continue;
        let subs: string[];
        try {
          subs = readdirSync(subDir);
        } catch {
          continue;
        }
        for (const name of subs) {
          if (!name.endsWith('.jsonl')) continue;
          const path = join(subDir, name);
          const st = safeStat(path);
          if (st) out.push({ path, sessionId: basename(name, '.jsonl'), parentSessionId: entry.name, ...st });
        }
      }
    }
  }
  return out;
}

function safeStat(path: string): { size: number; mtimeMs: number } | null {
  try {
    const st = statSync(path);
    return { size: st.size, mtimeMs: st.mtimeMs };
  } catch {
    return null;
  }
}

/**
 * Visit each complete line of `[offset, size)`, `chunkBytes` at a time,
 * yielding between steps. `visit` returns true to stop early. Resolves with the
 * offset just past the last complete line visited.
 *
 * Lines are cut on raw bytes, never decoded text: a step boundary can split a
 * multi-byte character, and decoding early would make the offset drift.
 */
async function forEachLine(
  path: string,
  offset: number,
  size: number,
  chunkBytes: number,
  visit: (lines: string[]) => boolean | void
): Promise<number> {
  let fd: number | null = null;
  let pos = offset;
  let carry = Buffer.alloc(0);
  try {
    fd = openSync(path, 'r');
    const buf = Buffer.alloc(Math.min(chunkBytes, Math.max(size - offset, 1)));
    while (pos < size) {
      const bytes = readSync(fd, buf, 0, Math.min(buf.length, size - pos), pos);
      if (bytes <= 0) break;
      pos += bytes;
      const chunk = carry.length > 0 ? Buffer.concat([carry, buf.subarray(0, bytes)]) : buf.subarray(0, bytes);
      const lastNewline = chunk.lastIndexOf(0x0a);
      // Copied: `buf` is reused by the next read.
      if (lastNewline === -1) {
        carry = Buffer.from(chunk);
        continue;
      }
      carry = Buffer.from(chunk.subarray(lastNewline + 1));
      if (visit(chunk.toString('utf8', 0, lastNewline).split('\n'))) break;
      await tick();
    }
  } finally {
    if (fd !== null) closeSync(fd);
  }
  // The unterminated tail is left for the next pass.
  return pos - carry.length;
}

/**
 * The first top-level `cwd` any line of the file records, or null.
 *
 * Scans as far as it takes rather than a fixed head: a session that opens with
 * a huge paste can put the first `cwd` megabytes in, and a head-only read would
 * leave that file unattributed forever. Lines are parsed, not pattern-matched,
 * because a tool call's input can carry a nested `"cwd"` of its own earlier on
 * the same line.
 */
async function readFirstCwd(path: string, size: number, chunkBytes: number): Promise<string | null> {
  let found: string | null = null;
  try {
    await forEachLine(path, 0, size, chunkBytes, (lines) => {
      for (const line of lines) {
        if (!line.includes('"cwd"')) continue;
        try {
          const cwd = (JSON.parse(line) as { cwd?: unknown }).cwd;
          if (typeof cwd === 'string' && cwd) {
            found = cwd;
            return true;
          }
        } catch {
          // not a JSON line
        }
      }
      return false;
    });
  } catch {
    return null;
  }
  return found;
}

// --- Attribution ---------------------------------------------------------------

/**
 * Which workspace project (and job or track) a transcript belongs to, or null.
 *
 * Records first — a run we tagged, a worktree whose id is a job or track —
 * per docs/change-provenance.md. Path containment is the last rule, and it only
 * ever resolves to a project that has a PROJECT.md: those are the ledger's scope.
 */
function resolve(
  file: { sessionId: string; parentSessionId: string | null; cwd: string | null },
  docs: Map<string, string>,
  stmts: Statements
): Attribution | null {
  const inDocs = (cwd: string | null | undefined): string | null => (cwd ? docProjectOf(cwd, docs) : null);
  const ofSession = (sessionId: string): Attribution | null => {
    const row = stmts.parentAttribution.get(sessionId) as
      | { project_cwd: string; job_id: string | null; track_id: string | null }
      | undefined;
    return row ? { projectCwd: row.project_cwd, jobId: row.job_id, trackId: row.track_id } : null;
  };

  // A subagent's spend is its parent session's.
  if (file.parentSessionId) return ofSession(file.parentSessionId);

  // A run we tagged before it spawned.
  const run = stmts.runOfSession.get(file.sessionId) as { project_cwd: string; job_id: string | null } | undefined;
  if (run) {
    const projectCwd = inDocs(run.project_cwd);
    if (projectCwd) return { projectCwd, jobId: run.job_id, trackId: null };
  }

  if (!file.cwd) return null;
  const key = pathKey(file.cwd);

  // A worktree's directory name IS its job or track id. For jobs, fall back to
  // agent_runs: a discarded job's row is gone, but its runs are not.
  const root = pathKey(worktreeRoot());
  if (key.startsWith(root + SEP)) {
    const [first, second] = key.slice(root.length + 1).split(SEP);
    if (first === 'tracks' && second && UUID.test(second)) {
      const track = stmts.trackProject.get(second) as { project_cwd: string } | undefined;
      const projectCwd = inDocs(track?.project_cwd);
      return projectCwd ? { projectCwd, jobId: null, trackId: second } : null;
    }
    if (first && UUID.test(first)) {
      const job = (stmts.jobProject.get(first) ?? stmts.jobRunProject.get(first)) as
        | { project_cwd: string }
        | undefined;
      const projectCwd = inDocs(job?.project_cwd);
      return projectCwd ? { projectCwd, jobId: first, trackId: null } : null;
    }
    return null;
  }

  // A scratchpad belongs to the session that created it.
  const scratch = SCRATCHPAD.exec(file.cwd);
  if (scratch) return ofSession(scratch[1]);

  const projectCwd = inDocs(file.cwd);
  return projectCwd ? { projectCwd, jobId: null, trackId: null } : null;
}

/**
 * The workspace project a path lies in: its root or anything beneath it, so
 * `dsnews\api` counts as dsnews. Longest match wins, so a nested project with
 * its own PROJECT.md keeps its own spend.
 */
function docProjectOf(cwd: string, docs: Map<string, string>): string | null {
  const key = pathKey(cwd);
  let best: string | null = null;
  let bestLen = -1;
  for (const [docKey, docCwd] of docs) {
    if ((key === docKey || key.startsWith(docKey + SEP)) && docKey.length > bestLen) {
      best = docCwd;
      bestLen = docKey.length;
    }
  }
  return best;
}

/**
 * Order files so every rule that reads another file's attribution finds it:
 * ordinary sessions, then scratchpad sessions (which look up their parent),
 * then subagents (which look up theirs).
 */
function passOf(c: { parentSessionId: string | null; cwd: string | null }): number {
  if (c.parentSessionId) return 2;
  return c.cwd && SCRATCHPAD.test(c.cwd) ? 1 : 0;
}

// --- Which login ran it ---------------------------------------------------------

/**
 * The login behind the messages of one transcript, from the folder it lives in
 * (docs/token-usage-feature.md). A message older than `cutoffMs` — the folder's
 * expected login's `accountCreatedAt` — can't have run under that login: before
 * it existed, its folder could only hold transcripts moved in from the default
 * folder (`f-ilxxdj`), so it is `before`'s, the default folder's account.
 */
interface FolderLogin {
  account: string;
  /** Epoch ms; null for the default folder, whose older messages are its own. */
  cutoffMs: number | null;
  before: string | null;
}

/**
 * Where each account's transcripts live and from when its login holds. Read
 * once per pass. An account whose creation time is unknown — including another
 * login than the expected one sitting in its folder after a `/login` swap — is
 * left out: its messages stay unattributed rather than guessed, and a later pass
 * that knows fills them in (backfillMessageAccounts). The default folder's
 * account needs no date: everything older is its own anyway.
 */
function folderLogins(home?: string): { key: string; login: FolderLogin }[] {
  const defaultFolder = accountForConfigDir(null, home);
  const out: { key: string; login: FolderLogin }[] = [];
  for (const account of accountNames()) {
    const key = pathKey(accountProjectsDir(account, home));
    if (out.some((f) => f.key === key)) continue; // two accounts on one folder: the first owns it
    if (account === defaultFolder) {
      out.push({ key, login: { account, cutoffMs: null, before: null } });
      continue;
    }
    const created = expectedLoginCreatedAt(account, home);
    if (!created) continue;
    out.push({ key, login: { account, cutoffMs: Date.parse(created), before: defaultFolder } });
  }
  return out;
}

function loginOfPath(path: string, folders: { key: string; login: FolderLogin }[]): FolderLogin | null {
  const key = pathKey(path);
  let best: { key: string; login: FolderLogin } | null = null;
  for (const f of folders) {
    if (key.startsWith(f.key + SEP) && (!best || f.key.length > best.key.length)) best = f;
  }
  return best?.login ?? null;
}

/**
 * The account a message at `ts` ran under, or null (unattributed). The one
 * comparison both ingest and the backfill use, in epoch ms: transcript times
 * vary in precision, so comparing them as text could split one second's
 * messages differently in the two.
 */
function accountOfMessage(login: FolderLogin | null, ts: string): string | null {
  if (!login) return null;
  if (login.cutoffMs !== null) {
    const ms = Date.parse(ts);
    if (Number.isNaN(ms)) return null;
    if (ms < login.cutoffMs) return login.before;
  }
  return login.account;
}

/**
 * Give every unattributed message its account, by the same rule as ingest,
 * keyed by the `usage_files` path its session was read from (a subagent file
 * through its parent's session id). Run at the start of every pass, not once:
 * a message stored while its login was unknown — `.claude.json` caught
 * mid-write, a `/login` swap — is attributed as soon as a pass knows. Only NULL
 * rows are touched, so it never flips an attribution; the session index keeps a
 * pass with nothing to do to one lookup per file. Returns how many rows it set.
 */
export function backfillMessageAccounts(home?: string, folders = folderLogins(home)): number {
  if (folders.length === 0) return 0;
  const db = getDatabase();
  const files = db
    .prepare('SELECT path, session_id, parent_session_id FROM usage_files')
    .all() as { path: string; session_id: string; parent_session_id: string | null }[];
  const unattributed = db.prepare('SELECT message_id, ts FROM usage_messages WHERE session_id = ? AND account IS NULL');
  const update = db.prepare('UPDATE usage_messages SET account = ? WHERE message_id = ? AND account IS NULL');
  let changed = 0;
  db.transaction(() => {
    for (const f of files) {
      const login = loginOfPath(f.path, folders);
      if (!login) continue;
      const rows = unattributed.all(f.parent_session_id ?? f.session_id) as { message_id: string; ts: string }[];
      for (const row of rows) {
        const account = accountOfMessage(login, row.ts);
        if (account) changed += update.run(account, row.message_id).changes;
      }
    }
  })();
  if (changed > 0) {
    invalidateUsageCache();
    logger.info({ attributed: changed }, 'usage: attributed earlier messages to their accounts');
  }
  return changed;
}

// --- Reading -------------------------------------------------------------------

interface UsageLine {
  timestamp?: unknown;
  message?: {
    id?: unknown;
    model?: unknown;
    usage?: {
      input_tokens?: unknown;
      output_tokens?: unknown;
      cache_read_input_tokens?: unknown;
      cache_creation_input_tokens?: unknown;
      cache_creation?: { ephemeral_5m_input_tokens?: unknown; ephemeral_1h_input_tokens?: unknown };
      speed?: unknown;
    };
  };
}

function int(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : 0;
}

/**
 * Read `[offset, size)` and store its usage lines, one transaction per step.
 * Resolves with the new offset — just past the last complete line — and how
 * many rows were written.
 */
async function readFrom(
  c: { path: string; size: number },
  offset: number,
  sessionId: string,
  attr: Attribution,
  login: FolderLogin | null,
  stmts: Statements,
  chunkBytes: number
): Promise<{ offset: number; inserted: number }> {
  let inserted = 0;
  const store = getDatabase().transaction((lines: string[]) => {
    for (const line of lines) {
      if (!line.includes('"usage"')) continue;
      let j: UsageLine;
      try {
        j = JSON.parse(line) as UsageLine;
      } catch {
        continue;
      }
      const m = j.message;
      const id = m?.id;
      const model = m?.model;
      const u = m?.usage;
      if (typeof id !== 'string' || typeof model !== 'string' || !u || typeof j.timestamp !== 'string') continue;
      // Client-side placeholders (API errors, interrupts) carry zero usage.
      if (model === '<synthetic>') continue;
      const split = u.cache_creation;
      const write1h = int(split?.ephemeral_1h_input_tokens);
      // Transcripts that predate the TTL split report one total; it prices
      // as a 5-minute write, the cheaper reading.
      const write5m = split ? int(split.ephemeral_5m_input_tokens) : int(u.cache_creation_input_tokens);
      const info = stmts.insert.run(
        id,
        sessionId,
        attr.projectCwd,
        attr.jobId,
        attr.trackId,
        model,
        typeof u.speed === 'string' ? u.speed : null,
        j.timestamp,
        int(u.input_tokens),
        int(u.output_tokens),
        int(u.cache_read_input_tokens),
        write5m,
        write1h,
        accountOfMessage(login, j.timestamp)
      );
      inserted += info.changes;
    }
  });
  const next = await forEachLine(c.path, offset, c.size, chunkBytes, (lines) => {
    store(lines);
  });
  return { offset: next, inserted };
}

// --- One pass ------------------------------------------------------------------

async function defaultDocProjects(): Promise<string[]> {
  const { getWorkspaceBoard } = await import('../projects/workspace.js');
  return getWorkspaceBoard()
    .filter((p) => p.hasDoc)
    .map((p) => p.cwd);
}

async function ingestOnce(opts: IngestOptions): Promise<IngestStats> {
  const db = getDatabase();
  const stmts = prepare(db);
  const chunkBytes = opts.readChunkBytes ?? READ_CHUNK;
  const projectsDirs = opts.projectsDirs ?? allProjectsDirs();
  const docList = opts.docProjects ?? (await defaultDocProjects());
  const docs = new Map(docList.map((cwd) => [pathKey(cwd), cwd]));

  const folders = folderLogins(opts.home);
  backfillMessageAccounts(opts.home, folders);

  const known = new Map(
    (db.prepare('SELECT * FROM usage_files').all() as FileRow[]).map((r) => [r.path, r])
  );
  const candidates: (Candidate & { row: FileRow | undefined; cwd: string | null })[] = [];
  for (const c of projectsDirs.flatMap(listTranscripts)) {
    const row = known.get(c.path);
    // cwd is fixed once found. A file with none yet is scanned again only
    // when it has changed — an unchanged file has nothing new to find.
    let cwd = row?.cwd ?? null;
    const untouched = !!row && row.size === c.size && row.mtime_ms === c.mtimeMs;
    if (cwd === null && !c.parentSessionId && !untouched) cwd = await readFirstCwd(c.path, c.size, chunkBytes);
    candidates.push({ ...c, row, cwd });
  }
  candidates.sort((a, b) => passOf(a) - passOf(b) || a.mtimeMs - b.mtimeMs);

  const stats: IngestStats = { files: candidates.length, read: 0, inserted: 0, pruned: 0 };
  let jobRows = false;
  for (const c of candidates) {
    // Attribution is settled once found. A file left out-of-scope is resolved
    // again every pass, which is what imports a project's history the first
    // time it gains a PROJECT.md — its files start again from byte 0.
    let attr: Attribution | null = c.row?.project_cwd
      ? { projectCwd: c.row.project_cwd, jobId: c.row.job_id, trackId: c.row.track_id }
      : resolve(c, docs, stmts);
    let offset = c.row?.project_cwd ? c.row.offset : 0;
    // A transcript that shrank was rewritten; re-read it — the key dedupes.
    if (offset > c.size) offset = 0;

    const unchanged = !!c.row && c.row.size === c.size && c.row.mtime_ms === c.mtimeMs && c.row.cwd === c.cwd;
    if (unchanged && (attr ? !!c.row?.project_cwd && offset === c.size : !c.row?.project_cwd)) continue;

    if (attr && offset < c.size) {
      try {
        // A subagent's rows carry the parent's session id, so they fall inside
        // the parent's run windows and land on that run's stage.
        const sessionId = c.parentSessionId ?? c.sessionId;
        const result = await readFrom(c, offset, sessionId, attr, loginOfPath(c.path, folders), stmts, chunkBytes);
        offset = result.offset;
        stats.read++;
        stats.inserted += result.inserted;
        if (result.inserted > 0 && attr.jobId) jobRows = true;
      } catch (error) {
        logger.warn({ error, path: c.path }, 'usage: could not read transcript');
        attr = c.row?.project_cwd ? attr : null;
      }
    }

    stmts.upsertFile.run({
      path: c.path,
      size: c.size,
      mtime_ms: c.mtimeMs,
      offset: attr ? offset : 0,
      cwd: c.cwd,
      session_id: c.sessionId,
      parent_session_id: c.parentSessionId,
      project_cwd: attr?.projectCwd ?? null,
      job_id: attr?.jobId ?? null,
      track_id: attr?.trackId ?? null,
    });
    await tick();
  }
  stats.pruned = pruneMissingFiles(db, known, new Set(candidates.map((c) => c.path)));
  if (stats.inserted > 0) invalidateUsageCache();
  // The job board and overlay read usage off job payloads; nudge them.
  if (jobRows) jobEvents.emitChange();
  return stats;
}

/**
 * Drop the `usage_files` rows of transcripts that no longer exist — deleted from
 * history, moved to another account's folder, or a folder renamed
 * (project/rename-claude-work.md). Left alone they would be kept forever, and a
 * moved file is read again under its new path anyway (no double count:
 * `usage_messages` is keyed by message id).
 *
 * Only the file bookkeeping goes: `usage_messages` — the spend — is never
 * deleted here. A row this pass listed is never missing, and one it did not list
 * is checked on disk, so an unreadable folder doesn't wipe its rows. A parent's
 * row stays while a subagent file of it survives: the subagent's attribution is
 * looked up from it.
 */
function pruneMissingFiles(db: Database.Database, known: Map<string, FileRow>, listed: Set<string>): number {
  const missing = [...known.keys()].filter((path) => !listed.has(path) && !existsSync(path));
  if (missing.length === 0) return 0;
  const gone = new Set(missing);
  const neededParents = new Set(
    [...known.values()].filter((r) => !gone.has(r.path) && r.parent_session_id).map((r) => r.parent_session_id as string)
  );
  const prunable = missing.filter((path) => {
    const row = known.get(path)!;
    return row.parent_session_id !== null || !neededParents.has(row.session_id);
  });
  const del = db.prepare('DELETE FROM usage_files WHERE path = ?');
  db.transaction(() => {
    for (const path of prunable) del.run(path);
  })();
  if (prunable.length > 0) logger.info({ pruned: prunable.length }, 'usage: dropped rows of transcripts that no longer exist');
  return prunable.length;
}

// --- Scheduling ----------------------------------------------------------------

let running: Promise<IngestStats> | null = null;
let again = false;

/**
 * Run one ingest pass. Passes are serialised: a call made while one is running
 * resolves with that pass, and schedules exactly one more after it so nothing
 * written in the meantime waits for the timer. Never rejects.
 */
export function ingestUsage(opts: IngestOptions = {}): Promise<IngestStats> {
  if (running) {
    again = true;
    return running;
  }
  running = ingestOnce(opts)
    .catch((error) => {
      logger.warn({ error }, 'usage: ingest pass failed');
      return { files: 0, read: 0, inserted: 0, pruned: 0 };
    })
    .finally(() => {
      running = null;
      if (again) {
        again = false;
        void ingestUsage(opts);
      }
    });
  return running;
}

let debounce: NodeJS.Timeout | null = null;
/**
 * Off until the server starts the ledger. A pass follows every run, and in a
 * test or a one-off script that would scan the real ~/.claude/projects into
 * whatever database happens to be open.
 */
let enabled = false;

/** Ingest soon — after a run settles, or a session ends. Coalesces bursts. */
export function scheduleIngest(delayMs = 2000): void {
  if (!enabled) return;
  if (debounce) clearTimeout(debounce);
  debounce = setTimeout(() => {
    debounce = null;
    void ingestUsage();
  }, delayMs);
  debounce.unref?.();
}

const BACKSTOP_MS = 5 * 60 * 1000;
let timer: NodeJS.Timeout | null = null;
let unsubscribe: (() => void) | null = null;

/** Import history now, then keep up: after every run, and on a backstop timer. */
export function startUsageLedger(): void {
  enabled = true;
  unsubscribe = onRunSettled(() => scheduleIngest());
  void ingestUsage().then((s) => logger.info(s, 'usage: ledger ingest complete'));
  timer = setInterval(() => void ingestUsage(), BACKSTOP_MS);
  timer.unref?.();
}

export function stopUsageLedger(): void {
  enabled = false;
  unsubscribe?.();
  unsubscribe = null;
  if (timer) clearInterval(timer);
  if (debounce) clearTimeout(debounce);
  timer = null;
  debounce = null;
}
