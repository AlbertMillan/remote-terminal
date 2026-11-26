import type { FastifyInstance, FastifyReply } from 'fastify';
import { createLogger } from '../utils/logger.js';
import { pathKey } from '../utils/paths.js';
import { replyWithError, type StatusError } from '../utils/http-errors.js';
import { AccountRefusedError } from '../accounts.js';
import { sessionManager } from '../sessions/manager.js';
import { sessionForToken } from '../sessions/session-env.js';
import { injectCommand } from '../sessions/session-open.js';
import { writePromptFile } from '../sessions/prompt-file.js';
import { getSession as getSessionFromDb } from '../db/queries.js';
import type { SessionMetadata } from '../sessions/types.js';
import { broadcastSessionAdded, broadcastSessionRow, detachViewers, sessionToInfo } from '../websocket/connections.js';
import { AgentSessionError, authenticate, projectForCwd } from '../agent/agent-common.js';
import type { RegistryProject } from '../projects/registry.js';
import { findWorkspaceProject } from '../projects/workspace.js';
import { trackBranchContaining } from '../projects/track-store.js';
import { itemsClaimedBy } from './store.js';
import { sessionOwner } from './session-claims.js';
import {
  baseTakeoverDeps,
  ClaimError,
  releaseSessionClaim,
  takeOver,
  trackUnit,
  type TakeoverDeps,
} from './takeover.js';
import { isTrackWorkflow } from './templates.js';

const logger = createLogger('factory-session-routes');

/**
 * Sessions claiming factory units over HTTP (takeover.ts):
 *
 * - the board, behind the access gate like every `/api/*` route:
 *   POST /api/factory/items/:featureId/take | return | done, with `{ cwd }`;
 * - sessions (`cr factory take|return|done`), on loopback with the caller's
 *   token (`authenticate()`): `/api/agent/factory/take|return|done`, with
 *   `{ target }` — a feature id or a track name; return and done default to
 *   what the caller holds.
 *
 * A take-over opens a NEW session, like history Resume, on a row of the user's
 * own; so a started session cannot take over (started sessions cannot start
 * sessions). Return and Done from a session release only a claim the caller
 * holds, or one a session it started holds.
 */

export function sessionTakeoverDeps(): TakeoverDeps {
  return {
    ...baseTakeoverDeps(),
    async openShell({ name, cwd, account, ownerId }) {
      const session = await sessionManager.createSession({ name, cwd, account, ownerId });
      return { id: session.id, name: session.name, type: (line) => injectCommand(session, line) };
    },
    deleteSession: (id) => sessionManager.deleteSession(id),
    writePromptFile,
    claudeSessionOf: (id) => getSessionFromDb(id)?.claudeSessionId ?? null,
    sessionName: (id) => getSessionFromDb(id)?.name ?? null,
    isSessionRunning: (id) => sessionManager.isRunning(id),
    async stopSession(id) {
      // As the sidebar's Stop does: its browsers detached just before the kill, every sidebar told.
      try {
        await sessionManager.stopSession(id, { beforeKill: (sid) => detachViewers([sid]) });
      } finally {
        broadcastSessionRow(id);
      }
    },
    announce(id) {
      const row = getSessionFromDb(id);
      if (row) broadcastSessionAdded(sessionToInfo({ ...row, attachable: true }));
    },
  };
}

export interface SessionRouteDeps {
  takeover(): TakeoverDeps;
  findProject(cwd: string): RegistryProject | null;
  projectForCwd(cwd: string): RegistryProject | null;
  sessionForToken(token: string): string | null;
  getSession(id: string): SessionMetadata | null;
  trackOfFolder(cwd: string): string | null;
  /** Ids of the sessions this one started. */
  childrenOf(sessionId: string): string[];
}

export const defaultSessionRouteDeps: SessionRouteDeps = {
  takeover: sessionTakeoverDeps,
  findProject: (cwd) => findWorkspaceProject(cwd),
  projectForCwd,
  sessionForToken,
  getSession: getSessionFromDb,
  trackOfFolder: (cwd) => {
    const b = trackBranchContaining(cwd);
    return b && b.landedAt === null ? b.trackName : null;
  },
  childrenOf: (id) =>
    sessionManager
      .getSessionList()
      .filter((s) => s.spawnedBy === id)
      .map((s) => s.id),
};

const FEATURE = /^f-[a-z0-9]+$/;

function isKnown(error: unknown): error is StatusError {
  return error instanceof ClaimError || error instanceof AgentSessionError || error instanceof AccountRefusedError;
}

function sendError(reply: FastifyReply, error: unknown): unknown {
  return replyWithError(reply, error, { known: isKnown, logger, message: 'factory: session claim failed' });
}

type Body = Record<string, unknown>;
const bodyOf = (b: unknown): Body => (b !== null && typeof b === 'object' && !Array.isArray(b) ? (b as Body) : {});

function boardCwd(deps: SessionRouteDeps, cwd: unknown): string {
  if (typeof cwd !== 'string' || !cwd.trim()) throw new ClaimError(400, 'cwd is required');
  const project = deps.findProject(cwd);
  if (!project) throw new ClaimError(404, `${cwd} is not a project on the board`);
  return project.cwd;
}

function checkFeature(id: string): void {
  if (!FEATURE.test(id)) throw new ClaimError(400, 'A feature id is required');
}

interface AgentCaller {
  id: string;
  session: SessionMetadata;
  project: RegistryProject;
}

function agentCaller(deps: SessionRouteDeps, request: Parameters<typeof authenticate>[0]): AgentCaller {
  const id = authenticate(request, deps);
  const session = deps.getSession(id);
  if (!session) throw new AgentSessionError(401, 'The calling session is gone');
  const project = deps.projectForCwd(session.cwd);
  if (!project) throw new AgentSessionError(404, 'This session is not in a project with a plan');
  return { id, session, project };
}

/** A feature id, or a track name whose factory unit it means. */
function resolveTarget(project: RegistryProject, target: string): string {
  if (FEATURE.test(target)) return target;
  const unit = trackUnit(project.cwd, target);
  if (!unit) throw new ClaimError(404, `"${target}" is neither a feature id nor a track with factory work`);
  return unit.lead.featureId;
}

/**
 * The unit a session's return/done means: the target, else the one the caller
 * holds, else the one a session it started holds (in its project).
 */
function heldBy(deps: SessionRouteDeps, caller: AgentCaller, target: unknown): { featureId: string; holder: string } {
  const mine = [caller.id, ...deps.childrenOf(caller.id)];
  const inProject = (sessionId: string) =>
    itemsClaimedBy(sessionOwner(sessionId)).filter((i) => pathKey(i.projectCwd) === pathKey(caller.project.cwd));
  if (target !== undefined && target !== null && target !== '') {
    if (typeof target !== 'string') throw new ClaimError(400, 'target must be a feature id or a track name');
    const featureId = resolveTarget(caller.project, target.trim());
    for (const id of mine) if (inProject(id).some((i) => i.featureId === featureId || unitHas(i, featureId, caller.project.cwd))) return { featureId, holder: id };
    throw new ClaimError(403, `Neither this session nor one it started holds ${target}`);
  }
  for (const id of mine) {
    const held = inProject(id);
    if (held.length > 0) return { featureId: held[0].featureId, holder: id };
  }
  throw new ClaimError(409, 'This session holds no factory work');
}

// A track's items are one unit: holding any of them answers for the track.
function unitHas(held: { trackName: string; workflow: string }, featureId: string, projectCwd: string): boolean {
  if (!isTrackWorkflow(held.workflow)) return false;
  const unit = trackUnit(projectCwd, held.trackName);
  return !!unit?.items.some((i) => i.featureId === featureId);
}

export function registerFactorySessionRoutes(app: FastifyInstance, deps: SessionRouteDeps = defaultSessionRouteDeps): void {
  // --- The board ---------------------------------------------------------------

  app.post<{ Params: { featureId: string }; Body?: unknown }>('/api/factory/items/:featureId/take', async (request, reply) => {
    try {
      checkFeature(request.params.featureId);
      const cwd = boardCwd(deps, bodyOf(request.body).cwd);
      return await takeOver({ projectCwd: cwd, featureId: request.params.featureId }, deps.takeover());
    } catch (error) {
      return sendError(reply, error);
    }
  });

  for (const end of ['return', 'done'] as const) {
    app.post<{ Params: { featureId: string }; Body?: unknown }>(`/api/factory/items/:featureId/${end}`, async (request, reply) => {
      try {
        checkFeature(request.params.featureId);
        const cwd = boardCwd(deps, bodyOf(request.body).cwd);
        return await releaseSessionClaim(
          { projectCwd: cwd, featureId: request.params.featureId },
          end === 'return' ? 'returned' : 'done',
          deps.takeover()
        );
      } catch (error) {
        return sendError(reply, error);
      }
    });
  }

  // --- Sessions (cr factory take|return|done) -------------------------------------

  app.post<{ Body?: unknown }>('/api/agent/factory/take', async (request, reply) => {
    try {
      const caller = agentCaller(deps, request);
      if (caller.session.spawnedBy) throw new AgentSessionError(403, 'A started session cannot start sessions, so it cannot take over factory work');
      const body = bodyOf(request.body);
      const raw = body.target ?? deps.trackOfFolder(caller.session.cwd);
      if (typeof raw !== 'string' || !raw.trim()) throw new ClaimError(400, 'Name a feature id or a track: this session is not in a track worktree');
      const featureId = resolveTarget(caller.project, raw.trim());
      return await takeOver({ projectCwd: caller.project.cwd, featureId, ownerId: caller.session.ownerId ?? undefined }, deps.takeover());
    } catch (error) {
      return sendError(reply, error);
    }
  });

  for (const end of ['return', 'done'] as const) {
    app.post<{ Body?: unknown }>(`/api/agent/factory/${end}`, async (request, reply) => {
      try {
        const caller = agentCaller(deps, request);
        const { featureId, holder } = heldBy(deps, caller, bodyOf(request.body).target);
        return await releaseSessionClaim(
          { projectCwd: caller.project.cwd, featureId, sessionId: holder, callerId: caller.id },
          end === 'return' ? 'returned' : 'done',
          deps.takeover()
        );
      } catch (error) {
        return sendError(reply, error);
      }
    });
  }
}
