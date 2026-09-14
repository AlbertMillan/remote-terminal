/**
 * Strip the environment markers a parent `claude` process stamps onto its children.
 *
 * Claude Code sets `CLAUDE_CODE_CHILD_SESSION=1` (plus a handful of other
 * session-scoped variables) on every subprocess it spawns, so that a *nested*
 * `claude` knows it is not the top-level session and does not write a transcript
 * over its parent's. That is right for a nested invocation and wrong for us: the
 * server hands out interactive terminals, and a `claude` started in one is a
 * top-level session of its own.
 *
 * The markers reach the server whenever it is started from inside a claude-remote
 * terminal -- which is exactly how restart-server.ps1 is meant to be used. The VBS
 * launcher detaches the *process tree*, so the restart survives the session that
 * asked for it, but a detached process still inherits the *environment*. From
 * there `createPty` spreads `process.env` into every PTY and the whole server
 * hands out sessions that refuse to save transcripts, which quietly breaks Fork
 * (it copies the JSONL), `--resume` history, job take-over, and SESSION-LOG
 * generation.
 *
 * So the markers are removed from `process.env` once at boot (`scrubProcessEnv`),
 * which also covers `spawnClaude` in agent/claude-run.ts since it inherits the
 * server's environment implicitly, and again at the PTY chokepoint so a terminal
 * is clean regardless of what the server process picked up.
 *
 * This is a denylist of *session-scoped* markers, deliberately not a `CLAUDE_*`
 * wildcard: variables a user sets for themselves (ANTHROPIC_API_KEY,
 * CLAUDE_CONFIG_DIR, CLAUDE_CODE_FORCE_SESSION_PERSISTENCE, their own `CLAUDE`
 * path entry) must survive into the terminal untouched. CLAUDE_CODE_EXECPATH
 * survives too -- it points at the `claude` binary, not at a conversation.
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
