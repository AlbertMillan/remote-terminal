/**
 * Strip the environment markers a parent `claude` process stamps onto its children.
 *
 * A server started from inside a claude-remote terminal inherits that
 * conversation's markers, and every PTY it then hands out silently skips saving
 * its transcript — breaking Fork, `--resume` history, take-over and SESSION-LOG
 * at once. Stripped at boot (`scrubProcessEnv`, which also covers `spawnClaude`)
 * and again at the PTY chokepoint. Story: `docs/windows-auto-start.md`.
 *
 * This list is a denylist of *session-scoped* markers and must never become a
 * `CLAUDE_*` wildcard: ANTHROPIC_API_KEY, CLAUDE_CONFIG_DIR,
 * CLAUDE_CODE_FORCE_SESSION_PERSISTENCE and CLAUDE_CODE_EXECPATH are the user's
 * own settings and have to survive into the terminal untouched.
 */
export const INHERITED_CLAUDE_SESSION_VARS = [
  /** The marker that turns transcript saving off. The reason this file exists. */
  'CLAUDE_CODE_CHILD_SESSION',
  /** "You are running inside Claude Code" -- false for a terminal we hand out. */
  'CLAUDECODE',
  /** The launching conversation's id; nothing here belongs to it. */
  'CLAUDE_CODE_SESSION_ID',
  'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDE_CODE_SESSION_ATTENDED',
  /** IPC back to the launching session -- a live handle to the wrong process. */
  'CLAUDE_CODE_MESSAGING_SOCKET',
  'CLAUDE_CODE_MESSAGING_TOKEN',
  'CLAUDE_PID',
  'CLAUDE_EFFORT',
  'AI_AGENT',
] as const;

/** A copy of `env` without the inherited session markers. Never mutates its input. */
export function withoutInheritedClaudeSession<T extends Record<string, string | undefined>>(
  env: T
): Record<string, string | undefined> {
  const clean: Record<string, string | undefined> = { ...env };
  for (const key of INHERITED_CLAUDE_SESSION_VARS) {
    delete clean[key];
  }
  return clean;
}

/** Which of the markers are actually present in `env`. */
export function inheritedClaudeSessionVars(env: Record<string, string | undefined>): string[] {
  return INHERITED_CLAUDE_SESSION_VARS.filter((key) => env[key] !== undefined);
}

/**
 * Remove the markers from `process.env` in place, and report which were there.
 *
 * A non-empty result means the server was started from inside a Claude Code
 * session -- worth logging, because that is the condition that used to produce
 * transcript-less terminals with no visible cause.
 */
export function scrubProcessEnv(env: NodeJS.ProcessEnv = process.env): string[] {
  const found = inheritedClaudeSessionVars(env);
  for (const key of found) {
    delete env[key];
  }
  return found;
}
