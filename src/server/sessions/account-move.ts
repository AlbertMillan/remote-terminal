/**
 * Moving a session's conversation to another account (project/move-conversation-account.md,
 * docs/accounts.md "Moving a conversation"). A transcript only resumes from its account's
 * folder, so the move is the files: `<id>.jsonl` and its `<id>/` folder (subagents) go into
 * the same project folder under the target's `projects/`, and the row's account follows.
 */
import { cpSync, existsSync, mkdirSync, renameSync, rmSync } from 'fs';
import { basename, dirname, join, resolve } from 'path';
import { findTranscript, isAccount, projectsDir } from '../accounts.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('account-move');

/** The fields of a session row the checks read. */
export interface ChangeAccountRow {
  account?: string | null;
  claudeSessionId?: string | null;
  isFork?: boolean | null;
  spawnedBy?: string | null;
}

/**
 * Why a row can never move, whatever the target, or null. Sent with every session row
 * (`SessionInfo.accountMoveBlocked`), so the header chip says it without re-deriving the
 * rules, as `revivable` does for the play button.
 */
export function moveBlockedReason(row: ChangeAccountRow): string | null {
  if (row.isFork) return 'A fork can’t move to another account: its transcript is removed on restart';
  // A started session runs under its caller's account (docs/accounts.md): moving one would
  // leave a session on one login directing work on another.
  if (row.spawnedBy) return 'Runs under the account of the session that started it. Move that session instead.';
  if (!row.claudeSessionId) return 'No Claude conversation to move yet';
  return null;
}

/**
 * Why the row can't move to `target` now, or null. Checked before anything stops, so a
 * refused move never costs the user their terminal. Running children are counted here
 * only: they start and stop without the parent's row being re-sent.
 */
export function changeAccountRefusal(row: ChangeAccountRow, target: string, runningChildren: number): string | null {
  if (!isAccount(target)) return `Unknown account "${target}"`;
  if (row.account === target) return `This session already runs under ${target}`;
  const blocked = moveBlockedReason(row);
  if (blocked) return blocked;
  if (runningChildren > 0) {
    return `This session has ${runningChildren} running started session${runningChildren === 1 ? '' : 's'}; stop or land ${runningChildren === 1 ? 'it' : 'them'} first`;
  }
  return null;
}

/** Claude's conversation ids; anything else would be joined into a path and renamed. */
const CONVERSATION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const RETRIES = 5;
const RETRY_MS = 300;

/** Retry a step that a just-exited Claude may still hold open on Windows. */
async function withRetry<T>(fn: () => T): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return fn();
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (attempt >= RETRIES || (code !== 'EBUSY' && code !== 'EPERM' && code !== 'EACCES')) throw error;
      await new Promise((r) => setTimeout(r, RETRY_MS * attempt));
    }
  }
}

/**
 * Rename, or across volumes copy (dates kept) and then delete the source. Each step is
 * retried on its own: retrying the whole move after a copy would find its own copy in the
 * way. A source that can't be deleted gets its copy removed, so a failure leaves exactly
 * one file, where it was, and the next move can run.
 */
async function moveEntry(from: string, to: string): Promise<void> {
  if (existsSync(to)) throw new Error(`${to} already exists`);
  try {
    await withRetry(() => renameSync(from, to));
    return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EXDEV') throw error;
  }
  try {
    cpSync(from, to, { recursive: true, preserveTimestamps: true, errorOnExist: true });
  } catch (copyError) {
    rmSync(to, { recursive: true, force: true });
    throw copyError;
  }
  try {
    await withRetry(() => rmSync(from, { recursive: true, force: true }));
  } catch (removeError) {
    rmSync(to, { recursive: true, force: true });
    throw removeError;
  }
}

function sameDir(a: string, b: string): boolean {
  const norm = (p: string) => (process.platform === 'win32' ? resolve(p).toLowerCase() : resolve(p));
  return norm(a) === norm(b);
}

/**
 * Move a conversation's transcript into `to`'s folder. Returns the folders it moved between,
 * or null when it already was there (only the row needs repointing). Throws, with nothing
 * moved, when there is no transcript or a step fails; a rollback that fails too is named in
 * the error, with where the transcript now is.
 */
export async function moveTranscript(
  cwd: string,
  claudeSessionId: string,
  from: string | null | undefined,
  to: string,
  home?: string
): Promise<{ fromDir: string; toDir: string } | null> {
  if (!CONVERSATION_ID.test(claudeSessionId)) throw new Error(`Not a conversation id: ${claudeSessionId}`);
  const found = findTranscript(cwd, claudeSessionId, from, home);
  if (!found) throw new Error('The conversation transcript was not found in any account');
  if (found.account === to) return null;
  const fromDir = dirname(found.path);
  const toDir = join(projectsDir(to, home), basename(fromDir));
  if (sameDir(fromDir, toDir)) return null; // two accounts sharing one folder

  mkdirSync(toDir, { recursive: true });
  const file = `${claudeSessionId}.jsonl`;
  await moveEntry(join(fromDir, file), join(toDir, file));
  if (existsSync(join(fromDir, claudeSessionId))) {
    try {
      await moveEntry(join(fromDir, claudeSessionId), join(toDir, claudeSessionId));
    } catch (error) {
      // Keep the pair together: a resume reads the subagent folder beside the transcript.
      try {
        await moveEntry(join(toDir, file), join(fromDir, file));
      } catch (rollbackError) {
        logger.error({ error, rollbackError, at: join(toDir, file) }, 'account-move: rollback failed');
        const reason = error instanceof Error ? error.message : String(error);
        throw new Error(`${reason}; the transcript could not be put back and is at ${join(toDir, file)}`);
      }
      throw error;
    }
  }
  return { fromDir, toDir };
}
