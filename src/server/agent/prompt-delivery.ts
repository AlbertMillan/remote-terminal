import { closeSync, openSync, readdirSync, readSync, statSync } from 'fs';
import { join } from 'path';
import { tryGetTranscriptPath } from '../sessions/transcript.js';
import { defaultAccount, projectsDir } from '../accounts.js';

/**
 * Did a started session's agent get its prompt? (docs/session-orchestration.md)
 *
 * The server types `claude … -- "Read <prompts>/<id>/prompt.md and follow it."`
 * and learns nothing more until a turn ends. A session whose prompt never
 * arrived — a flag that ate it, a startup dialog, a line typed too early —
 * looks exactly like one that is working, so its parent waits forever.
 *
 * The evidence: Claude writes no transcript until its first message, and that
 * message, when it is our prompt, names this session's prompt file. So a user
 * line naming `<id>/prompt.md` in a transcript from this session's folder is
 * proof; none after a grace period is a failure. A message sent later (a
 * cross-session message, the user typing) never names that file, so it is
 * never mistaken for the prompt.
 */

export type PromptState = 'pending' | 'received' | 'not-received';

export interface PromptDelivery {
  state: PromptState;
  /** Why it is `not-received`: what the server could and couldn't see. */
  detail?: string;
}

/** Long enough for Claude to start with every MCP server, short enough to matter. */
export const PROMPT_GRACE_MS = 90_000;

/** A transcript's first user turn is near its start; never read a whole long one. */
const READ_LIMIT = 256 * 1024;

/** Claude Code's folder under an account's projects folder: every non-alphanumeric becomes `-`. */
export function claudeProjectSlug(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, '-');
}

function readHead(path: string): string {
  let fd: number | null = null;
  try {
    fd = openSync(path, 'r');
    const buf = Buffer.alloc(READ_LIMIT);
    const n = readSync(fd, buf, 0, READ_LIMIT, 0);
    return buf.subarray(0, n).toString('utf-8');
  } catch {
    return '';
  } finally {
    if (fd !== null) closeSync(fd);
  }
}

/** True if a user line in the text names this session's prompt file, whichever way its slashes go. */
export function namesPrompt(transcript: string, sessionId: string): boolean {
  const file = new RegExp(`${sessionId}(?:/|\\\\{1,2})prompt\\.md`);
  return transcript.split('\n').some((line) => /"type"\s*:\s*"user"/.test(line) && file.test(line));
}

/**
 * The transcripts that could hold the session's first turn: the one its
 * claude-session hook registered, and any in its cwd's folder written since it
 * was created (the hook may not be installed, or may not have run yet).
 */
function candidateTranscripts(
  projects: string,
  session: { cwd: string; createdAt: string; claudeSessionId: string | null }
): string[] {
  const paths = new Set<string>();
  if (session.claudeSessionId) {
    const registered = tryGetTranscriptPath(projects, session.cwd, session.claudeSessionId);
    if (registered) paths.add(registered);
  }
  const dir = join(projects, claudeProjectSlug(session.cwd));
  const since = Date.parse(session.createdAt);
  try {
    for (const name of readdirSync(dir)) {
      if (!name.endsWith('.jsonl')) continue;
      const path = join(dir, name);
      try {
        if (Number.isNaN(since) || statSync(path).mtimeMs >= since) paths.add(path);
      } catch {
        /* gone meanwhile */
      }
    }
  } catch {
    /* no folder: Claude has written nothing here */
  }
  return [...paths];
}

/** `projects` is the session's account's projects folder (accounts.ts), where its `claude` writes. */
export function promptDelivery(
  session: { id: string; cwd: string; createdAt: string; claudeSessionId: string | null; account?: string },
  now: number = Date.now(),
  projects: string = projectsDir(session.account ?? defaultAccount())
): PromptDelivery {
  if (candidateTranscripts(projects, session).some((p) => namesPrompt(readHead(p), session.id))) {
    return { state: 'received' };
  }
  const age = now - Date.parse(session.createdAt);
  if (!(age >= PROMPT_GRACE_MS)) return { state: 'pending' };
  return {
    state: 'not-received',
    detail: session.claudeSessionId
      ? 'Claude started, but the prompt never reached it'
      : 'No Claude session registered in it: Claude may never have started (or the claude-session hook is not installed)',
  };
}
