import type { FastifyInstance } from 'fastify';
import { createLogger } from '../utils/logger.js';
import { getWorkspaceBoard, findWorkspaceProject, listBoardCwds } from './workspace.js';
import { getRollup } from './rollup.js';
import { pathKey } from '../sessions/project-discovery.js';
import {
  RegistryUnreadableError,
  loadRegistry,
  normalizeRegistry,
  saveRegistry,
  setFavorite,
  type RegistryProject,
} from './registry.js';
import { migrateProject } from './migrate.js';
import { generateQaDoc } from './qa-generate.js';
import { readQaDoc, qaDocRelPath } from '../jobs/qa-doc.js';
import { ProjectStoreError, mutateProjectDoc, readSpec } from './project-store.js';
import {
  TrackBranchError,
  branchNow,
  ensureTrackBranch,
  getActiveTrackBranch,
  landTrack,
  moveIntoBranch,
  readSpecForTrack,
} from './track-branches.js';
import { allFeatureIds, planFileFor, readProjectPlan, type PlanCopy } from './project-plan.js';
import { attributionContext, guessTrackWork } from './track-attribution.js';
import { ProjectBusyError, withProjectLock } from './project-lock.js';
import { buildProject } from './project-build.js';
import { installDependencies, needsInstall } from './project-deps.js';
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
import { withProjectUsage } from '../usage/store.js';

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
    return { projects: withProjectUsage(getWorkspaceBoard()) };
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
      // Main's plan with each in-progress track's section from its worktree.
      const plan = readProjectPlan(project);
      const state = { revision: plan.main.revision, doc: plan.doc };
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

  // Star or unstar one project. Its own endpoint rather than a registry PUT so
  // a toggle edits only `favorites` and leaves the rest of the hand-editable
  // file as written (see setFavorite).
  app.post<{ Body?: { cwd?: string; favorite?: unknown } }>(
    '/api/projects/favorite',
    async (request, reply) => {
      const { cwd, favorite } = request.body ?? {};
      if (typeof cwd !== 'string' || !cwd || typeof favorite !== 'boolean') {
        return reply.status(400).send({ error: 'cwd and favorite (boolean) required' });
      }
      // Registered projects are always among these, so this is the same guard
      // as findWorkspaceProject() without building the board to apply it.
      const boardCwds = listBoardCwds();
      const onBoard = new Set(boardCwds.map(pathKey));
      const target = boardCwds.find((c) => pathKey(c) === pathKey(cwd));
      if (!target) return reply.status(404).send({ error: 'Unknown project' });
      try {
        const favorites = setFavorite(target, favorite, (f) => onBoard.has(pathKey(f)));
        return { cwd: target, favorite, favorites };
      } catch (error) {
        if (error instanceof RegistryUnreadableError) {
          return reply.status(409).send({ error: error.message });
        }
        logger.error({ error }, 'registry: favourite save failed');
        return reply.status(500).send({ error: 'Failed to save favourite' });
      }
    }
  );

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
  // All take a `revision` echoed from the board and return 409 when the file
  // changed underneath, because the board is a poll snapshot and the file is
  // also written by hand and by pipeline stages. The file is the one that
  // holds the feature (planFileFor): an in-progress track's lines live in its
  // worktree's PROJECT.md, so the revision is that file's — the board gives
  // each branched track its own. Worktree writes stay uncommitted; Land and
  // the next job merge into the track commit them.

  app.post<{
    Body?: { cwd?: string; revision?: string; title?: string; track?: string; priority?: unknown };
  }>('/api/projects/feature', async (request, reply) => {
    const body = request.body || {};
    if (!body.cwd || !body.title?.trim()) {
      return reply.status(400).send({ error: 'cwd and title required' });
    }
    const project = findWorkspaceProject(body.cwd);
    if (!project) return reply.status(404).send({ error: 'Unknown project' });

    return withErrors(reply, () => {
      const plan = readProjectPlan(project);
      const target = planFileFor(project, plan, { track: body.track });
      return writingTo(project, target, () => {
      const { state, result } = mutateProjectDoc(target.project, body.revision ?? null, (doc) =>
        addFeature(
          doc,
          {
            title: body.title as string,
            track: body.track,
            priority: parsePriority(body.priority) ?? null,
          },
          allFeatureIds(plan)
        )
      );
      return { feature: result, revision: state.revision };
      });
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

    return withErrors(reply, () => {
      const plan = readProjectPlan(project);
      const target = planFileFor(project, plan, { featureId: body.id });
      if (body.track !== undefined && planFileFor(project, plan, { track: body.track }).project.cwd !== target.project.cwd) {
        return reply.status(400).send({
          error: 'A feature can only move between tracks whose plans are in the same file — not into or out of a branched track',
        });
      }
      return writingTo(project, target, () => {
      const { state, result } = mutateProjectDoc(target.project, body.revision ?? null, (doc) =>
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

      return withErrors(reply, () => {
        const target = planFileFor(project, readProjectPlan(project), { featureId: body.id });
        return writingTo(project, target, () => {
        const { state, result } = mutateProjectDoc(target.project, body.revision ?? null, (doc) =>
          removeFeature(doc, body.id as string)
        );
        if (!result) return reply.status(404).send({ error: 'Unknown feature id' });
        return { removed: true, revision: state.revision };
        });
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

      return withErrors(reply, () => {
        const target = planFileFor(project, readProjectPlan(project), { track: body.track });
        return writingTo(project, target, () => {
        const { state, result } = mutateProjectDoc(target.project, body.revision ?? null, (doc) =>
          reorderFeatures(doc, body.track as string, body.ids as string[])
        );
        if (!result) return reply.status(404).send({ error: 'Unknown track' });
        return { reordered: true, revision: state.revision };
        });
      });
    }
  );

  // --- Track branches ------------------------------------------------------
  // A track's own branch and worktree (docs/track-branches.md). Creating one is
  // idempotent, so the board, the new-session picker and dispatch can all ask.

  app.get<{ Querystring: { cwd?: string } }>('/api/projects/tracks', async (request, reply) => {
    const { cwd } = request.query;
    if (!cwd) return reply.status(400).send({ error: 'cwd required' });
    // One board build serves both the membership check and the answer: an
    // unregistered project otherwise builds it twice per keystroke-debounce.
    const allProjects = getWorkspaceBoard();
    const project = findWorkspaceProject(cwd, allProjects);
    if (!project) return reply.status(404).send({ error: 'Unknown project' });
    const board = allProjects.find((p) => pathKey(p.cwd) === pathKey(project.cwd));
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
      return withErrors(reply, async () => {
        const branch = await ensureTrackBranch(project, body.track as string);
        // The caller opens a session there; it runs /track/install first when
        // this is true, so "Installing dependencies…" shows only when it happens.
        return { branch, needsInstall: needsInstall(branch.worktreePath) };
      });
    }
  );

  // A track worktree's own node_modules, installed before a session opens
  // there so no agent in it can start a second install into the same folder.
  // The path comes from the track's row, never from the browser. Never links
  // the main checkout's copy in (docs/track-branches.md, "Dependencies").
  app.post<{ Body?: { cwd?: string; track?: string } }>(
    '/api/projects/track/install',
    async (request, reply) => {
      const body = request.body || {};
      if (!body.cwd || !body.track) {
        return reply.status(400).send({ error: 'cwd and track required' });
      }
      const project = findWorkspaceProject(body.cwd);
      if (!project) return reply.status(404).send({ error: 'Unknown project' });
      const branch = getActiveTrackBranch(project.cwd, body.track.trim());
      if (!branch) return reply.status(404).send({ error: `"${body.track}" has no branch` });
      return { install: await installDependencies(branch.worktreePath) };
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
      return withErrors(reply, async () => {
        const landed = await withProjectLock(project.cwd, `landing "${body.track}"`, () =>
          landTrack(project, body.track as string, liveCwds)
        );
        // Outside the lock: a build touches no git state, and holding the lock
        // for minutes would refuse every Land/Delete/merge meanwhile. A failed
        // build does not undo the land — it is reported alongside it.
        const build = await buildProject(project.cwd);
        return {
          ...landed,
          build,
          detail: build.ran ? `${landed.detail} — ${build.detail}` : landed.detail,
        };
      });
    }
  );

  // Lines main still has for a branched track ("both copies") go into its
  // worktree, the worktree's lines winning by id (docs/track-branches.md).
  app.post<{ Body?: { cwd?: string; track?: string } }>(
    '/api/projects/track/move-into-branch',
    async (request, reply) => {
      const body = request.body || {};
      if (!body.cwd || !body.track) {
        return reply.status(400).send({ error: 'cwd and track required' });
      }
      const project = findWorkspaceProject(body.cwd);
      if (!project) return reply.status(404).send({ error: 'Unknown project' });
      return withErrors(reply, async () => {
        const moved = await withProjectLock(project.cwd, `moving "${body.track}" lines into its branch`, () =>
          moveIntoBranch(project, body.track as string)
        );
        const kept = moved.specsKept.length
          ? ` Kept on main, because the branch has its own version: ${moved.specsKept.join(', ')}.`
          : '';
        return {
          ...moved,
          detail:
            (moved.mainCommit
              ? `Moved main’s lines for "${body.track}" into its branch (${moved.mainCommit.slice(0, 8)} on main, not pushed).`
              : `Moved main’s lines for "${body.track}" into its branch.`) + kept,
        };
      });
    }
  );

  // --- Work on main outside any branch -------------------------------------
  // A GUESS at what a track's sessions did on main (track-attribution.ts). The
  // board shows a count; Branch now moves only files the server itself
  // guessed, after the user confirms the list.

  app.get<{ Querystring: { cwd?: string } }>(
    '/api/projects/unbranched-work',
    async (request, reply) => {
      const { cwd } = request.query;
      if (!cwd) return reply.status(400).send({ error: 'cwd required' });
      const project = findWorkspaceProject(cwd);
      if (!project) return reply.status(404).send({ error: 'Unknown project' });
      const tracks: Record<string, { files: { path: string; status: string }[]; commits: number }> = {};
      // One context for every track: transcripts, status and the phase list
      // are the same for all of them, and this runs on each project render.
      const ctx = await attributionContext(project);
      for (const t of ctx.doc.tracks) {
        if (getActiveTrackBranch(project.cwd, t.name)) continue; // its work is attributable already
        const guess = await guessTrackWork(project, t.name, ctx);
        // Only uncommitted files: they are what Branch now can act on. Guessed
        // commits alone flag every track with history from before track
        // branches existed; Delete track still offers them, unticked.
        if (guess.files.length > 0) {
          tracks[t.name] = { files: guess.files, commits: guess.commits.length };
        }
      }
      return { tracks };
    }
  );

  app.post<{ Body?: { cwd?: string; track?: string; files?: unknown } }>(
    '/api/projects/track/branch-now',
    async (request, reply) => {
      const body = request.body || {};
      if (!body.cwd || !body.track || !Array.isArray(body.files)) {
        return reply.status(400).send({ error: 'cwd, track and files required' });
      }
      const project = findWorkspaceProject(body.cwd);
      if (!project) return reply.status(404).send({ error: 'Unknown project' });
      const files = body.files.filter((x): x is string => typeof x === 'string');
      return withErrors(reply, () =>
        withProjectLock(project.cwd, `moving "${body.track}" off main`, () =>
          branchNow(project, body.track as string, files)
        )
      );
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
      return withErrors(reply, async () => ({ plan: await planTrackDelete(project, track, liveCwds) }));
    }
  );

  app.delete<{
    Body?: {
      cwd?: string;
      track?: string;
      token?: string;
      revert?: unknown;
      deleteSpecs?: unknown;
      restoreFiles?: unknown;
      revertGuessed?: unknown;
    };
  }>('/api/projects/track', async (request, reply) => {
    const body = request.body || {};
    if (!body.cwd || !body.track || !body.token) {
      return reply.status(400).send({ error: 'cwd, track and token required' });
    }
    const project = findWorkspaceProject(body.cwd);
    if (!project) return reply.status(404).send({ error: 'Unknown project' });
    const strings = (v: unknown): string[] =>
      Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];

    return withErrors(reply, () =>
      withProjectLock(project.cwd, `deleting "${body.track}"`, () => executeTrackDelete(
        project,
        body.track as string,
        {
          token: body.token as string,
          revert: strings(body.revert),
          deleteSpecs: strings(body.deleteSpecs),
          restoreFiles: strings(body.restoreFiles),
          revertGuessed: strings(body.revertGuessed),
        },
        {
          liveSessions: () => sessionManager.getAllSessions().map((s) => ({ id: s.id, cwd: s.cwd })),
          terminateSession: (id) => sessionManager.terminateSession(id),
          cancelJob,
          discardJob,
        }
      ))
    );
  });

  logger.info('Project workspace routes registered');
}

/**
 * Run a board write against the file `target` names. A worktree copy is
 * written holding the project lock (try-only, so a busy project is a 409):
 * Land reads that file and then resets it to its merge-base, and a tick
 * written in between would be overwritten without a trace. Main's file needs
 * no lock — Land leaves backlog edits on main alone.
 */
function writingTo<T>(project: RegistryProject, target: { copy: PlanCopy | null }, fn: () => T): T | Promise<T> {
  if (!target.copy) return fn();
  return withProjectLock(project.cwd, `editing "${target.copy.branch.trackName}"`, async () => fn());
}

/**
 * Run a route body and map the errors it may throw onto the reply. One
 * wrapper for every workspace and track route, sync or async, so each error
 * type answers the same way wherever it is thrown:
 *  - ProjectStoreError: its status, with `conflict` set on the 409 staleness
 *    case (the client reloads and says so);
 *  - TrackDeleteError: its status, with the conflicting files of a failed revert;
 *  - TrackBranchError, ProjectBusyError, WorktreeError: their status and message;
 *  - anything else: 500, logged.
 */
async function withErrors<T>(
  reply: { status: (code: number) => { send: (body: unknown) => unknown } },
  fn: () => T | Promise<T>
): Promise<T | unknown> {
  try {
    return await fn();
  } catch (error) {
    if (error instanceof ProjectStoreError) {
      return reply.status(error.status).send({ error: error.message, conflict: error.status === 409 });
    }
    if (error instanceof TrackDeleteError) {
      return reply.status(error.status).send({ error: error.message, conflicts: error.conflicts });
    }
    if (
      error instanceof TrackBranchError ||
      error instanceof ProjectBusyError ||
      error instanceof WorktreeError
    ) {
      return reply.status(error.status).send({ error: error.message });
    }
    logger.error({ error }, 'project route failed');
    return reply
      .status(500)
      .send({ error: error instanceof Error ? error.message : 'Request failed' });
  }
}
