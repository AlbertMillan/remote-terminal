import { mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { getConfig } from '../config.js';

/**
 * The prompt a started session is told to read (docs/session-orchestration.md).
 *
 * Under the data dir, never inside the worktree: there the next stage's
 * `commitAll` would sweep it into the track's branch. The server can only type
 * into the new session's shell, and a long multi-line prompt on that command
 * line breaks, so the command names this file instead.
 *
 * Each session gets a folder of its own, which the typed command passes to
 * `--add-dir`: the session reads its prompt without asking, and no other
 * session's.
 */

export function promptDirFor(sessionId: string): string {
  return join(getConfig().persistence.dataDir, 'prompts', sessionId);
}

export function promptPathFor(sessionId: string): string {
  return join(promptDirFor(sessionId), 'prompt.md');
}

export function writePromptFile(sessionId: string, prompt: string): string {
  const path = promptPathFor(sessionId);
  mkdirSync(promptDirFor(sessionId), { recursive: true });
  writeFileSync(path, prompt, 'utf-8');
  return path;
}

/** Remove a session's prompt folder, if it has one. Never throws. */
export function deletePromptFile(sessionId: string): void {
  try {
    // Ids are server-generated UUIDs, but never let one walk out of prompts/.
    if (!/^[\w-]+$/.test(sessionId)) return;
    rmSync(promptDirFor(sessionId), { recursive: true, force: true });
  } catch {
    /* most sessions never had one */
  }
}
