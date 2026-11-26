import type { FastifyInstance, FastifyReply } from 'fastify';
import { createLogger } from '../utils/logger.js';
import { pathKey } from '../utils/paths.js';
import { replyWithError, type StatusError } from '../utils/http-errors.js';
import { sessionForToken } from '../sessions/session-env.js';
import { getSession as getSessionFromDb } from '../db/queries.js';
import type { SessionMetadata } from '../sessions/types.js';
import type { RegistryProject } from '../projects/registry.js';
import { findWorkspaceProject } from '../projects/workspace.js';
import { readProjectPlan } from '../projects/project-plan.js';
import { allFeatures } from '../projects/project-doc-format.js';
import { trackBranchContaining } from '../projects/track-store.js';
import { isTrackError } from '../projects/routes.js';
import { AgentSessionError, authenticate, projectForCwd } from '../agent/agent-common.js';
import { getDispatcher, releaseParked, FactoryEngineError, type DispatchStatus } from './dispatcher.js';
import { addWork, defaultIntakeDeps, IntakeError, type IntakeDeps } from './intake.js';
import { getIntake, updateIntake, type ShapeQuestion } from './intake-store.js';
import { listMerges, type MergeStatus } from './merge-queue-store.js';
import { getRunState, unitIdFor } from './run-state.js';
import { defaultSendDeps, sendTrack, SendError, type SendDeps } from './send.js';
import { getItem, listDependencies, listItems } from './store.js';
import { isTrackWorkflow } from './templates.js';
import { triageItem, TriageError } from './triage.js';
import { CLOSED_STATUSES, type ItemStatus } from './types.js';

const logger = createLogger('factory-routes');

/**
 * The factory's write side over HTTP (project/code-factory.md, items 3 and 6):
 * add loose work, send a planned track, answer a shaping question, settle a
 * triage item, and a compact status for the CLI. The board's richer read model
 * is the Factory overlay's own (board-routes.ts).
 *
 * Two doors to the same operations:
 *  - `/api/factory/*` for the board, behind the access gate like every other
 *    `/api/*` route, naming the project by `cwd`;
 *  - `/api/agent/factory/*` for sessions (`cr factory …`): loopback AND the
 *    caller's session token (`authenticate()`), the project being the one the
 *    session works in. A `cwd` naming another project is refused (403).
 */

export class FactoryRouteError extends Error {
  constructor(
    public readonly status: number,
    message: string
  ) {
    super(message);
    this.name = 'FactoryRouteError';
  }
}

// ---------------------------------------------------------------------------
// Status

export interface StatusItem {
  featureId: string;
  title: string;
  track: string;
  status: ItemStatus;
  step: string | null;
  priority: number;
  model: string | null;
  /** Open items this one waits for. */
  waitsFor: string[];
  discoveredFrom: string[];
}

export interface ParkedUnit {
  unitId: string;
  featureIds: string[];
  step: string | null;
  reason: string | null;
  /** Shaping's question, when that is what it waits on. */
  question: ShapeQuestion | null;
}

export interface StatusMerge {
  id: string;
  kind: string;
  branch: string;
  status: MergeStatus;
  detail: string | null;
  featureIds: string[];
}

export interface FactoryStatus {
  items: StatusItem[];
  parked: ParkedUnit[];
  merges: StatusMerge[];
  /** Closed items, counted. */
  closed: { done: number; cancelled: number };
  dispatch: DispatchStatus | null;
}

export function factoryStatus(project: RegistryProject): FactoryStatus {
  const cwd = project.cwd;
  const all = listItems({ projectCwd: cwd });
  const open = all.filter((i) => !CLOSED_STATUSES.includes(i.status));
  const byId = new Map(all.map((i) => [i.featureId, i]));
  let titles = new Map<string, string>();
  try {
    titles = new Map(allFeatures(readProjectPlan(project).doc).map((f) => [f.id, f.title]));
  } catch (error) {
    logger.warn({ cwd, error: (error as Error).message }, 'factory status: plan not read');
  }
  const deps = listDependencies(cwd);
  const items: StatusItem[] = open.map((i) => ({
    featureId: i.featureId,
    title: titles.get(i.featureId) ?? i.featureId,
    track: i.trackName,
    status: i.status,
    step: i.step,
    priority: i.priority,
    model: i.modelTier,
    waitsFor: deps
      .filter((d) => d.fromFeature === i.featureId && d.type === 'blocks')
      .map((d) => d.toFeature)
      .filter((id) => {
        const blocker = byId.get(id);
        return blocker !== undefined && !CLOSED_STATUSES.includes(blocker.status);
      }),
    discoveredFrom: deps.filter((d) => d.fromFeature === i.featureId && d.type === 'discovered-from').map((d) => d.toFeature),
  }));

  const parkedUnits = new Map<string, ParkedUnit>();
  for (const i of open.filter((x) => x.status === 'parked')) {
    const unitId = unitIdFor(i, isTrackWorkflow(i.workflow));
    const unit = parkedUnits.get(unitId);
    if (unit) {
      unit.featureIds.push(i.featureId);
      continue;
    }
    parkedUnits.set(unitId, {
      unitId,
      featureIds: [i.featureId],
      step: i.step,
      reason: getRunState(cwd, unitId)?.parkReason ?? null,
      question: getIntake(cwd, i.featureId)?.question ?? null,
    });
  }

  const merges = listMerges(cwd, ['queued', 'holding', 'running', 'parked']).map((m) => ({
    id: m.id,
    kind: m.kind,
    branch: m.branch,
    status: m.status,
    detail: m.detail,
    featureIds: m.featureIds,
  }));

  return {
    items,
    parked: [...parkedUnits.values()],
    merges,
    closed: {
      done: all.filter((i) => i.status === 'done').length,
      cancelled: all.filter((i) => i.status === 'cancelled').length,
    },
    dispatch: getDispatcher()?.status() ?? null,
  };
}

// ---------------------------------------------------------------------------
// Answering shaping

export const MAX_ANSWER = 4000;

/**
 * Answer the question a loose item's shaping parked on: the item goes back in
 * the queue and its shaping resumes the session that asked, with the answer.
 */
export function answerItem(project: RegistryProject, featureId: string, answer: unknown): { featureId: string; queued: true } {
  if (typeof answer !== 'string' || !answer.trim()) throw new FactoryRouteError(400, 'answer is required');
  if (answer.length > MAX_ANSWER) throw new FactoryRouteError(400, `answer is too long (at most ${MAX_ANSWER} characters)`);
  const item = getItem(project.cwd, featureId);
  if (!item) throw new FactoryRouteError(404, `${featureId} is not a factory item of this project`);
  const intake = getIntake(project.cwd, featureId);
  if (item.status !== 'parked' || !intake?.question) {
    throw new FactoryRouteError(409, `${featureId} is not waiting on a question`);
  }
  updateIntake(project.cwd, featureId, { answer: answer.trim() });
  releaseParked(project.cwd, featureId);
  void getDispatcher()?.tick();
  return { featureId, queued: true };
}

// ---------------------------------------------------------------------------
// Routes

export interface FactoryRouteDeps {
  intake: IntakeDeps;
  send: SendDeps;
  /** The board project for a `cwd` sent by the board; null when it is none. */
  findProject(cwd: string): RegistryProject | null;
  /** The project a session's folder belongs to (main checkout or a track worktree). */
  projectForCwd(cwd: string): RegistryProject | null;
  sessionForToken(token: string): string | null;
  getSession(id: string): SessionMetadata | null;
  /** The track whose worktree holds this folder, if any. */
  trackOfFolder(cwd: string): string | null;
}

export const defaultFactoryRouteDeps: FactoryRouteDeps = {
  intake: defaultIntakeDeps,
  send: defaultSendDeps,
  findProject: (cwd) => findWorkspaceProject(cwd),
  projectForCwd,
  sessionForToken,
  getSession: getSessionFromDb,
  trackOfFolder: (cwd) => {
    const b = trackBranchContaining(cwd);
    return b && b.landedAt === null ? b.trackName : null;
  },
};

const KNOWN = [FactoryRouteError, IntakeError, SendError, TriageError, AgentSessionError];

function isKnownError(error: unknown): error is StatusError {
  if (error instanceof FactoryEngineError) return false;
  return KNOWN.some((k) => error instanceof k) || isTrackError(error);
}

function sendError(reply: FastifyReply, error: unknown): unknown {
  if (error instanceof FactoryEngineError) return reply.status(409).send({ error: error.message });
  return replyWithError(reply, error, { known: isKnownError, logger, message: 'factory: request failed' });
}

type Body = Record<string, unknown>;
const bodyOf = (b: unknown): Body => (b !== null && typeof b === 'object' && !Array.isArray(b) ? (b as Body) : {});

function boardProject(deps: FactoryRouteDeps, cwd: unknown): RegistryProject {
  if (typeof cwd !== 'string' || !cwd.trim()) throw new FactoryRouteError(400, 'cwd is required');
  const project = deps.findProject(cwd);
  if (!project) throw new FactoryRouteError(404, `${cwd} is not a project on the board`);
  return project;
}

interface Caller {
  id: string;
  session: SessionMetadata;
  project: RegistryProject;
}

/** The calling session and its project; a `cwd` naming any other project is refused. */
function agentCaller(deps: FactoryRouteDeps, request: Parameters<typeof authenticate>[0], cwd: unknown): Caller {
  const id = authenticate(request, deps);
  const session = deps.getSession(id);
  if (!session) throw new AgentSessionError(401, 'The calling session is gone');
  const project = deps.projectForCwd(session.cwd);
  if (!project) throw new AgentSessionError(404, 'This session is not in a project with a plan');
  if (cwd !== undefined && cwd !== null && cwd !== '') {
    const named = typeof cwd === 'string' ? deps.projectForCwd(cwd) : null;
    if (!named || pathKey(named.cwd) !== pathKey(project.cwd)) {
      throw new AgentSessionError(403, "A session works only on its own project's factory");
    }
  }
  return { id, session, project };
}

export function registerFactoryRoutes(app: FastifyInstance, deps: FactoryRouteDeps = defaultFactoryRouteDeps): void {
  // --- The board --------------------------------------------------------------

  app.post<{ Body?: unknown }>('/api/factory/add', async (request, reply) => {
    try {
      const body = bodyOf(request.body);
      const project = boardProject(deps, body.cwd);
      return await addWork({ project, text: body.text, track: body.track, mockupFirst: body.mockupFirst }, deps.intake);
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.post<{ Body?: unknown }>('/api/factory/send', async (request, reply) => {
    try {
      const body = bodyOf(request.body);
      const project = boardProject(deps, body.cwd);
      return await sendTrack({ project, track: body.track, review: body.review, models: body.models }, deps.send);
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.get<{ Querystring: { cwd?: string } }>('/api/factory/status', async (request, reply) => {
    try {
      return factoryStatus(boardProject(deps, request.query.cwd));
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.post<{ Params: { featureId: string }; Body?: unknown }>('/api/factory/items/:featureId/answer', async (request, reply) => {
    try {
      const body = bodyOf(request.body);
      return answerItem(boardProject(deps, body.cwd), request.params.featureId, body.answer);
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.post<{ Params: { featureId: string }; Body?: unknown }>('/api/factory/triage/:featureId', async (request, reply) => {
    try {
      const body = bodyOf(request.body);
      const result = await triageItem(boardProject(deps, body.cwd), request.params.featureId, body.action);
      if (result.action === 'accept') void getDispatcher()?.tick();
      return result;
    } catch (error) {
      return sendError(reply, error);
    }
  });

  // --- Sessions (cr factory …) ------------------------------------------------

  app.post<{ Body?: unknown }>('/api/agent/factory/add', async (request, reply) => {
    try {
      const body = bodyOf(request.body);
      const { project } = agentCaller(deps, request, body.cwd);
      let from: string[] | undefined;
      if (body.discoveredFrom !== undefined) {
        const raw = body.discoveredFrom;
        const list = typeof raw === 'string' ? [raw] : raw;
        if (!Array.isArray(list) || list.length === 0 || !list.every((x) => typeof x === 'string' && /^f-[a-z0-9]+$/.test(x))) {
          throw new FactoryRouteError(400, 'discoveredFrom must be feature ids');
        }
        from = [...new Set(list as string[])];
      }
      return await addWork(
        { project, text: body.text, track: body.track, discoveredFrom: from, mockupFirst: body.mockupFirst },
        deps.intake
      );
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.post<{ Body?: unknown }>('/api/agent/factory/send', async (request, reply) => {
    try {
      const body = bodyOf(request.body);
      const { project, session } = agentCaller(deps, request, body.cwd);
      // No track named: the one whose worktree this session is in.
      const track = body.track ?? deps.trackOfFolder(session.cwd);
      if (track === null) throw new FactoryRouteError(400, 'Name the track: this session is not in a track worktree');
      return await sendTrack({ project, track, review: body.review, models: body.models }, deps.send);
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.get<{ Querystring: { cwd?: string } }>('/api/agent/factory/status', async (request, reply) => {
    try {
      return factoryStatus(agentCaller(deps, request, request.query.cwd).project);
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.post<{ Params: { featureId: string }; Body?: unknown }>('/api/agent/factory/items/:featureId/answer', async (request, reply) => {
    try {
      const body = bodyOf(request.body);
      return answerItem(agentCaller(deps, request, body.cwd).project, request.params.featureId, body.answer);
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.post<{ Params: { featureId: string }; Body?: unknown }>('/api/agent/factory/triage/:featureId', async (request, reply) => {
    try {
      const body = bodyOf(request.body);
      const result = await triageItem(agentCaller(deps, request, body.cwd).project, request.params.featureId, body.action);
      if (result.action === 'accept') void getDispatcher()?.tick();
      return result;
    } catch (error) {
      return sendError(reply, error);
    }
  });
}
