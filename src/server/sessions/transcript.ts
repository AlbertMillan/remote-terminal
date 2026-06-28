import { existsSync, readdirSync } from 'fs';
import { join } from 'path';

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
