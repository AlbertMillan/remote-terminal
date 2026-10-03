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
import { broadcastLandResult, broadcastSessionAdded, removeWorktreeSessions, sessionToInfo } from '../websocket/connections.js';
import type { LandNotificationPayload, SessionInfo } from '../websocket/protocol.js';
import { loadRegistry, type RegistryProject } from '../projects/registry.js';
import { findWorkspaceProject, listBoardCwds } from '../projects/workspace.js';
import { readProjectPlan } from '../projects/project-plan.js';
import { ensureTrackBranch } from '../projects/track-branches.js';
import { landAndBuild, landPreflightForSession } from '../projects/track-land.js';
import { pathKey } from '../sessions/project-discovery.js';
import { listAllTrackBranches, trackBranchContaining, type TrackBranch } from '../projects/track-store.js';
import { isTrackError } from '../projects/routes.js';
import { installDependencies, needsInstall, type InstallResult } from '../projects/project-deps.js';
import { ensureLocalClaudeSettings } from '../projects/local-claude-settings.js';

const logger = createLogger('agent-sessions');

/**
 * Sessions that start sessions (docs/session-orchestration.md).
 *
 * A main session's agent calls these through scripts/cr-session.mjs to start a
 * prompted session on one of its planned tracks, and to list the ones it
 * started; a track's session calls the land route to land its own track.
 * They start a shell and type into it, or close sessions, so unlike the rest of /api/*
 * they authenticate: the request must come from loopback AND carry the
 * calling session's in-memory token (sessionEnv()). Either alone is not
 * enough — the server listens on 0.0.0.0, and any local process can reach
 * loopback.
 */

/**
 * `bypassPermissions` is deliberately absent: the user would have to read the
 * flags to notice it. So is `dontAsk`: it denies whatever isn't pre-allowed, so
 * a session would fail quietly instead of asking. `auto` is the default — a
 * started session exists to run unattended, and auto still asks before risky
 * actions (project/unattended-started-sessions.md).
 */
export const PERMISSION_MODES = ['auto', 'manual', 'acceptEdits', 'plan'] as const;
export type PermissionMode = (typeof PERMISSION_MODES)[number];
export const DEFAULT_PERMISSION_MODE: PermissionMode = 'auto';

/** Older names still sent by a skill copy installed before `manual` existed. */
const MODE_ALIASES: Record<string, PermissionMode> = { default: 'manual' };

/**
 * The typed command. `manual` passes no `--permission-mode`: Claude Code has
 * renamed its default (it lists `manual`, no longer `default`), and leaving the
 * flag out gets the default under either name. `--add-dir` is the session's own
 * prompt folder only, so it reads its prompt without asking and no other's.
 */
export function startCommand(mode: PermissionMode, promptDir: string, promptPath: string): string {
  const flag = mode === 'manual' ? '' : `--permission-mode ${mode} `;
  return `claude ${flag}--add-dir "${promptDir}" "Read ${promptPath} and follow it."`;
}

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
  ensureLocalClaudeSettings(projectCwd: string, worktreePath: string): Promise<unknown>;
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
  ensureLocalClaudeSettings,
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
  const asked = body.permissionMode === undefined ? DEFAULT_PERMISSION_MODE : body.permissionMode;
  const mode = typeof asked === 'string' ? (MODE_ALIASES[asked] ?? asked) : asked;
  if (typeof mode !== 'string' || !(PERMISSION_MODES as readonly string[]).includes(mode)) {
    throw new AgentSessionError(400, `permissionMode must be one of: ${PERMISSION_MODES.join(', ')}`);
  }
  const permissionMode = mode as PermissionMode;
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
    // Before the session exists: Claude reads it at startup, and without it
    // the session asks again for every MCP server the user already approved.
    await deps.ensureLocalClaudeSettings(project.cwd, worktreePath);

    let session: ActiveSession;
    try {
      session = await deps.createSession({
        name,
        cwd: worktreePath,
        ownerId: caller.ownerId ?? undefined,
        spawnedBy: callerId,
        permissionMode,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/maximum session limit/i.test(message)) throw new AgentSessionError(429, message);
      throw error;
    }

    let promptPath: string;
    let promptDir: string;
    try {
      // Forward slashes, so neither PowerShell nor bash reads a backslash as an escape.
      promptPath = deps.writePromptFile(session.id, prompt).replace(/\\/g, '/');
      promptDir = promptPath.slice(0, promptPath.lastIndexOf('/'));
      if (UNSAFE_IN_QUOTES.test(promptPath)) {
        // A typed command that read the wrong file would fail silently.
        throw new AgentSessionError(500, `The prompt path ${promptPath} has a character no shell quotes safely`);
      }
    } catch (error) {
      await deps.deleteSession(session.id).catch(() => {});
      throw error;
    }

    deps.injectCommand(session, startCommand(permissionMode, promptDir, promptPath));

    const metadata = deps.getSession(session.id);
    deps.broadcastAdded(
      sessionToInfo({
        ...session,
        ...(metadata ?? {}),
        attachable: true,
        spawnedBy: callerId,
        permissionMode,
      })
    );

    logger.info({ callerId, sessionId: session.id, track, mode: permissionMode }, 'agent-sessions: started a session');
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
        // Rows started before `manual` existed are stored as `default`.
        permissionMode: s.permissionMode ? (MODE_ALIASES[s.permissionMode] ?? s.permissionMode) : null,
        notification: n ? { type: n.type, at: n.timestamp.toISOString() } : null,
      };
    });
}

// --- Land ------------------------------------------------------------------

/**
 * What a session's own Land needs. Separate from AgentSessionDeps: none of it
 * starts a session, and Land's side lives in the projects module.
 */
export interface AgentLandDeps {
  getSession(id: string): SessionMetadata | null;
  /** The unlanded track whose worktree holds `cwd`, or null. */
  trackBranchFor(cwd: string): TrackBranch | null;
  projectForCwd(cwd: string): RegistryProject | null;
  /** Phase 1: every Land refusal that needs no session closed, plus a conflicting merge. */
  preflight(project: RegistryProject, trackName: string): Promise<void>;
  /** Phase 2: close the worktree's sessions, land under the lock, rebuild. */
  land(project: RegistryProject, trackName: string): Promise<{ detail: string }>;
  notify(payload: LandNotificationPayload): void;
}

export const defaultLandDeps: AgentLandDeps = {
  getSession: getSessionFromDb,
  trackBranchFor: (cwd) => {
    const branch = trackBranchContaining(cwd);
    return branch && branch.landedAt === null ? branch : null;
  },
  projectForCwd,
  preflight: landPreflightForSession,
  land: (project, trackName) =>
    landAndBuild(project, trackName, {
      sessions: sessionManager.getRunningSessions().map((s) => ({ id: s.id, cwd: s.cwd })),
      terminateSession: (id) => sessionManager.terminateSession(id),
      removeSessions: removeWorktreeSessions,
    }),
  notify: broadcastLandResult,
};

export interface AcceptedLand {
  project: RegistryProject;
  track: string;
}

// Lands accepted and not yet finished, by project and track. Phase 1 releases
// the project lock before its reply and phase 2 takes it only once the reply
// is out, so without this a second request in that gap (an agent retrying,
// two sessions in one worktree) passes phase 1 too — and its Land, failing
// with "no branch to land", replaces the first one's success on screen.
const landsUnderWay = new Set<string>();
const landKey = (project: RegistryProject, track: string) => `${pathKey(project.cwd)}\0${track}`;

/** Forget an accepted Land that will never run (its request was aborted before the reply). */
export function dropAcceptedLand(accepted: AcceptedLand): void {
  landsUnderWay.delete(landKey(accepted.project, accepted.track));
}

/**
 * Phase 1 of a session's Land, inside the request. The track is the one whose
 * worktree the CALLER is in — never named by the request — so a session can
 * land only its own track, and an orchestrator can't land a child's. Every
 * refusal reaches the agent while it is still running.
 */
export async function requestLand(deps: AgentLandDeps, callerId: string): Promise<AcceptedLand> {
  const caller = deps.getSession(callerId);
  if (!caller) throw new AgentSessionError(401, 'The calling session no longer exists');
  const branch = deps.trackBranchFor(caller.cwd);
  if (!branch) throw new AgentSessionError(400, "This session isn't in a track's worktree");
  const project = deps.projectForCwd(caller.cwd);
  if (!project || pathKey(project.cwd) !== pathKey(branch.projectCwd)) {
    throw new AgentSessionError(400, `${caller.cwd} is not in a workspace project`);
  }
  const key = landKey(project, branch.trackName);
  if (landsUnderWay.has(key)) {
    throw new AgentSessionError(409, `A Land of "${branch.trackName}" is already under way; its result comes as a notification`);
  }
  await deps.preflight(project, branch.trackName);
  // Again after the await, in case another request was accepted meanwhile.
  if (landsUnderWay.has(key)) {
    throw new AgentSessionError(409, `A Land of "${branch.trackName}" is already under way; its result comes as a notification`);
  }
  landsUnderWay.add(key);
  return { project, track: branch.trackName };
}

/**
 * Phase 2, after the 202 has gone out: Land (which closes the worktree's
 * sessions, the caller included, before it merges) and say how it went. It
 * never throws — the caller is gone, so the notification is the answer.
 */
export async function runRequestedLand(deps: AgentLandDeps, accepted: AcceptedLand): Promise<void> {
  const { project, track } = accepted;
  let ok = false;
  let detail: string;
  try {
    detail = (await deps.land(project, track)).detail;
    ok = true;
    logger.info({ cwd: project.cwd, track }, 'agent-sessions: session-requested land done');
  } catch (error) {
    detail = `Landing "${track}" failed: ${error instanceof Error ? error.message : String(error)}`;
    logger.warn({ cwd: project.cwd, track, error: detail }, 'agent-sessions: session-requested land failed');
  } finally {
    dropAcceptedLand(accepted);
  }
  try {
    deps.notify({ kind: 'land', projectCwd: project.cwd, track, ok, detail, timestamp: new Date().toISOString() });
  } catch (error) {
    logger.warn({ error }, 'agent-sessions: could not send the land result');
  }
}

function isKnownError(error: unknown): error is StatusError {
  return error instanceof AgentSessionError || isTrackError(error);
}

function sendError(reply: FastifyReply, error: unknown): unknown {
  return replyWithError(reply, error, { known: isKnownError, logger, message: 'agent-sessions: request failed' });
}

export function registerAgentSessionRoutes(
  app: FastifyInstance,
  deps: AgentSessionDeps = defaultDeps,
  landDeps: AgentLandDeps = defaultLandDeps
): void {
  // Phase 2 of each accepted Land, run once its 202 has been sent: the Land
  // closes the session that asked, and its agent must have its answer first.
  const acceptedLands = new WeakMap<FastifyRequest, AcceptedLand>();
  app.post(
    '/api/agent/land',
    {
      onResponse: async (request) => {
        const accepted = acceptedLands.get(request);
        if (!accepted) return;
        acceptedLands.delete(request);
        void runRequestedLand(landDeps, accepted);
      },
      // The agent went away before its answer: never land behind its back, and
      // don't leave the track marked as under way.
      onRequestAbort: async (request) => {
        const accepted = acceptedLands.get(request);
        if (!accepted) return;
        acceptedLands.delete(request);
        dropAcceptedLand(accepted);
      },
    },
    async (request, reply) => {
      try {
        const callerId = authenticate(request, deps);
        const accepted = await requestLand(landDeps, callerId);
        acceptedLands.set(request, accepted);
        return reply.code(202).send({
          accepted: true,
          track: accepted.track,
          detail: `Land of "${accepted.track}" accepted; this session will close. The result is sent as a notification.`,
        });
      } catch (error) {
        return sendError(reply, error);
      }
    }
  );

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
