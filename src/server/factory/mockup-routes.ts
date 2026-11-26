import type { FastifyInstance } from 'fastify';
import { readFile } from 'fs/promises';
import { extname, join } from 'path';
import { getConfig } from '../config.js';
import { createLogger } from '../utils/logger.js';
import { VIEW_HOST } from '../sessions/session-files.js';
import { FactoryEngineError, getDispatcher, releaseParked } from './dispatcher.js';
import { projectHash } from './deps.js';
import {
  MOCKUP_REVISIONS_MAX,
  MOCKUP_WALKTHROUGH,
  mockupDirOf,
  mockupFilePath,
  mockupUrl,
  readMockupState,
  writeMockupState,
} from './mockup-files.js';
import { getRunState, saveRunState, unitIdFor } from './run-state.js';
import { getItem } from './store.js';
import { isTrackWorkflow } from './templates.js';

const logger = createLogger('factory-mockup-routes');

/**
 * The mockup-first step's routes (mockup-step.ts), registered with the board's
 * (board-routes.ts) and, like every `/api/*` route, behind the access gate:
 *
 * - GET  /api/factory/mockup?cwd&unit — what the drawer shows: the page's URL,
 *   the walkthrough, revisions used and left.
 * - GET  /api/factory/mockup/<project hash>/<feature id>/<file> — the mockup's
 *   files, read-only, from that item's mockup folder only. The path is checked
 *   lexically before any filesystem call (mockupFilePath), and every answer is
 *   an opaque-origin sandbox whose loads stay inside the same folder's URL and
 *   whose fetches go nowhere (`mockupCsp`): an agent-written page can't call
 *   the API as you.
 * - POST /api/factory/items/:featureId/mockup/comment — send the mockup back
 *   to its own session with your comment; it revises and parks again. Approve
 *   is the board's release route with `approved`.
 */

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.woff2': 'font/woff2',
  '.md': 'text/plain; charset=utf-8',
};

/** A comment past this is refused rather than cut mid-thought. */
const MAX_COMMENT = 8_000;

const isText = (v: unknown, max = 4096): v is string => typeof v === 'string' && v.length > 0 && v.length <= max;
const FEATURE = /^f-[a-z0-9]+$/;

/**
 * The policy on every mockup answer: `sandbox allow-scripts` without
 * `allow-same-origin` makes the page an opaque origin (its script runs, the
 * clicks work, but it reads nothing of this origin); styles, scripts, images
 * and fonts load only inline or from this item's mockup URL; no fetch, XHR,
 * WebSocket, form, frame or `<base>`. Framing is allowed only by this origin
 * (the board's drawer).
 */
export function mockupCsp(host: string, hash: string, featureId: string): string {
  const tree = `${host}/api/factory/mockup/${hash}/${featureId}/`;
  return [
    'sandbox allow-scripts',
    "default-src 'none'",
    `script-src ${tree} 'unsafe-inline'`,
    `style-src ${tree} 'unsafe-inline'`,
    `img-src ${tree} data: blob:`,
    `font-src ${tree} data:`,
    "connect-src 'none'",
    "form-action 'none'",
    "frame-src 'none'",
    "base-uri 'none'",
    "frame-ancestors 'self'",
  ].join('; ');
}

export interface MockupInfo {
  featureId: string;
  /** The page's URL on the serve route; null until the step wrote one. */
  url: string | null;
  walkthrough: string | null;
  revisions: number;
  maxRevisions: number;
  /** Parked at `mockup`, waiting for you: Approve and (under the cap) Comment apply. */
  waiting: boolean;
  approved: boolean;
}

export interface MockupRouteDeps {
  /** Every filesystem read of these routes; tests count it to prove refusals touch no file. */
  readFile(path: string): Promise<Buffer>;
  dataDir(): string;
}

const defaultDeps: MockupRouteDeps = {
  readFile: (path) => readFile(path),
  dataDir: () => getConfig().persistence.dataDir,
};

export function registerMockupRoutes(app: FastifyInstance, deps: MockupRouteDeps = defaultDeps): void {
  app.get<{ Querystring: { cwd?: string; unit?: string } }>('/api/factory/mockup', async (request, reply) => {
    const { cwd, unit } = request.query;
    if (!isText(cwd) || !isText(unit, 100) || !FEATURE.test(unit)) return reply.status(400).send({ error: 'cwd and a feature id required' });
    const item = getItem(cwd, unit);
    if (!item) return reply.status(404).send({ error: `${unit} is not a factory item` });
    const state = getRunState(cwd, unitIdFor(item, isTrackWorkflow(item.workflow)));
    if (!state) return reply.status(404).send({ error: 'This item has no mockup' });
    const mockup = readMockupState(state.progress);
    let walkthrough: string | null = null;
    if (mockup.ready) {
      try {
        walkthrough = (await deps.readFile(join(mockupDirOf(deps.dataDir(), projectHash(cwd), unit), MOCKUP_WALKTHROUGH))).toString('utf-8');
      } catch {
        // Written after the page; a run cut short between them leaves none.
      }
    }
    const info: MockupInfo = {
      featureId: unit,
      url: mockup.ready ? mockupUrl(cwd, unit) : null,
      walkthrough,
      revisions: mockup.revisions,
      maxRevisions: MOCKUP_REVISIONS_MAX,
      waiting: item.status === 'parked' && state.progress.parked === 'mockup',
      approved: state.progress.outcomes.mockup === 'approved',
    };
    return info;
  });

  app.get<{ Params: { hash: string; featureId: string; '*': string } }>(
    '/api/factory/mockup/:hash/:featureId/*',
    async (request, reply) => {
      const { hash, featureId } = request.params;
      const file = request.params['*'] ?? '';
      const notFound = () => reply.status(404).send({ error: 'File not found' });
      const host = request.headers.host ?? '';
      if (!VIEW_HOST.test(host)) return reply.status(400).send({ error: 'Bad host' });
      // Lexical, before any filesystem call.
      const abs = mockupFilePath(deps.dataDir(), hash, featureId, file);
      if (!abs) {
        logger.warn({ hash, featureId, file: file.slice(0, 200) }, 'factory mockup: refused a path outside the mockup folder');
        return notFound();
      }
      const type = TYPES[extname(abs).toLowerCase()];
      if (!type) return notFound();
      let body: Buffer;
      try {
        body = await deps.readFile(abs);
      } catch {
        return notFound();
      }
      return reply
        .header('Content-Type', type)
        .header('Content-Security-Policy', mockupCsp(host, hash, featureId))
        .header('X-Content-Type-Options', 'nosniff')
        .header('Cache-Control', 'no-store')
        .header('Referrer-Policy', 'no-referrer')
        .send(body);
    }
  );

  app.post<{ Params: { featureId: string }; Body?: { cwd?: unknown; text?: unknown } }>(
    '/api/factory/items/:featureId/mockup/comment',
    async (request, reply) => {
      const { featureId } = request.params;
      const { cwd, text } = request.body ?? {};
      if (!isText(cwd) || !FEATURE.test(featureId)) return reply.status(400).send({ error: 'cwd and a feature id required' });
      if (typeof text !== 'string' || !text.trim()) return reply.status(400).send({ error: 'Say what to change' });
      if (text.length > MAX_COMMENT) return reply.status(400).send({ error: `The comment is too long (at most ${MAX_COMMENT} characters)` });
      const item = getItem(cwd, featureId);
      if (!item) return reply.status(404).send({ error: `${featureId} is not a factory item` });
      const unitId = unitIdFor(item, isTrackWorkflow(item.workflow));
      const state = getRunState(cwd, unitId);
      // Every refusal before any write: a refused comment must not be left behind for the step.
      if (item.status !== 'parked' || state?.progress.parked !== 'mockup') {
        return reply.status(409).send({ error: `${featureId} is not waiting on a mockup` });
      }
      const mockup = readMockupState(state.progress);
      if (mockup.revisions >= MOCKUP_REVISIONS_MAX) {
        return reply
          .status(409)
          .send({ error: `The mockup was revised ${MOCKUP_REVISIONS_MAX} times already; approve it, or cancel the item and file it again` });
      }
      writeMockupState(state.progress, { ...mockup, comment: text.trim() });
      saveRunState(cwd, unitId, { progress: state.progress });
      try {
        releaseParked(cwd, featureId);
      } catch (error) {
        if (error instanceof FactoryEngineError) return reply.status(409).send({ error: error.message });
        throw error;
      }
      void getDispatcher()?.tick();
      return { ok: true, revision: mockup.revisions + 1, maxRevisions: MOCKUP_REVISIONS_MAX };
    }
  );
}
