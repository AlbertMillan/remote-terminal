import { existsSync, readdirSync, readFileSync, statSync } from 'fs';
import { open } from 'fs/promises';
import { homedir } from 'os';
import { basename, isAbsolute, join, relative, resolve } from 'path';
import { getConfig } from '../config.js';
import { createLogger } from '../utils/logger.js';
import { git, gitStatusEntries, type GitStatusEntry } from '../agent/claude-run.js';
import { parsePhasesBlock, type PhaseGroup } from '../sessions/session-log-format.js';
import type { RegistryProject } from './registry.js';
import { readProjectDoc } from './project-store.js';
import { featuresOf, type ProjectDoc } from './project-doc-format.js';

const logger = createLogger('track-attribution');

/**
 * Guess which work on main belongs to a track that had no branch at the time.
 *
 * This is a GUESS, and everything downstream treats it as one: the board shows
 * a count, Branch now asks for the file list to be confirmed, and Delete track
 * offers these items UNTICKED. A guess reverted by default would destroy
 * unrelated work (docs/track-branches.md).
 *
 * The link is a set of Claude sessions:
 *  - the `sessionIds` of the track's group in the SESSION-LOG phase manifest;
 *  - any session whose transcript wrote one of the track's feature ids into
 *    PROJECT.md — which is how the session that CREATED the track shows up,
 *    including by `cat >> PROJECT.md` from a shell.
 *
 * From those sessions it takes the paths written by Write/Edit/MultiEdit/
 * NotebookEdit that are still modified or untracked on main (anything since
 * restored — a rewound checkpoint, say — drops out), and the first-parent
 * commits made in each session's time window that touch a written path.
 *
 * Blind spot: files changed through a shell (`sed -i`, `cat >`, a script) are
 * invisible here. Sessions whose cwd is a track worktree need none of this.
 */

export interface GuessedFile {
  path: string;
  status: 'modified' | 'untracked' | 'deleted';
}

export interface GuessedCommit {
  sha: string;
  subject: string;
}

export interface TrackGuess {
  sessions: string[];
  files: GuessedFile[];
  commits: GuessedCommit[];
}

const EMPTY: TrackGuess = { sessions: [], files: [], commits: [] };

// --- Transcript scanning -----------------------------------------------

/** What one transcript contributes, independent of any track. */
export interface TranscriptSummary {
  sessionId: string;
  /** Absolute paths written by an editing tool. */
  written: Set<string>;
  /** Feature ids the session wrote into a PROJECT.md (via an edit or a shell command). */
  docIds: Set<string>;
  firstAt: number | null;
  lastAt: number | null;
}

interface CacheEntry {
  size: number;
  offset: number;
  summary: TranscriptSummary;
}

/**
 * Per-file incremental cache. A live session's transcript grows on every turn;
 * re-reading an 80 MB file from the start each time would be the cost of
 * every board load. Only the appended bytes are parsed.
 */
const cache = new Map<string, CacheEntry>();

const EDIT_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);
const SHELL_TOOLS = new Set(['Bash', 'PowerShell']);
const FEATURE_ID_RE = /f-[a-z0-9]{6}/g;
const TIMESTAMP_RE = /"timestamp"\s*:\s*"([^"]+)"/;

function emptySummary(sessionId: string): TranscriptSummary {
  return { sessionId, written: new Set(), docIds: new Set(), firstAt: null, lastAt: null };
}

function isProjectDoc(p: unknown): boolean {
  return typeof p === 'string' && basename(p).toLowerCase() === 'project.md';
}

function idsIn(text: unknown, into: Set<string>): void {
  if (typeof text !== 'string') return;
  for (const m of text.matchAll(FEATURE_ID_RE)) into.add(m[0]);
}

function absorbLine(line: string, s: TranscriptSummary): void {
  const ts = line.match(TIMESTAMP_RE);
  if (ts) {
    const t = Date.parse(ts[1]);
    if (!Number.isNaN(t)) {
      if (s.firstAt === null || t < s.firstAt) s.firstAt = t;
      if (s.lastAt === null || t > s.lastAt) s.lastAt = t;
    }
  }
  // Only tool calls matter below; skip the JSON parse for everything else.
  if (!line.includes('"tool_use"')) return;
  let entry: { message?: { content?: unknown } };
  try {
    entry = JSON.parse(line);
  } catch {
    return;
  }
  const content = entry.message?.content;
  if (!Array.isArray(content)) return;
  for (const block of content) {
    if (!block || block.type !== 'tool_use' || !block.input) continue;
    const input = block.input as Record<string, unknown>;
    if (EDIT_TOOLS.has(block.name)) {
      const file = (input.file_path ?? input.notebook_path) as unknown;
      if (typeof file === 'string') s.written.add(file);
      if (isProjectDoc(file)) {
        idsIn(input.content, s.docIds);
        idsIn(input.new_string, s.docIds);
        if (Array.isArray(input.edits)) {
          for (const e of input.edits) idsIn((e as Record<string, unknown>)?.new_string, s.docIds);
        }
      }
    } else if (SHELL_TOOLS.has(block.name)) {
      const cmd = input.command;
      if (typeof cmd === 'string' && /project\.md/i.test(cmd)) idsIn(cmd, s.docIds);
    }
  }
}

/**
 * Scans in progress, by path. Two callers scanning one transcript at once — the
 * board's badge request and a delete plan, say — would both read from the
 * same offset and both advance it, jumping past bytes neither parsed: lines
 * lost, attribution missing, and no error. So a second caller waits on the
 * first's scan instead of starting its own.
 */
const inflight = new Map<string, Promise<TranscriptSummary | null>>();

function scanTranscript(path: string): Promise<TranscriptSummary | null> {
  const running = inflight.get(path);
  if (running) return running;
  const scan = scanTranscriptNow(path).finally(() => inflight.delete(path));
  inflight.set(path, scan);
  return scan;
}

async function scanTranscriptNow(path: string): Promise<TranscriptSummary | null> {
  let size: number;
  try {
    size = statSync(path).size;
  } catch {
    cache.delete(path);
    return null;
  }
  let entry = cache.get(path);
  if (!entry || size < entry.offset) {
    // New, or rewritten shorter than we last read: start over.
    entry = { size: 0, offset: 0, summary: emptySummary(basename(path, '.jsonl')) };
    cache.set(path, entry);
  }
  if (size === entry.offset) return entry.summary;

  const handle = await open(path, 'r');
  try {
    // Decode only whole lines. 0x0A never occurs inside a multi-byte UTF-8
    // sequence, so cutting at the last newline can't split a character — which
    // decoding fixed-size chunks would, corrupting any path that straddles one.
    // A partial last line is left for the next read (the session is mid-write).
    let chunk = 4 * 1024 * 1024;
    while (entry.offset < size) {
      const want = Math.min(chunk, size - entry.offset);
      const buf = Buffer.alloc(want);
      const { bytesRead } = await handle.read(buf, 0, want, entry.offset);
      if (bytesRead === 0) break;
      const nl = buf.lastIndexOf(0x0a, bytesRead - 1);
      if (nl === -1) {
        if (entry.offset + bytesRead >= size) break; // an unfinished last line
        chunk *= 2; // one line longer than the chunk: a large Write, say
        continue;
      }
      for (const line of buf.subarray(0, nl).toString('utf-8').split('\n')) {
        absorbLine(line, entry.summary);
      }
      entry.offset += nl + 1;
    }
  } finally {
    await handle.close();
  }
  entry.size = size;
  return entry.summary;
}

/** The Claude Code transcript folder for a cwd: every non-alphanumeric becomes '-'. */
function transcriptDirFor(cwd: string): string | null {
  const root = join(homedir(), '.claude', 'projects');
  const slug = resolve(cwd).replace(/[^a-zA-Z0-9]/g, '-').toLowerCase();
  try {
    const hit = readdirSync(root, { withFileTypes: true }).find(
      (e) => e.isDirectory() && e.name.toLowerCase() === slug
    );
    return hit ? join(root, hit.name) : null;
  } catch {
    return null;
  }
}

async function projectTranscripts(cwd: string): Promise<TranscriptSummary[]> {
  const dir = transcriptDirFor(cwd);
  if (!dir) return [];
  let files: string[];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith('.jsonl'));
  } catch {
    return [];
  }
  // Forget transcripts deleted since the last scan, or the cache only grows.
  const present = new Set(files.map((f) => join(dir, f)));
  const prefix = join(dir, ' ').slice(0, -1);
  for (const cached of cache.keys()) {
    if (cached.startsWith(prefix) && !present.has(cached)) cache.delete(cached);
  }

  const out: TranscriptSummary[] = [];
  for (const f of files) {
    try {
      const s = await scanTranscript(join(dir, f));
      if (s) out.push(s);
    } catch (error) {
      logger.warn({ file: f, error: (error as Error).message }, 'attribution: transcript unreadable');
    }
  }
  return out;
}

// --- Guessing ----------------------------------------------------------

function toRel(cwd: string, abs: string): string | null {
  const rel = relative(resolve(cwd), resolve(abs));
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) return null;
  return rel.replace(/\\/g, '/');
}

const key = (p: string): string => p.replace(/\\/g, '/').toLowerCase();

/**
 * Everything a guess reads that doesn't depend on the track: the transcripts,
 * the phase manifest, PROJECT.md and the checkout's status. Built once and
 * shared when guessing for several tracks at a time (the board asks about
 * every unbranched track in a project at once), rather than re-listing,
 * re-statting and re-parsing all of it per track.
 */
export interface AttributionContext {
  project: RegistryProject;
  docRel: string;
  doc: ProjectDoc;
  phaseGroups: PhaseGroup[];
  transcripts: TranscriptSummary[];
  status: GitStatusEntry[];
}

export async function attributionContext(project: RegistryProject): Promise<AttributionContext> {
  const logPath = join(project.cwd, getConfig().projectLog.fileName);
  let phaseGroups: PhaseGroup[] = [];
  try {
    if (existsSync(logPath)) phaseGroups = parsePhasesBlock(readFileSync(logPath, 'utf-8'));
  } catch {
    phaseGroups = [];
  }
  return {
    project,
    docRel: (project.doc || 'PROJECT.md').replace(/\\/g, '/'),
    doc: readProjectDoc(project).doc,
    phaseGroups,
    transcripts: await projectTranscripts(project.cwd),
    status: (await gitStatusEntries(project.cwd, { allUntracked: true })) ?? [],
  };
}

/**
 * Guess a track's work on main. Never throws: a failed guess is an empty one.
 * Pass a shared `ctx` when guessing for several tracks of one project.
 */
export async function guessTrackWork(
  project: RegistryProject,
  trackName: string,
  ctx?: AttributionContext
): Promise<TrackGuess> {
  try {
    return await guess(ctx ?? (await attributionContext(project)), trackName);
  } catch (error) {
    logger.warn({ cwd: project.cwd, track: trackName, error: (error as Error).message }, 'attribution failed');
    return EMPTY;
  }
}

async function guess(ctx: AttributionContext, trackName: string): Promise<TrackGuess> {
  const cwd = ctx.project.cwd;
  const track = ctx.doc.tracks.find((t) => t.name === trackName);
  const featureIds = new Set((track ? featuresOf(track) : []).map((f) => f.id));

  const fromLog = new Set<string>();
  for (const g of ctx.phaseGroups) {
    if (g.group !== trackName) continue;
    for (const it of g.items) for (const id of it.sessionIds) fromLog.add(id);
  }
  if (featureIds.size === 0 && fromLog.size === 0) return EMPTY;

  const sessions = ctx.transcripts.filter(
    (s) => fromLog.has(s.sessionId) || [...s.docIds].some((id) => featureIds.has(id))
  );
  if (sessions.length === 0) return EMPTY;

  // Paths they wrote, inside the project, minus the planning documents.
  const logName = key(getConfig().projectLog.fileName);
  const excluded = (rel: string): boolean => {
    const k = key(rel);
    return k === key(ctx.docRel) || k.startsWith('project/') || k === logName;
  };
  const written = new Map<string, string>(); // key -> rel
  for (const s of sessions) {
    for (const abs of s.written) {
      const rel = toRel(cwd, abs);
      if (rel && !excluded(rel)) written.set(key(rel), rel);
    }
  }
  if (written.size === 0) return { sessions: sessions.map((s) => s.sessionId), files: [], commits: [] };

  // Still dirty on main right now.
  const files: GuessedFile[] = [];
  for (const e of ctx.status) {
    const rel = e.path.replace(/\\/g, '/').replace(/\/$/, '');
    if (!written.has(key(rel))) continue;
    files.push({
      path: rel,
      status: e.untracked ? 'untracked' : existsSync(join(cwd, rel)) ? 'modified' : 'deleted',
    });
  }

  // First-parent commits in a session's window touching a written path.
  // First-parent: a job's commits live on its merged branch, not main's line.
  const paths = [...written.values()];
  const commits = new Map<string, GuessedCommit>();
  for (const s of sessions) {
    if (s.firstAt === null || s.lastAt === null) continue;
    const out = await git(cwd, [
      'log',
      '--first-parent',
      '--no-merges',
      '--format=%H%x09%s',
      `--since=@${Math.floor(s.firstAt / 1000)}`,
      `--until=@${Math.ceil(s.lastAt / 1000) + 60}`,
      'HEAD',
      '--',
      ...paths,
    ]);
    for (const line of (out ?? '').split('\n')) {
      const tab = line.indexOf('\t');
      if (tab > 0) commits.set(line.slice(0, tab), { sha: line.slice(0, tab), subject: line.slice(tab + 1).trim() });
    }
  }

  return { sessions: sessions.map((s) => s.sessionId), files, commits: [...commits.values()] };
}

/** Test hook: forget the transcript cache. */
export function clearAttributionCache(): void {
  cache.clear();
  inflight.clear();
}
