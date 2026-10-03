import { mkdirSync, unlinkSync, writeFileSync } from 'fs';
import { join } from 'path';
import { getConfig } from '../config.js';

/**
 * The prompt a started session is told to read (docs/session-orchestration.md).
 *
 * Under the data dir, never inside the worktree: there the next stage's
 * `commitAll` would sweep it into the track's branch. The server can only type
 * into the new session's shell, and a long multi-line prompt on that command
 * line breaks, so the command names this file instead.
 */

export function promptPathFor(sessionId: string): string {
  return join(getConfig().persistence.dataDir, 'prompts', `${sessionId}.md`);
}

export function writePromptFile(sessionId: string, prompt: string): string {
  const path = promptPathFor(sessionId);
  mkdirSync(join(getConfig().persistence.dataDir, 'prompts'), { recursive: true });
  writeFileSync(path, prompt, 'utf-8');
  return path;
}

/** Remove a session's prompt file, if it has one. Never throws. */
export function deletePromptFile(sessionId: string): void {
  try {
    unlinkSync(promptPathFor(sessionId));
  } catch {
    /* most sessions never had one */
  }
}
