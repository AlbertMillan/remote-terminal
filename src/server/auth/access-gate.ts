import type { FastifyInstance } from 'fastify';
import { createLogger } from '../utils/logger.js';
import { isAllowedHost, isGuardedRequest } from '../host-check.js';
import { isAllowedWebSocketOrigin } from '../websocket/origin.js';
import { extractIpFromRequest, verifyTailscaleConnection } from './tailscale.js';

const logger = createLogger('access-gate');

/** Methods a page may send cross-origin without changing anything. */
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export interface AccessGateDeps {
  /** `server.hostname` and `server.allowedHosts`, read per request (Settings may change them). */
  hosts: () => (string | undefined)[];
  verify?: (ip: string) => Promise<unknown>;
}

/**
 * The one gate in front of every `/api/*` and `/ws` request (docs/auth.md). Register it before
 * any route, so every route and plugin scope inherits it. In order:
 *
 * 1. **Host** (DNS rebinding, `host-check.ts`): a page on another domain pointed at our IP
 *    would otherwise read every answer as the user.
 * 2. **Origin** on a state-changing request: loopback is trusted, so without it any site the
 *    user visits could POST to `http://127.0.0.1:4220`. A request with no Origin is not a
 *    page's (the statusline, hooks, the Android app).
 * 3. **Identity**: loopback, or a caller `tailscale whois` names. The server listens on
 *    0.0.0.0, so anything less hands the LAN a shell and the job pipeline's `Bash`.
 *
 * The route is judged on what the router matched (`isGuardedRequest`), never the raw URL:
 * the router percent-decodes, so `/%61pi/…` would otherwise skip all three.
 */
export function registerAccessGate(app: FastifyInstance, deps: AccessGateDeps): void {
  const verify = deps.verify ?? verifyTailscaleConnection;

  app.addHook('onRequest', async (request, reply) => {
    if (!isGuardedRequest(request.url, request.routeOptions.url)) return;
    if (!isAllowedHost(request.headers.host, deps.hosts())) {
      logger.warn({ host: request.headers.host, url: request.url }, 'Refused a request for an unknown host');
      return reply.status(421).send({ error: 'Unknown host; add it to server.allowedHosts in config.json' });
    }
    if (!SAFE_METHODS.has(request.method) && !isAllowedWebSocketOrigin(request.headers.origin, request.headers.host)) {
      logger.warn({ origin: request.headers.origin, url: request.url }, 'Refused a cross-origin request');
      return reply.status(403).send({ error: 'Cross-origin request refused' });
    }
    const ip = extractIpFromRequest(request);
    if (!(await verify(ip))) {
      logger.warn({ ip, url: request.url }, 'Refused a caller with no Tailscale identity');
      return reply.status(403).send({ error: 'Not authorized: connect over Tailscale' });
    }
  });
}
