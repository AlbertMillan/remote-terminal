import type { FastifyInstance } from 'fastify';
import {
  getConfig,
  setServerSettings,
  LIMIT_SETTINGS,
  MAX_SESSIONS_RANGE,
  MAX_PER_PARENT_RANGE,
  type LimitKey,
  type ServerSettingsPatch,
} from './config.js';
import { countActiveSessions } from './db/queries.js';
import { createLogger } from './utils/logger.js';
import { isAllowedWebSocketOrigin } from './websocket/origin.js';
import { extractIpFromRequest, verifyTailscaleConnection } from './auth/tailscale.js';

const logger = createLogger('server-settings');

export interface ServerSettingsDeps {
  verify?: (ip: string) => Promise<unknown>;
  /** What the limit is checked against; tests pass their own instead of opening the DB. */
  countSessions?: () => number;
}

/** Settings that live in the server's config file, edited from the Settings modal. */
export function registerServerSettingsRoutes(app: FastifyInstance, deps: ServerSettingsDeps = {}): void {
  const verify = deps.verify ?? verifyTailscaleConnection;
  const countSessions = deps.countSessions ?? countActiveSessions;

  // `counted` is the number the limit is checked against: every session not closed,
  // including stale ones waiting to be revived after a restart (docs/session-revive.md).
  const view = () => ({
    maxSessions: getConfig().sessions.maxSessions,
    range: MAX_SESSIONS_RANGE,
    counted: countSessions(),
    // Live started sessions one session may have (docs/session-orchestration.md).
    maxPerParent: getConfig().agentSessions.maxPerParent,
    maxPerParentRange: MAX_PER_PARENT_RANGE,
  });

  app.get('/api/server/settings', async () => view());

  app.put<{ Body?: Record<string, unknown> }>('/api/server/settings', async (request, reply) => {
    // /api/* is otherwise open on 0.0.0.0, and this writes to disk: the same
    // checks as Restart, so neither another site nor the tailnet can change it.
    if (!isAllowedWebSocketOrigin(request.headers.origin, request.headers.host)) {
      logger.warn({ origin: request.headers.origin }, 'settings write rejected: cross-origin');
      return reply.status(403).send({ error: 'Cross-origin request refused' });
    }
    if (!(await verify(extractIpFromRequest(request)))) {
      return reply.status(403).send({ error: 'Not authorized' });
    }

    // Every key sent is checked before any is written: a refusal changes nothing.
    const body = request.body ?? {};
    const patch: ServerSettingsPatch = {};
    for (const key of Object.keys(LIMIT_SETTINGS) as LimitKey[]) {
      if (!Object.prototype.hasOwnProperty.call(body, key)) continue;
      const { range, label } = LIMIT_SETTINGS[key];
      const value = body[key];
      if (typeof value !== 'number' || !Number.isInteger(value) || value < range.min || value > range.max) {
        return reply.status(400).send({ error: `${label} must be a whole number from ${range.min} to ${range.max}` });
      }
      patch[key] = value;
    }
    if (Object.keys(patch).length === 0) {
      return reply.status(400).send({ error: `Nothing to change: send one of ${Object.keys(LIMIT_SETTINGS).join(', ')}` });
    }

    try {
      setServerSettings(patch);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error({ error: message }, 'could not save the session limits');
      // Generic: the message can name the config path and quote part of the file.
      return reply.status(500).send({ error: 'Could not save the session limits; the server log has the reason.' });
    }
    return view();
  });
}
