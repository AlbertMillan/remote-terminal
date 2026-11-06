import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { getConfig } from '../config.js';
import { getDatabase } from '../db/schema.js';
import { createLogger } from '../utils/logger.js';
import { FcmSender, parseServiceAccount, type PushMessage, type Transport } from './fcm.js';

/**
 * Push to the Android app (docs/android-app.md). Optional by design: with no service
 * account in `<dataDir>` the server logs once that push is off and every call here is
 * a no-op. A send never throws into its caller — a notification failing is no reason
 * for a session, a job or a Land to.
 *
 * Like the Claude app, a device that is in the foreground (live on the WebSocket and
 * said so with `app.state`) gets no push: it already shows the event.
 */

const logger = createLogger('push');

export const SERVICE_ACCOUNT_FILE = 'firebase-service-account.json';

let sender: FcmSender | null = null;

export interface PushDevice {
  deviceId: string;
  token: string;
  name: string | null;
  updatedAt: string;
}

/** Read the service account; push stays off (and says so once) without one. */
export function initPush(options: { dataDir?: string; transport?: Transport } = {}): boolean {
  const dataDir = options.dataDir ?? getConfig().persistence.dataDir;
  const file = join(dataDir, SERVICE_ACCOUNT_FILE);
  sender = null;
  if (!existsSync(file)) {
    logger.info({ file }, 'push: off (no Firebase service account); the Android app works without it');
    return false;
  }
  const account = parseServiceAccount(readFileSync(file, 'utf8'));
  if (!account) {
    logger.warn({ file }, 'push: off (the service account file is not a Firebase service-account key)');
    return false;
  }
  sender = new FcmSender(account, options.transport);
  logger.info({ project: account.project_id }, 'push: on');
  return true;
}

export function pushEnabled(): boolean {
  return sender !== null;
}

export function registerDevice(deviceId: string, token: string, name: string | null): void {
  const now = new Date().toISOString();
  const db = getDatabase();
  db.transaction(() => {
    db.prepare(
      `INSERT INTO push_devices (device_id, token, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(device_id) DO UPDATE SET token = excluded.token, name = excluded.name, updated_at = excluded.updated_at`
    ).run(deviceId, token, name, now, now);
    // A token belongs to one install: an old row holding it (reinstall, new id) would double every push.
    db.prepare('DELETE FROM push_devices WHERE token = ? AND device_id != ?').run(token, deviceId);
  })();
}

export function unregisterDevice(deviceId: string): void {
  getDatabase().prepare('DELETE FROM push_devices WHERE device_id = ?').run(deviceId);
}

export function listDevices(): PushDevice[] {
  return getDatabase()
    .prepare('SELECT device_id AS deviceId, token, name, updated_at AS updatedAt FROM push_devices ORDER BY created_at')
    .all() as PushDevice[];
}

/**
 * Send to every registered device not in the foreground. Resolves when all sends have
 * settled; drops a device whose token FCM says is gone for good.
 */
export async function pushToDevices(message: PushMessage, isForeground: (deviceId: string) => boolean): Promise<number> {
  const current = sender;
  if (!current) return 0;
  let sent = 0;
  for (const device of listDevices()) {
    if (isForeground(device.deviceId)) continue;
    try {
      const result = await current.send(device.token, message);
      if (result.ok) {
        sent++;
      } else if (result.unregistered) {
        logger.info({ deviceId: device.deviceId }, 'push: token unregistered, dropping the device');
        unregisterDevice(device.deviceId);
      } else {
        logger.warn({ deviceId: device.deviceId, status: result.status, detail: result.detail }, 'push: send failed');
      }
    } catch (error) {
      logger.warn({ deviceId: device.deviceId, error: (error as Error).message }, 'push: send failed');
    }
  }
  return sent;
}

// ---- Messages: data-only, every value a string (FCM's rule); the app builds the notification ----

export function sessionMessage(
  session: { id: string; name: string; claudeName?: string | null },
  type: 'needs-input' | 'completed'
): PushMessage {
  const who = session.claudeName ? `${session.name} · ${session.claudeName}` : session.name;
  return {
    collapseKey: `session-${session.id}`,
    data: {
      kind: 'session',
      event: type,
      sessionId: session.id,
      title: type === 'needs-input' ? `${session.name} needs input` : `${session.name} finished`,
      body: type === 'needs-input' ? `Claude is waiting for you in ${who}.` : `Claude finished in ${who}.`,
    },
  };
}

export function jobGateMessage(job: { id: string; title: string; projectName: string; gate: string | null; parkReason: string | null }): PushMessage {
  const gate = job.gate ?? 'a';
  return {
    collapseKey: `job-${job.id}`,
    data: {
      kind: 'job',
      event: 'parked',
      jobId: job.id,
      title: `${job.projectName}: ${job.title}`,
      body: job.parkReason === 'question' ? 'A question is waiting for your answer.' : `Waiting at the ${gate} gate.`,
    },
  };
}

export function landMessage(land: { projectCwd: string; track: string; ok: boolean; detail: string }): PushMessage {
  return {
    collapseKey: `land-${land.track}`,
    data: {
      kind: 'project',
      event: land.ok ? 'landed' : 'land-failed',
      projectCwd: land.projectCwd,
      // The app tags its notification by track too, matching collapseKey: two tracks
      // landing in one project are two notifications, not one replacing the other.
      track: land.track,
      title: land.ok ? `Landed ${land.track}` : `Land failed: ${land.track}`,
      body: land.detail.slice(0, 300),
    },
  };
}
