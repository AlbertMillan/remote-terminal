import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { existsSync } from 'fs';
import { join } from 'path';
import { createLogger } from '../utils/logger.js';
import { isInside } from '../utils/paths.js';
import { replyWithError, type StatusError } from '../utils/http-errors.js';
import { sessionManager } from '../sessions/manager.js';
import { sessionForToken } from '../sessions/session-env.js';
import { writePromptFile } from '../sessions/prompt-file.js';
import { injectCommand } from '../sessions/session-open.js';
import type { ActiveSession, SessionCreateOptions, SessionMetadata } from '../sessions/types.js';
import { getSession as getSessionFromDb } from '../db/queries.js';
import { getConfig } from '../config.js';
import { notificationService, type NotificationType } from '../notifications/service.js';
import { broadcastSessionAdded, sessionToInfo } from '../websocket/connections.js';
import type { SessionInfo } from '../websocket/protocol.js';
import { loadRegistry, type RegistryProject } from '../projects/registry.js';
import { findWorkspaceProject, listBoardCwds } from '../projects/workspace.js';
import { readProjectPlan } from '../projects/project-plan.js';
import { ensureTrackBranch } from '../projects/track-branches.js';
import { listAllTrackBranches, trackBranchContaining, type TrackBranch } from '../projects/track-store.js';
import { isTrackError } from '../projects/routes.js';
import { installDependencies, needsInstall, type InstallResult } from '../projects/project-deps.js';

const logger = createLogger('agent-sessions');

/**
 * Sessions that start sessions (docs/session-orchestration.md).
 *
 * A main session's agent calls these through scripts/cr-session.mjs to start a
 * prompted session on one of its planned tracks, and to list the ones it
 * started. They start a shell and type into it, so unlike the rest of /api/*
 * they authenticate: the request must come from loopback AND carry the
 * calling session's in-memory token (sessionEnv()). Either alone is not
 * enough — the server listens on 0.0.0.0, and any local process can reach
 * loopback.
 */

/** `bypassPermissions` is deliberately absent: the user would have to read the flags to notice it. */
export const PERMISSION_MODES = ['default', 'acceptEdits', 'plan'] as const;
export type PermissionMode = (typeof PERMISSION_MODES)[number];

export const MAX_PROMPT_BYTES = 100 * 1024;
const MAX_NAME_LENGTH = 100;

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

export interface AgentSessionDeps {
  sessionForToken(token: string): string | null;
  getSession(id: string): SessionMetadata | null;
  listSessions(): (SessionMetadata & { attachable: boolean })[];
  projectForCwd(cwd: string): RegistryProject | null;
  trackExists(project: RegistryProject, track: string): boolean;
  /** Every track branch, read once per request to name each child's track. */
  trackBranches(): Pick<TrackBranch, 'worktreePath' | 'trackName'>[];
  ensureTrackBranch(project: RegistryProject, track: string): Promise<{ worktreePath: string }>;
  needsInstall(path: string): boolean;
  installDependencies(path: string): Promise<InstallResult>;
  createSession(options: SessionCreateOptions): Promise<ActiveSession>;
  deleteSession(id: string): Promise<unknown>;
  writePromptFile(sessionId: string, prompt: string): string;
  injectCommand(session: ActiveSession, line: string): void;
  lastNotification(id: string): { type: NotificationType; timestamp: Date } | undefined;
  broadcastAdded(session: SessionInfo): void;
  maxPerParent(): number;
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

/** Characters a double-quoted argument does not survive in cmd (`%`), PowerShell (`$`, backtick) or any shell (`"`). */
const UNSAFE_IN_QUOTES = /["%$`]/;

/** Still running: a PTY exists and its shell has not exited. */
function isLive(s: { attachable: boolean; status: string }): boolean {
  return s.attachable && s.status !== 'terminated';
}

function trackOf(branches: Pick<TrackBranch, 'worktreePath' | 'trackName'>[], cwd: string): string | null {
  return branches.find((b) => isInside(b.worktreePath, cwd))?.trackName ?? null;
}

export const defaultDeps: AgentSessionDeps = {
  sessionForToken,
  getSession: getSessionFromDb,
  listSessions: () => sessionManager.getSessionList(),
  projectForCwd,
  trackExists: (project, track) => readProjectPlan(project).doc.tracks.some((t) => t.name === track),
  trackBranches: listAllTrackBranches,
  ensureTrackBranch,
  needsInstall,
  installDependencies: (path) => installDependencies(path),
  createSession: (options) => sessionManager.createSession(options),
  deleteSession: (id) => sessionManager.deleteSession(id),
  writePromptFile,
  injectCommand,
  lastNotification: (id) => notificationService.getSessionNotification(id),
  broadcastAdded: broadcastSessionAdded,
  maxPerParent: () => getConfig().agentSessions.maxPerParent,
};

/** The calling session's id, or an error naming why the request is refused. */
export function authenticate(
  request: Pick<FastifyRequest, 'headers'> & { socket: { remoteAddress?: string } },
  deps: Pick<AgentSessionDeps, 'sessionForToken'>
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

export interface StartBody {
  track?: unknown;
  prompt?: unknown;
  name?: unknown;
  permissionMode?: unknown;
}

export interface StartResult {
  sessionId: string;
  name: string;
  worktreePath: string;
  install: InstallResult;
}

// Starts that have passed the limit check but not yet created their session
// (an install can take minutes). Counted toward the limit, or two concurrent
// starts would both pass it.
const pendingStarts = new Map<string, number>();
// The same, by caller and track: a start the agent gave up on (its Bash call
// timed out) keeps running here, and a retry must not start a second session.
const pendingTracks = new Set<string>();

function liveChildren(deps: AgentSessionDeps, parentId: string) {
  return deps.listSessions().filter((s) => s.spawnedBy === parentId && isLive(s));
}

export async function startAgentSession(
  deps: AgentSessionDeps,
  callerId: string,
  body: StartBody
): Promise<StartResult> {
  const caller = deps.getSession(callerId);
  if (!caller) throw new AgentSessionError(401, 'The calling session no longer exists');
  // One level only: keeps the sidebar to one level of nesting and stops a runaway chain.
  if (caller.spawnedBy) throw new AgentSessionError(403, 'A started session cannot start sessions');

  const children = liveChildren(deps, callerId);
  const limit = deps.maxPerParent();
  if (children.length + (pendingStarts.get(callerId) ?? 0) >= limit) {
    throw new AgentSessionError(429, `This session already has ${limit} started sessions running`);
  }

  const track = typeof body.track === 'string' ? body.track.trim() : '';
  if (!track) throw new AgentSessionError(400, 'track is required');
  if (typeof body.prompt !== 'string' || !body.prompt.trim()) {
    throw new AgentSessionError(400, 'prompt is required');
  }
  const prompt = body.prompt;
  if (Buffer.byteLength(prompt, 'utf-8') > MAX_PROMPT_BYTES) {
    throw new AgentSessionError(413, `prompt is over ${MAX_PROMPT_BYTES / 1024} KB`);
  }
  const mode = body.permissionMode === undefined ? 'default' : body.permissionMode;
  if (typeof mode !== 'string' || !(PERMISSION_MODES as readonly string[]).includes(mode)) {
    throw new AgentSessionError(400, `permissionMode must be one of: ${PERMISSION_MODES.join(', ')}`);
  }
  let name = track;
  if (body.name !== undefined) {
    if (typeof body.name !== 'string' || !body.name.trim()) throw new AgentSessionError(400, 'name must be a non-empty string');
    name = body.name.trim().slice(0, MAX_NAME_LENGTH);
  }

  const project = deps.projectForCwd(caller.cwd);
  if (!project) throw new AgentSessionError(400, `${caller.cwd} is not in a workspace project`);
  // The agent can only start work on a track somebody planned, never invent one.
  if (!deps.trackExists(project, track)) {
    throw new AgentSessionError(404, `No track "${track}" in ${project.cwd}'s PROJECT.md`);
  }

  // One live session per caller and track. Nothing between the limit check and
  // the bookkeeping below awaits, so concurrent starts cannot both get past it.
  const trackKey = `${callerId}\0${track}`;
  const branches = deps.trackBranches();
  const running = children.find((s) => trackOf(branches, s.cwd) === track);
  if (pendingTracks.has(trackKey) || running) {
    throw new AgentSessionError(
      409,
      running
        ? `This session already started "${running.name}" (${running.id}) on "${track}"; run list`
        : `A start on "${track}" from this session is still in progress; run list in a minute`
    );
  }

  pendingStarts.set(callerId, (pendingStarts.get(callerId) ?? 0) + 1);
  pendingTracks.add(trackKey);
  try {
    // Exactly what the Track picker does: branch, then the worktree's own install.
    const branch = await deps.ensureTrackBranch(project, track);
    const worktreePath = branch.worktreePath;
    let install: InstallResult = { ran: false, ok: true, detail: 'nothing to install' };
    if (deps.needsInstall(worktreePath)) {
      // A failed install still starts the session, as for a track session the
      // user opens; the response carries the failure for the agent to pass on.
      install = await deps.installDependencies(worktreePath);
    }

    let session: ActiveSession;
    try {
      session = await deps.createSession({
        name,
        cwd: worktreePath,
        ownerId: caller.ownerId ?? undefined,
        spawnedBy: callerId,
        permissionMode: mode,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/maximum session limit/i.test(message)) throw new AgentSessionError(429, message);
      throw error;
    }

    let promptPath: string;
    try {
      promptPath = deps.writePromptFile(session.id, prompt).replace(/\\/g, '/');
      if (UNSAFE_IN_QUOTES.test(promptPath)) {
        // A typed command that read the wrong file would fail silently.
        throw new AgentSessionError(500, `The prompt path ${promptPath} has a character no shell quotes safely`);
      }
    } catch (error) {
      await deps.deleteSession(session.id).catch(() => {});
      throw error;
    }

    // Forward slashes, so neither PowerShell nor bash reads a backslash as an escape.
    deps.injectCommand(session, `claude --permission-mode ${mode} "Read ${promptPath} and follow it."`);

    const metadata = deps.getSession(session.id);
    deps.broadcastAdded(
      sessionToInfo({
        ...session,
        ...(metadata ?? {}),
        attachable: true,
        spawnedBy: callerId,
        permissionMode: mode,
      })
    );

    logger.info({ callerId, sessionId: session.id, track, mode }, 'agent-sessions: started a session');
    return { sessionId: session.id, name, worktreePath, install };
  } finally {
    const left = (pendingStarts.get(callerId) ?? 1) - 1;
    if (left > 0) pendingStarts.set(callerId, left);
    else pendingStarts.delete(callerId);
    pendingTracks.delete(trackKey);
  }
}

export interface StartedSessionState {
  id: string;
  name: string;
  track: string | null;
  status: string;
  attachable: boolean;
  permissionMode: string | null;
  notification: { type: NotificationType; at: string } | null;
}

export function listAgentSessions(deps: AgentSessionDeps, callerId: string): StartedSessionState[] {
  const branches = deps.trackBranches();
  return deps
    .listSessions()
    .filter((s) => s.spawnedBy === callerId)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    .map((s) => {
      const n = deps.lastNotification(s.id);
      return {
        id: s.id,
        name: s.name,
        track: trackOf(branches, s.cwd),
        status: s.status,
        // Live, not merely "has a PTY object": a shell that exited keeps its PTY
        // entry until the user deletes it, and that child is done.
        attachable: isLive(s),
        permissionMode: s.permissionMode ?? null,
        notification: n ? { type: n.type, at: n.timestamp.toISOString() } : null,
      };
    });
}

function isKnownError(error: unknown): error is StatusError {
  return error instanceof AgentSessionError || isTrackError(error);
}

function sendError(reply: FastifyReply, error: unknown): unknown {
  return replyWithError(reply, error, { known: isKnownError, logger, message: 'agent-sessions: request failed' });
}

export function registerAgentSessionRoutes(app: FastifyInstance, deps: AgentSessionDeps = defaultDeps): void {
  app.post<{ Body?: StartBody }>('/api/agent/sessions', async (request, reply) => {
    try {
      const callerId = authenticate(request, deps);
      return await startAgentSession(deps, callerId, (request.body ?? {}) as StartBody);
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.get('/api/agent/sessions', async (request, reply) => {
    try {
      const callerId = authenticate(request, deps);
      return { sessions: listAgentSessions(deps, callerId) };
    } catch (error) {
      return sendError(reply, error);
    }
  });
}
