import type { FastifyRequest } from 'fastify';
import { existsSync } from 'fs';
import { join } from 'path';
import { createLogger } from '../utils/logger.js';
import { isInside } from '../utils/paths.js';
import { loadRegistry, type RegistryProject } from '../projects/registry.js';
import { findWorkspaceProject, listBoardCwds } from '../projects/workspace.js';
import { trackBranchContaining } from '../projects/track-store.js';

/** What every agent route shares: its error, its one guard, and which project a session is in. */

const logger = createLogger('agent-sessions');

// IPv4-mapped 127.0.0.1 is the same address, seen when the server binds `::`.
const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

export class AgentSessionError extends Error {
  constructor(
    public readonly status: number,
    message: string
  ) {
    super(message);
  }
}

/**
 * The workspace project a session's cwd belongs to: its main checkout or one
 * of its track worktrees, or a folder below either. Null for anything else.
 *
 * A project *above* the cwd only counts when it has a plan file. Discovery
 * lists every folder Claude ever ran in — the home folder included — and
 * taking that as the project would answer "no such track" to a session that
 * is simply in no project.
 */
export function projectForCwd(cwd: string): RegistryProject | null {
  const branch = trackBranchContaining(cwd);
  const target = branch ? branch.projectCwd : cwd;
  let candidates: string[];
  try {
    const registry = loadRegistry();
    candidates = [...registry.projects.map((p) => p.cwd), ...listBoardCwds(registry)];
  } catch (error) {
    logger.warn({ error }, 'agent-sessions: could not read the project registry');
    return null;
  }
  // Deepest first: a project nested in another's folder is its own project.
  const containing = candidates.filter((c) => isInside(c, target)).sort((a, b) => b.length - a.length);
  for (const c of containing) {
    const project = findWorkspaceProject(c);
    if (!project) continue;
    if (isInside(target, c) || existsSync(join(project.cwd, project.doc ?? 'PROJECT.md'))) return project;
  }
  return null;
}

/** The calling session's id, or an error naming why the request is refused. */
export function authenticate(
  request: Pick<FastifyRequest, 'headers'> & { socket: { remoteAddress?: string } },
  deps: { sessionForToken(token: string): string | null }
): string {
  // The socket's address only: X-Forwarded-For is whatever the client wrote.
  if (!LOOPBACK.has(request.socket.remoteAddress ?? '')) {
    throw new AgentSessionError(403, 'Agent-session routes answer only on loopback');
  }
  const header = request.headers.authorization;
  const match = typeof header === 'string' ? /^Bearer\s+(\S+)$/.exec(header) : null;
  const caller = match ? deps.sessionForToken(match[1]) : null;
  if (!caller) throw new AgentSessionError(401, 'Missing or unknown session token');
  return caller;
}
