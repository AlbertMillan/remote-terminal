import type { FastifyInstance } from 'fastify';
import { readFileSync } from 'fs';
import { isAbsolute, join, relative, resolve } from 'path';
import { getConfig } from '../config.js';
import { createLogger } from '../utils/logger.js';
import { git } from '../utils/git.js';
import { buildFactoryBoard, buildFactoryReport } from './board.js';
import { FactoryEngineError, getDispatcher, releaseParked } from './dispatcher.js';
import { requeueMerge } from './merge-queue.js';
import { getRunState, saveRunState, unitIdFor } from './run-state.js';
import { isTrackWorkflow } from './templates.js';
import { getItem } from './store.js';
import { DEFAULT_FACTORY_LIMITS } from './limits.js';

const logger = createLogger('factory-board-routes');

/**
 * The factory board's read side and the user's actions on it
 * (project/code-factory.md, item 7). Every route sits behind the access gate
 * (auth/access-gate.ts), which checks Host, Origin on writes and identity.
 *
 * Intake, shaping, send and triage routes belong to the factory's other half
 * (`/api/factory/add|send|status|items/:id/answer|triage/:id`); these only read
 * the store and hand a parked unit back to the dispatcher.
 */

/** Release outcomes the board may record: the reviewer's park, approved or sent back for changes. */
const OUTCOMES = new Set(['approved', 'changes']);
/** A diff past this is cut: the drawer is a glance, the worktree has the rest. */
const MAX_DIFF = 200_000;
/** A user's note for the fix step, past this, is refused rather than cut mid-thought. */
const MAX_NOTE = 8_000;

const isText = (v: unknown, max = 4096): v is string => typeof v === 'string' && v.length > 0 && v.length <= max;

/** Feature ids (store.ts) or a track unit, `track:<name>`. */
const isUnitId = (v: unknown): v is string => isText(v, 300) && (/^f-[a-z0-9]+$/.test(v) || v.startsWith('track:'));

/**
 * A summary page's path, only if it is inside `<dataDir>/factory`. Checked
 * lexically before any filesystem call: a UNC path reaching `readFileSync`
 * would send the user's NTLM hash to that host (CLAUDE.md, terminal paths).
 */
export function summaryPathAllowed(path: string, dataDir: string): boolean {
  if (/^[\\/]{2}/.test(path) || !isAbsolute(path)) return false;
  const root = resolve(join(dataDir, 'factory'));
  const rel = relative(root, resolve(path));
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
}

export function registerFactoryBoardRoutes(app: FastifyInstance): void {
  app.get<{ Querystring: { cwd?: string } }>('/api/factory/board', async (request, reply) => {
    const cwd = request.query.cwd;
    if (cwd !== undefined && !isText(cwd)) return reply.status(400).send({ error: 'cwd must be a folder path' });
    return buildFactoryBoard({ projectCwd: cwd, dispatch: getDispatcher()?.status() ?? null, limits: DEFAULT_FACTORY_LIMITS });
  });

  app.get<{ Querystring: { since?: string; cwd?: string } }>('/api/factory/report', async (request, reply) => {
    const { since, cwd } = request.query;
    if (!isText(since, 64) || Number.isNaN(Date.parse(since))) return reply.status(400).send({ error: 'since must be an ISO time' });
    if (cwd !== undefined && !isText(cwd)) return reply.status(400).send({ error: 'cwd must be a folder path' });
    return buildFactoryReport(new Date(since).toISOString(), {
      projectCwd: cwd,
      dispatch: getDispatcher()?.status() ?? null,
    });
  });

  // The unit's summary page (what changed, checks, assumptions): what the reviewer, or you, reads.
  app.get<{ Querystring: { cwd?: string; unit?: string } }>('/api/factory/summary', async (request, reply) => {
    const { cwd, unit } = request.query;
    if (!isText(cwd) || !isUnitId(unit)) return reply.status(400).send({ error: 'cwd and unit required' });
    const path = getRunState(cwd, unit)?.progress.notes.summary;
    if (!path) return reply.status(404).send({ error: 'This unit has no summary page yet' });
    if (!summaryPathAllowed(path, getConfig().persistence.dataDir)) {
      logger.warn({ cwd, unit }, 'factory summary path outside the data folder');
      return reply.status(404).send({ error: 'This unit has no summary page yet' });
    }
    try {
      return { markdown: readFileSync(path, 'utf-8') };
    } catch {
      return reply.status(404).send({ error: 'The summary page could not be read' });
    }
  });

  // What the unit changed against its base: stat and patch, cut at MAX_DIFF.
  app.get<{ Querystring: { cwd?: string; unit?: string } }>('/api/factory/diff', async (request, reply) => {
    const { cwd, unit } = request.query;
    if (!isText(cwd) || !isUnitId(unit)) return reply.status(400).send({ error: 'cwd and unit required' });
    const state = getRunState(cwd, unit);
    if (!state?.worktreePath || !state.baseBranch) return reply.status(404).send({ error: 'This unit has no worktree yet' });
    if (state.baseBranch.startsWith('-')) return reply.status(409).send({ error: 'The unit\'s base branch is not a branch name' });
    const range = `${state.baseBranch}...HEAD`;
    const [stat, patch] = await Promise.all([
      git(state.worktreePath, ['diff', '--stat', range, '--']),
      git(state.worktreePath, ['diff', range, '--']),
    ]);
    if (stat === null || patch === null) return reply.status(409).send({ error: 'git could not diff the unit\'s worktree' });
    const truncated = patch.length > MAX_DIFF;
    return { range, stat, patch: truncated ? patch.slice(0, MAX_DIFF) : patch, truncated };
  });

  /**
   * Hand a parked unit back to the dispatcher. `approved` records the review
   * as passed (it merges next); `changes` sends it to the fix step with your
   * note as the findings; no outcome releases a loop cap or runaway park for
   * another round.
   */
  app.post<{ Params: { featureId: string }; Body?: { cwd?: unknown; outcome?: unknown; note?: unknown } }>(
    '/api/factory/items/:featureId/release',
    async (request, reply) => {
      const { featureId } = request.params;
      const { cwd, outcome, note } = request.body ?? {};
      if (!isText(cwd) || !/^f-[a-z0-9]+$/.test(featureId)) return reply.status(400).send({ error: 'cwd and a feature id required' });
      if (outcome !== undefined && (typeof outcome !== 'string' || !OUTCOMES.has(outcome))) {
        return reply.status(400).send({ error: 'outcome must be approved or changes' });
      }
      if (note !== undefined && !isText(note, MAX_NOTE)) return reply.status(400).send({ error: 'note must be text' });
      if (outcome === 'changes' && note === undefined) return reply.status(400).send({ error: 'Say what to change' });
      const item = getItem(cwd, featureId);
      if (!item) return reply.status(404).send({ error: `${featureId} is not a factory item` });
      // Every refusal before any write: a refused "changes" must not leave its note behind.
      if (item.status !== 'parked') return reply.status(409).send({ error: `${featureId} is not parked` });
      const unitId = unitIdFor(item, isTrackWorkflow(item.workflow));
      const state = getRunState(cwd, unitId);
      // Parked by the merge queue: its items reopened would sit handed off, never claimed again.
      if (state?.handedOffAt) {
        return reply.status(409).send({ error: 'This unit is in the merge queue; retry its merge instead' });
      }
      // releaseParked records the outcome against whichever step parked it: an "approved" on a
      // runaway park at implement would skip the step. Outcomes belong to a parked review only.
      if (outcome !== undefined && state?.progress.parked !== 'review') {
        return reply.status(409).send({ error: `${featureId} is not waiting on a review; release it without an outcome` });
      }

      if (outcome === 'changes' && typeof note === 'string') {
        // review-fix reads the findings from the `review` note; yours replace the reviewer's.
        if (state) {
          state.progress.notes.review = `You asked for changes:\n${note}`;
          saveRunState(cwd, unitId, { progress: state.progress });
        }
      }
      try {
        releaseParked(cwd, featureId, outcome ? { outcome } : {});
      } catch (error) {
        if (error instanceof FactoryEngineError) return reply.status(409).send({ error: error.message });
        throw error;
      }
      // Fill the seat now rather than at the next tick.
      void getDispatcher()?.tick();
      return { ok: true };
    }
  );

  // Run a parked merge entry again once you settled what parked it (merge-queue.ts requeueMerge).
  app.post<{ Params: { id: string } }>('/api/factory/merges/:id/retry', async (request, reply) => {
    const { id } = request.params;
    if (!/^mq-[0-9a-f-]+$/.test(id)) return reply.status(400).send({ error: 'Not a merge entry id' });
    const ticket = requeueMerge(id);
    if (!ticket) return reply.status(409).send({ error: 'That merge entry is not parked' });
    // Its outcome arrives through the feed (`done` never rejects); nobody waits on it here.
    return { ok: true, position: ticket.position };
  });
}
