import type { FastifyInstance } from 'fastify';
import { createLogger } from '../utils/logger.js';
import { getWorkspaceBoard, findWorkspaceProject } from './workspace.js';
import { getRollup } from './rollup.js';
import { pathKey } from '../sessions/project-discovery.js';
import { loadRegistry, saveRegistry, normalizeRegistry } from './registry.js';
import { migrateProject } from './migrate.js';
import { generateQaDoc } from './qa-generate.js';
import { readQaDoc, qaDocRelPath } from '../jobs/qa-doc.js';
import { ProjectStoreError, mutateProjectDoc, readProjectDoc, readSpec } from './project-store.js';
import {
  TrackBranchError,
  ensureTrackBranch,
  landTrack,
  readSpecForTrack,
} from './track-branches.js';
import { sessionManager } from '../sessions/manager.js';
import { WorktreeError } from '../jobs/worktree.js';
import { cancelJob, discardJob } from '../jobs/runner.js';
import { TrackDeleteError, executeTrackDelete, planTrackDelete } from './track-delete.js';
import {
  addFeature,
  removeFeature,
  reorderFeatures,
  updateFeature,
  type FeatureStatus,
} from './project-doc-format.js';

const logger = createLogger('project-routes');

const STATUSES: FeatureStatus[] = ['pending', 'in_progress', 'done', 'blocked'];

function isStatus(v: unknown): v is FeatureStatus {
  return typeof v === 'string' && (STATUSES as string[]).includes(v);
}

/** Priority is P0-P9 or explicitly cleared. */
function parsePriority(v: unknown): number | null | undefined {
  if (v === undefined) return undefined;
  if (v === null) return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isInteger(n) && n >= 0 && n <= 9 ? n : undefined;
}

/**
 * Routes for the project workspace.
 *
 * Every write resolves `cwd` through findWorkspaceProject() first, so a request
 * can only ever address a directory that is actually on the board — never an
 * arbitrary path. This mirrors the guard the existing resync endpoint applies
 * before running a write-capable agent anywhere.
 */
export function registerProjectRoutes(app: FastifyInstance): void {
  // --- Board -------------------------------------------------------------
  app.get('/api/projects', async () => {
    return { projects: getWorkspaceBoard() };
  });

  // Cross-project roll-up: what is in flight and what is waiting on you.
  app.get('/api/projects/rollup', async () => {
    return getRollup();
  });

  // One project's full detail, including the resolved spec of a named feature.
  app.get<{ Querystring: { cwd?: string; feature?: string } }>(
    '/api/projects/detail',
    async (request, reply) => {
      const { cwd, feature } = request.query;
      if (!cwd) return reply.status(400).send({ error: 'cwd required' });

      // Build the board once and reuse it for both the lookup and the payload.
      const allProjects = getWorkspaceBoard();
      const project = findWorkspaceProject(cwd, allProjects);
      if (!project) return reply.status(404).send({ error: 'Unknown project' });

      const board = allProjects.find((p) => pathKey(p.cwd) === pathKey(project.cwd));
      const state = readProjectDoc(project);
      const target = feature
        ? state.doc.tracks
            .flatMap((t) => t.items)
            .find((i) => i.kind === 'feature' && i.feature.id === feature)
        : undefined;
      // A spec revised during implementation lives on the track branch until
      // it lands, so the worktree's copy wins when there is one.
      const trackName = feature
        ? (state.doc.tracks.find((t) =>
            t.items.some((i) => i.kind === 'feature' && i.feature.id === feature)
          )?.name ?? null)
        : null;
      const spec =
        target && target.kind === 'feature'
          ? (readSpecForTrack(project, trackName, target.feature.spec) ??
            readSpec(project, target.feature.spec))
          : null;

      return { project: board ?? null, revision: state.revision, spec };
    }
  );

  // --- Registry ----------------------------------------------------------
  app.get('/api/projects/registry', async () => {
    return { registry: loadRegistry(), path: undefined };
  });

  // Replace the registry wholesale. It is a small, hand-editable file, so the
  // UI edits it as a document rather than patching individual entries.
  app.put<{ Body?: unknown }>('/api/projects/registry', async (request, reply) => {
    const registry = normalizeRegistry(request.body);
    try {
      saveRegistry(registry);
      return { registry, projects: getWorkspaceBoard() };
    } catch (error) {
      logger.error({ error }, 'registry: save failed');
      return reply.status(500).send({ error: 'Failed to save registry' });
    }
  });

  // --- Migration ---------------------------------------------------------
  // Convert a project's existing plan docs into a canonical PROJECT.md. This is
  // the only endpoint that lets an agent author the index.
  app.post<{ Body?: { cwd?: string } }>('/api/projects/migrate', async (request, reply) => {
    const cwd = request.body?.cwd;
    if (!cwd || typeof cwd !== 'string') {
      return reply.status(400).send({ error: 'cwd required' });
    }
    const project = findWorkspaceProject(cwd);
    if (!project) return reply.status(404).send({ error: 'Unknown project' });

    const result = await migrateProject(project);
    return result;
  });

  // --- QA contract -------------------------------------------------------
  // The per-project definition of "verified". Read it, or draft one to edit.

  app.get<{ Querystring: { cwd?: string } }>('/api/projects/qa', async (request, reply) => {
    const cwd = request.query?.cwd;
    if (!cwd) return reply.status(400).send({ error: 'cwd required' });
    const project = findWorkspaceProject(cwd);
    if (!project) return reply.status(404).send({ error: 'Unknown project' });
    const doc = readQaDoc(project.cwd);
    return { path: qaDocRelPath(), doc };
  });

  app.post<{ Body?: { cwd?: string; force?: boolean } }>(
    '/api/projects/qa/generate',
    async (request, reply) => {
      const cwd = request.body?.cwd;
      if (!cwd) return reply.status(400).send({ error: 'cwd required' });
      const project = findWorkspaceProject(cwd);
      if (!project) return reply.status(404).send({ error: 'Unknown project' });
      return generateQaDoc(project, { force: request.body?.force === true });
    }
  );

  // --- Feature mutations -------------------------------------------------
  // All three take a `revision` echoed from the board and return 409 when
  // PROJECT.md changed underneath, because the board is a poll snapshot and the
  // file is also written by hand and by pipeline stages.

  app.post<{
    Body?: { cwd?: string; revision?: string; title?: string; track?: string; priority?: unknown };
  }>('/api/projects/feature', async (request, reply) => {
    const body = request.body || {};
    if (!body.cwd || !body.title?.trim()) {
      return reply.status(400).send({ error: 'cwd and title required' });
    }
    const project = findWorkspaceProject(body.cwd);
    if (!project) return reply.status(404).send({ error: 'Unknown project' });

    return withStore(reply, () => {
      const { state, result } = mutateProjectDoc(project, body.revision ?? null, (doc) =>
        addFeature(doc, {
          title: body.title as string,
          track: body.track,
          priority: parsePriority(body.priority) ?? null,
        })
      );
      return { feature: result, revision: state.revision };
    });
  });

  app.patch<{
    Body?: {
      cwd?: string;
      revision?: string;
      id?: string;
      status?: unknown;
      title?: string;
      priority?: unknown;
      track?: string;
      spec?: string | null;
    };
  }>('/api/projects/feature', async (request, reply) => {
    const body = request.body || {};
    if (!body.cwd || !body.id) {
      return reply.status(400).send({ error: 'cwd and id required' });
    }
    if (body.status !== undefined && !isStatus(body.status)) {
      return reply.status(400).send({ error: `status must be one of ${STATUSES.join(', ')}` });
    }
    const project = findWorkspaceProject(body.cwd);
    if (!project) return reply.status(404).send({ error: 'Unknown project' });

    return withStore(reply, () => {
      const { state, result } = mutateProjectDoc(project, body.revision ?? null, (doc) =>
        updateFeature(doc, body.id as string, {
          ...(body.status !== undefined ? { status: body.status as FeatureStatus } : {}),
          ...(body.title !== undefined ? { title: body.title } : {}),
          ...(parsePriority(body.priority) !== undefined
            ? { priority: parsePriority(body.priority) as number | null }
            : {}),
          ...(body.track !== undefined ? { track: body.track } : {}),
          ...(body.spec !== undefined ? { spec: body.spec } : {}),
        })
      );
      if (!result) return reply.status(404).send({ error: 'Unknown feature id' });
      return { feature: result, revision: state.revision };
    });
  });

  app.delete<{ Body?: { cwd?: string; revision?: string; id?: string } }>(
    '/api/projects/feature',
    async (request, reply) => {
      const body = request.body || {};
      if (!body.cwd || !body.id) {
        return reply.status(400).send({ error: 'cwd and id required' });
      }
      const project = findWorkspaceProject(body.cwd);
      if (!project) return reply.status(404).send({ error: 'Unknown project' });

      return withStore(reply, () => {
        const { state, result } = mutateProjectDoc(project, body.revision ?? null, (doc) =>
          removeFeature(doc, body.id as string)
        );
        if (!result) return reply.status(404).send({ error: 'Unknown feature id' });
        return { removed: true, revision: state.revision };
      });
    }
  );

  app.post<{ Body?: { cwd?: string; revision?: string; track?: string; ids?: string[] } }>(
    '/api/projects/feature/reorder',
    async (request, reply) => {
      const body = request.body || {};
      if (!body.cwd || !body.track || !Array.isArray(body.ids)) {
        return reply.status(400).send({ error: 'cwd, track and ids required' });
      }
      const project = findWorkspaceProject(body.cwd);
      if (!project) return reply.status(404).send({ error: 'Unknown project' });

      return withStore(reply, () => {
        const { state, result } = mutateProjectDoc(project, body.revision ?? null, (doc) =>
          reorderFeatures(doc, body.track as string, body.ids as string[])
        );
        if (!result) return reply.status(404).send({ error: 'Unknown track' });
        return { reordered: true, revision: state.revision };
      });
    }
  );

  // --- Track branches ------------------------------------------------------
  // A track's own branch and worktree (docs/track-branches.md). Creating one is
  // idempotent, so the board, the new-session picker and dispatch can all ask.

  app.get<{ Querystring: { cwd?: string } }>('/api/projects/tracks', async (request, reply) => {
    const { cwd } = request.query;
    if (!cwd) return reply.status(400).send({ error: 'cwd required' });
    const project = findWorkspaceProject(cwd);
    if (!project) return reply.status(404).send({ error: 'Unknown project' });
    const board = getWorkspaceBoard().find((p) => pathKey(p.cwd) === pathKey(project.cwd));
    return {
      cwd: project.cwd,
      canBranch: board?.vcs.canDispatch ?? false,
      tracks: (board?.tracks ?? []).map((t) => ({ name: t.name, branch: t.branch })),
    };
  });

  app.post<{ Body?: { cwd?: string; track?: string } }>(
    '/api/projects/track/branch',
    async (request, reply) => {
      const body = request.body || {};
      if (!body.cwd || !body.track?.trim()) {
        return reply.status(400).send({ error: 'cwd and track required' });
      }
      const project = findWorkspaceProject(body.cwd);
      if (!project) return reply.status(404).send({ error: 'Unknown project' });
      return withTrack(reply, async () => ({
        branch: await ensureTrackBranch(project, body.track as string),
      }));
    }
  );

  app.post<{ Body?: { cwd?: string; track?: string } }>(
    '/api/projects/track/land',
    async (request, reply) => {
      const body = request.body || {};
      if (!body.cwd || !body.track) {
        return reply.status(400).send({ error: 'cwd and track required' });
      }
      const project = findWorkspaceProject(body.cwd);
      if (!project) return reply.status(404).send({ error: 'Unknown project' });
      const liveCwds = sessionManager.getAllSessions().map((s) => s.cwd);
      return withTrack(reply, () => landTrack(project, body.track as string, liveCwds));
    }
  );

  // --- Delete track ------------------------------------------------------
  // A plan first, then the delete, echoing the plan's token so anything that
  // moved in between is a 409 rather than a surprise (docs/track-branches.md).

  app.get<{ Querystring: { cwd?: string; track?: string } }>(
    '/api/projects/track/delete-plan',
    async (request, reply) => {
      const { cwd, track } = request.query;
      if (!cwd || !track) return reply.status(400).send({ error: 'cwd and track required' });
      const project = findWorkspaceProject(cwd);
      if (!project) return reply.status(404).send({ error: 'Unknown project' });
      const liveCwds = sessionManager.getAllSessions().map((s) => s.cwd);
      return withTrack(reply, async () => ({ plan: await planTrackDelete(project, track, liveCwds) }));
    }
  );

  app.delete<{
    Body?: { cwd?: string; track?: string; token?: string; revert?: unknown; deleteSpecs?: unknown };
  }>('/api/projects/track', async (request, reply) => {
    const body = request.body || {};
    if (!body.cwd || !body.track || !body.token) {
      return reply.status(400).send({ error: 'cwd, track and token required' });
    }
    const project = findWorkspaceProject(body.cwd);
    if (!project) return reply.status(404).send({ error: 'Unknown project' });
    const strings = (v: unknown): string[] =>
      Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];

    return withTrack(reply, () =>
      executeTrackDelete(
        project,
        body.track as string,
        { token: body.token as string, revert: strings(body.revert), deleteSpecs: strings(body.deleteSpecs) },
        {
          liveSessions: () => sessionManager.getAllSessions().map((s) => ({ id: s.id, cwd: s.cwd })),
          terminateSession: (id) => sessionManager.terminateSession(id),
          cancelJob,
          discardJob,
        }
      )
    );
  });

  logger.info('Project workspace routes registered');
}

/** Map TrackBranchError / ProjectStoreError onto the reply. */
async function withTrack<T>(
  reply: { status: (code: number) => { send: (body: unknown) => unknown } },
  fn: () => Promise<T>
): Promise<T | unknown> {
  try {
    return await fn();
  } catch (error) {
    if (error instanceof TrackDeleteError) {
      return reply.status(error.status).send({ error: error.message, conflicts: error.conflicts });
    }
    if (
      error instanceof TrackBranchError ||
      error instanceof ProjectStoreError ||
      error instanceof WorktreeError
    ) {
      return reply.status(error.status).send({ error: error.message });
    }
    logger.error({ error }, 'track route failed');
    return reply
      .status(500)
      .send({ error: error instanceof Error ? error.message : 'Request failed' });
  }
}

/** Map ProjectStoreError (notably the 409 staleness conflict) onto the reply. */
function withStore<T>(
  reply: { status: (code: number) => { send: (body: unknown) => unknown } },
  fn: () => T
): T | unknown {
  try {
    return fn();
  } catch (error) {
    if (error instanceof ProjectStoreError) {
      return reply.status(error.status).send({ error: error.message, conflict: error.status === 409 });
    }
    logger.error({ error }, 'project route failed');
    return reply
      .status(500)
      .send({ error: error instanceof Error ? error.message : 'Request failed' });
  }
}
