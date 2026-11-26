import type { FastifyInstance } from 'fastify';
import { createLogger } from '../utils/logger.js';
import { notificationService } from '../notifications/service.js';
import { factoryEvents } from '../factory/events.js';
import { buildFactorySummary } from '../factory/board.js';
import type { FactoryUnitSummary } from '../../shared/protocol.js';
import type { LandNotificationPayload } from '../websocket/protocol.js';
import {
  initPush,
  factoryWaitMessage,
  landMessage,
  listDevices,
  pushEnabled,
  pushToDevices,
  registerDevice,
  sessionMessage,
  unregisterDevice,
} from './push.js';

/**
 * What the server pushes to the Android app, and when (docs/android-app.md): a session
 * that needs input or finished, a factory unit newly waiting for you, and a Land's result. Each
 * goes to every registered device not in the foreground.
 */

const logger = createLogger('push');

export interface PushDeps {
  /** A device live on the WebSocket in the foreground already shows the event. */
  isForeground: (deviceId: string) => boolean;
  session: (id: string) => { id: string; name: string; claudeName?: string | null } | undefined;
}

let deps: PushDeps | null = null;
let waitingKeys = new Set<string>();

/** A waiting unit's identity for "is this a new wait": the same unit waiting again later, at another step or for another reason, counts. */
function waitKey(unit: FactoryUnitSummary): string {
  return `${unit.key}:${unit.step}:${unit.reason}`;
}

/** Units that wait for you now and did not at the last look; returns the new set too. */
export function newlyWaiting(
  previous: Set<string>,
  units: FactoryUnitSummary[]
): { keys: Set<string>; waiting: FactoryUnitSummary[] } {
  const keys = new Set<string>();
  const waiting: FactoryUnitSummary[] = [];
  for (const unit of units) {
    if (!unit.needsYou) continue;
    const key = waitKey(unit);
    keys.add(key);
    if (!previous.has(key)) waiting.push(unit);
  }
  return { keys, waiting };
}

function send(message: Parameters<typeof pushToDevices>[0]): void {
  const current = deps;
  if (!current || !pushEnabled()) return;
  void pushToDevices(message, current.isForeground).catch((error) =>
    logger.warn({ error: (error as Error).message }, 'push: send failed')
  );
}

export function startPush(pushDeps: PushDeps): void {
  deps = pushDeps;
  initPush();

  notificationService.onNotification((n) => {
    const session = deps?.session(n.sessionId);
    if (session) send(sessionMessage(session, n.type));
  });

  // Seed with what waits already, so a restart does not re-announce old waits.
  try {
    waitingKeys = newlyWaiting(new Set(), buildFactorySummary().units).keys;
  } catch {
    waitingKeys = new Set();
  }
  let queued = false;
  factoryEvents.onChange(() => {
    // Every heartbeat writes: build nothing when push is off.
    if (!pushEnabled()) return;
    // A transition writes several rows; look once they have settled (as the WS feed does).
    if (queued) return;
    queued = true;
    queueMicrotask(() => {
      queued = false;
      try {
        const { keys, waiting } = newlyWaiting(waitingKeys, buildFactorySummary().units);
        waitingKeys = keys;
        for (const unit of waiting) send(factoryWaitMessage(unit));
      } catch (error) {
        logger.warn({ error: (error as Error).message }, 'push: factory check failed');
      }
    });
  });
}

export function pushLandResult(payload: LandNotificationPayload): void {
  send(landMessage(payload));
}

const MAX_TOKEN = 4096;

/**
 * The app registers its FCM token here. Unauthenticated like the rest of /api on the
 * tailnet; the device id is the app's own random install id.
 */
export function registerPushRoutes(app: FastifyInstance): void {
  app.get('/api/push', async () => ({ enabled: pushEnabled(), devices: listDevices().map((d) => ({ name: d.name, updatedAt: d.updatedAt })) }));

  app.post<{ Body?: { deviceId?: unknown; token?: unknown; name?: unknown } }>('/api/push/devices', async (request, reply) => {
    const { deviceId, token, name } = request.body ?? {};
    if (typeof deviceId !== 'string' || !/^[A-Za-z0-9-]{8,64}$/.test(deviceId)) {
      return reply.status(400).send({ error: 'deviceId must be the app install id' });
    }
    if (typeof token !== 'string' || token.length === 0 || token.length > MAX_TOKEN) {
      return reply.status(400).send({ error: 'token must be an FCM registration token' });
    }
    registerDevice(deviceId, token, typeof name === 'string' ? name.slice(0, 100) : null);
    return { enabled: pushEnabled() };
  });

  app.delete<{ Body?: { deviceId?: unknown } }>('/api/push/devices', async (request, reply) => {
    const { deviceId } = request.body ?? {};
    if (typeof deviceId !== 'string') return reply.status(400).send({ error: 'deviceId required' });
    unregisterDevice(deviceId);
    return { ok: true };
  });
}
