import { randomBytes } from 'crypto';
import { join } from 'path';
import { getConfig } from '../config.js';

/**
 * The environment every session PTY gets, and the per-PTY token behind it
 * (docs/session-orchestration.md).
 *
 * Every createPty site goes through sessionEnv(). A site that builds its own
 * env is a session whose agent cannot use the CLI, and whose notifications
 * point nowhere.
 *
 * The token is the only credential the agent-sessions API accepts. It lives in
 * this Map and nowhere else: never the database, the logs or the scrollback.
 * A restart therefore invalidates every token, and a revived session — a new
 * PTY — gets a new one.
 */

const tokens = new Map<string, string>(); // token -> session id
const tokenOf = new Map<string, string>(); // session id -> its live token

let serverUrl: string | null = null;
let cliPath: string | null = null;

/**
 * Where the sessions find this server and its CLI. Set once at boot by
 * app.ts, which knows the protocol and the install's root.
 */
export function configureSessionEnv(opts: { url: string; cliPath: string }): void {
  serverUrl = opts.url;
  cliPath = opts.cliPath;
}

/**
 * The URL a process on this machine reaches the server at. Loopback, because
 * the agent-sessions routes refuse anything else; a wildcard bind is reachable
 * there, a specific host is used as configured.
 */
export function loopbackUrl(protocol: 'http' | 'https', host: string, port: number): string {
  const wildcard = host === '0.0.0.0' || host === '::' || host === '';
  // A Tailscale certificate names the machine, not 127.0.0.1; `localhost` at
  // least reads right in the CLI's TLS error.
  const h = wildcard ? (protocol === 'https' ? 'localhost' : '127.0.0.1') : host.includes(':') ? `[${host}]` : host;
  return `${protocol}://${h}:${port}`;
}

// Before app.ts has configured it (tests, a manager used on its own).
function defaultUrl(): string {
  const { server, tls } = getConfig();
  return loopbackUrl(tls?.enabled ? 'https' : 'http', server?.host ?? '0.0.0.0', server?.port ?? 4220);
}

/**
 * The env for a new PTY of session `id`. Issues a fresh token and revokes the
 * session's previous one, so a token never outlives its PTY.
 */
export function sessionEnv(id: string): Record<string, string> {
  revokeSessionToken(id);
  const token = randomBytes(32).toString('hex');
  tokens.set(token, id);
  tokenOf.set(id, token);
  return {
    CLAUDE_REMOTE_SESSION_ID: id,
    CLAUDE_REMOTE_TOKEN: token,
    CLAUDE_REMOTE_URL: serverUrl ?? defaultUrl(),
    CLAUDE_REMOTE_CLI: cliPath ?? join(process.cwd(), 'scripts', 'cr-session.mjs'),
  };
}

/** The session a token belongs to, or null when it is unknown or its PTY is gone. */
export function sessionForToken(token: string | undefined | null): string | null {
  if (!token) return null;
  return tokens.get(token) ?? null;
}

/** Forget a session's token: its PTY exited, was killed, or is being replaced. */
export function revokeSessionToken(id: string): void {
  const token = tokenOf.get(id);
  if (token === undefined) return;
  tokens.delete(token);
  tokenOf.delete(id);
}

/** Forget every token (shutdown: every PTY is going away). */
export function revokeAllSessionTokens(): void {
  tokens.clear();
  tokenOf.clear();
}
