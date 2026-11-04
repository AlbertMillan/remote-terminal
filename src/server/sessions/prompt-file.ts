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

/**
 * A started session's scoped MCP config (launch-profile.ts). Beside the prompt folder, not in
 * it: `--add-dir` opens that folder to the session without asking, and this file holds the
 * opted-in servers' keys.
 */
export function mcpConfigPathFor(sessionId: string): string {
  return join(getConfig().persistence.dataDir, 'mcp', `${sessionId}.json`);
}

/**
 * A read-only peer's `--settings` file (launch-profile.ts), denying edits in its worktree.
 * Under the data dir like the MCP config: in the worktree `commitAll` would sweep it in, and
 * in the prompt folder the session could rewrite its own rules.
 */
export function peerSettingsPathFor(sessionId: string): string {
  return join(getConfig().persistence.dataDir, 'peer-settings', `${sessionId}.json`);
}

/**
 * The notes folder a track's read-only peers share (project/builder-critic-pairs.md): their
 * references and findings ledger. Keyed by the track branch, so a revived or replacement
 * peer finds them; outside every project, so no `commitAll` sweeps it in and no `.gitignore`
 * is needed. Removed when the track is landed or deleted (deletePeerNotes).
 */
export function peerNotesDirFor(trackBranchId: string): string {
  return join(getConfig().persistence.dataDir, 'peers', trackBranchId);
}

/** Remove a track's peer notes folder, if it has one. Never throws. */
export function deletePeerNotes(trackBranchId: string): void {
  try {
    // Ids are server-generated, but never let one walk out of peers/.
    if (!/^[\w-]+$/.test(trackBranchId)) return;
    rmSync(peerNotesDirFor(trackBranchId), { recursive: true, force: true });
  } catch {
    /* most tracks never had peers */
  }
}

export function writePromptFile(sessionId: string, prompt: string): string {
  const path = promptPathFor(sessionId);
  mkdirSync(promptDirFor(sessionId), { recursive: true });
  writeFileSync(path, prompt, 'utf-8');
  return path;
}

/** Remove a session's prompt folder, MCP config and peer settings, if it has them. Never throws. */
export function deletePromptFile(sessionId: string): void {
  try {
    // Ids are server-generated UUIDs, but never let one walk out of prompts/.
    if (!/^[\w-]+$/.test(sessionId)) return;
    rmSync(promptDirFor(sessionId), { recursive: true, force: true });
    rmSync(mcpConfigPathFor(sessionId), { force: true });
    rmSync(peerSettingsPathFor(sessionId), { force: true });
  } catch {
    /* most sessions never had one */
  }
}
