import { existsSync, readdirSync, readFileSync } from 'fs';
import { join } from 'path';

const EDIT_TOOL_RE = /"name"\s*:\s*"(Edit|Write|MultiEdit|NotebookEdit)"/;

/** Read a transcript file into a string, returning '' if it can't be read. */
export function readTranscript(path: string): string {
  try {
    return readFileSync(path, 'utf-8');
  } catch {
    return '';
  }
}

/** True if the transcript contains any file-editing tool call. */
export function transcriptHasEdits(transcript: string): boolean {
  return EDIT_TOOL_RE.test(transcript);
}

/** Count user turns in a transcript (rough signal of session substance). */
export function countUserTurns(transcript: string): number {
  let count = 0;
  const re = /"type"\s*:\s*"user"/g;
  while (re.exec(transcript)) count++;
  return count;
}

/**
 * Robust JSONL location — tries the computed slug first, falls back to scanning
 * all project dirs. Claude Code derives its project folder by replacing path
 * separators with '-', but the exact algorithm may vary, so scanning by known
 * session ID is always correct. Throws if the transcript can't be found.
 */
export function findClaudeProjectDir(homeDir: string, cwd: string, claudeSessionId: string): string {
  const projectsDir = join(homeDir, '.claude', 'projects');
  const slug = cwd.replace(/[:\\/]/g, '-').replace(/^-+/, '');
  const computedDir = join(projectsDir, slug);
  if (existsSync(join(computedDir, `${claudeSessionId}.jsonl`))) {
    return computedDir;
  }
  try {
    const entries = readdirSync(projectsDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (existsSync(join(projectsDir, entry.name, `${claudeSessionId}.jsonl`))) {
        return join(projectsDir, entry.name);
      }
    }
  } catch {
    // projectsDir not readable
  }
  throw new Error(
    `Claude session transcript not found for session "${claudeSessionId}". ` +
    `Searched in ${projectsDir}. Ensure the claude-session hook is configured ` +
    `and Claude has stopped at least once in this terminal.`
  );
}

/**
 * Non-throwing transcript locator — returns the absolute path to the
 * `<claudeSessionId>.jsonl` transcript, or null if it can't be found.
 */
export function tryGetTranscriptPath(homeDir: string, cwd: string, claudeSessionId: string): string | null {
  try {
    const dir = findClaudeProjectDir(homeDir, cwd, claudeSessionId);
    return join(dir, `${claudeSessionId}.jsonl`);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Session-scoped scanning
//
// A transcript belongs to a CONVERSATION, not to one claude-remote session: a
// resumed conversation carries every turn it has ever had. Scanning the whole
// file therefore reports edits made days ago as if this session had made them,
// which is how a session that did nothing ends up logged as if it had worked.
// Every gate signal must be scoped to the window the session actually covers.
// ---------------------------------------------------------------------------

/** Most transcript lines carry an ISO timestamp; those that don't are ignored. */
const TIMESTAMP_RE = /"timestamp"\s*:\s*"([^"]+)"/;

export interface TranscriptWindow {
  /** Lines written at or after `sinceIso`. */
  lines: string[];
  /** Lines that carried no timestamp at all, so could not be placed. */
  undated: number;
}

/**
 * The slice of a transcript written at or after `sinceIso`.
 *
 * Undated lines are excluded rather than assumed recent: counting them would
 * reintroduce exactly the over-reporting this scoping exists to remove.
 */
export function transcriptSince(transcript: string, sinceIso: string): TranscriptWindow {
  const cutoff = Date.parse(sinceIso);
  if (Number.isNaN(cutoff)) {
    // No usable session start — fall back to the whole transcript rather than
    // silently reporting nothing, and let the caller's other signals decide.
    return { lines: transcript.split('\n').filter(Boolean), undated: 0 };
  }

  const lines: string[] = [];
  let undated = 0;
  for (const line of transcript.split('\n')) {
    if (!line) continue;
    const match = line.match(TIMESTAMP_RE);
    if (!match) {
      undated++;
      continue;
    }
    const at = Date.parse(match[1]);
    if (!Number.isNaN(at) && at >= cutoff) lines.push(line);
  }
  return { lines, undated };
}

/** True if the session's own slice of the transcript contains a file edit. */
export function transcriptHasEditsSince(transcript: string, sinceIso: string): boolean {
  return transcriptSince(transcript, sinceIso).lines.some((l) => EDIT_TOOL_RE.test(l));
}

/** User turns within the session's own slice of the transcript. */
export function countUserTurnsSince(transcript: string, sinceIso: string): number {
  return transcriptSince(transcript, sinceIso).lines.filter((l) => /"type"\s*:\s*"user"/.test(l))
    .length;
}
