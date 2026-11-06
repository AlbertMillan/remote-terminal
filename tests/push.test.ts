import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { createVerify, generateKeyPairSync } from 'crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

/**
 * Push to the Android app (docs/android-app.md): the FCM HTTP v1 sender signs its own
 * service-account JWT with node:crypto and talks through an injected transport, so all of
 * it runs here with a fake one. Push must stay optional: no service account, no push, no
 * error.
 */

const dataDir = mkdtempSync(join(tmpdir(), 'cr-push-'));
const configPath = join(dataDir, 'config.json');
writeFileSync(configPath, JSON.stringify({ persistence: { dataDir } }));
process.env.CLAUDE_REMOTE_CONFIG = configPath;

const { loadConfig } = await import('../src/server/config.js');
const { initDatabase, closeDatabase, getDatabase } = await import('../src/server/db/schema.js');
const { FcmSender, signJwt, parseServiceAccount } = await import('../src/server/push/fcm.js');
const push = await import('../src/server/push/push.js');
const { newlyParked } = await import('../src/server/push/wire.js');
const { deviceIdFromUrl } = await import('../src/server/websocket/validation.js');
const { connections, isDeviceForeground, FOREGROUND_STALE_MS, WS_OPEN } = await import('../src/server/websocket/connections.js');

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const account = {
  project_id: 'demo-project',
  client_email: 'push@demo-project.iam.gserviceaccount.com',
  private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
};

interface Call {
  url: string;
  headers: Record<string, string>;
  body: string;
}

/** A transport scripted per URL kind; records every call. */
function fakeTransport(sendStatuses: number[] = [], sendBody = '{}') {
  const calls: Call[] = [];
  let tokens = 0;
  const transport = async (url: string, init: { headers: Record<string, string>; body: string }) => {
    calls.push({ url, ...init });
    if (url.includes('oauth2')) {
      tokens++;
      return { status: 200, body: JSON.stringify({ access_token: `tok-${tokens}`, expires_in: 3600 }) };
    }
    return { status: sendStatuses.shift() ?? 200, body: sendBody };
  };
  return { transport, calls };
}

beforeAll(() => {
  loadConfig();
  initDatabase();
});

afterAll(() => {
  closeDatabase();
  rmSync(dataDir, { recursive: true, force: true });
});

beforeEach(() => {
  getDatabase().exec('DELETE FROM push_devices');
  rmSync(join(dataDir, push.SERVICE_ACCOUNT_FILE), { force: true });
  push.initPush({ dataDir });
});

describe('the FCM service-account JWT', () => {
  it('is RS256 over the claims Google expects, verifiable with the public key', () => {
    const jwt = signJwt(account, 1_000_000);
    const [header, claims, signature] = jwt.split('.');
    expect(JSON.parse(Buffer.from(header, 'base64url').toString())).toEqual({ alg: 'RS256', typ: 'JWT' });
    expect(JSON.parse(Buffer.from(claims, 'base64url').toString())).toEqual({
      iss: account.client_email,
      scope: 'https://www.googleapis.com/auth/firebase.messaging',
      aud: 'https://oauth2.googleapis.com/token',
      iat: 1_000_000,
      exp: 1_003_600,
    });
    const verify = createVerify('RSA-SHA256');
    verify.update(`${header}.${claims}`);
    expect(verify.verify(publicKey, Buffer.from(signature, 'base64url'))).toBe(true);
  });

  it('only accepts a real service-account key file', () => {
    expect(parseServiceAccount(JSON.stringify(account))?.project_id).toBe('demo-project');
    expect(parseServiceAccount('{"type":"authorized_user"}')).toBeNull();
    expect(parseServiceAccount('not json')).toBeNull();
  });
});

describe('FcmSender', () => {
  it('trades the JWT once, then sends a high-priority data message with it', async () => {
    const { transport, calls } = fakeTransport();
    const sender = new FcmSender(account, transport);
    expect(await sender.send('device-token', { data: { kind: 'session', sessionId: 's-1' }, collapseKey: 'session-s-1' })).toEqual({ ok: true });
    expect(await sender.send('device-token', { data: { kind: 'job' } })).toEqual({ ok: true });

    expect(calls.filter((c) => c.url.includes('oauth2'))).toHaveLength(1);
    const exchange = new URLSearchParams(calls[0].body);
    expect(exchange.get('grant_type')).toBe('urn:ietf:params:oauth:grant-type:jwt-bearer');
    expect(exchange.get('assertion')?.split('.')).toHaveLength(3);

    const sends = calls.filter((c) => c.url.includes('fcm.googleapis.com'));
    expect(sends[0].url).toBe('https://fcm.googleapis.com/v1/projects/demo-project/messages:send');
    expect(sends[0].headers.Authorization).toBe('Bearer tok-1');
    expect(JSON.parse(sends[0].body)).toEqual({
      message: {
        token: 'device-token',
        data: { kind: 'session', sessionId: 's-1' },
        android: { priority: 'HIGH', ttl: '3600s', collapse_key: 'session-s-1' },
      },
    });
  });

  it('shares one token exchange between sends that start together', async () => {
    const { transport, calls } = fakeTransport();
    const sender = new FcmSender(account, transport);
    const results = await Promise.all([sender.send('a', { data: {} }), sender.send('b', { data: {} }), sender.send('c', { data: {} })]);
    expect(results).toEqual([{ ok: true }, { ok: true }, { ok: true }]);
    expect(calls.filter((c) => c.url.includes('oauth2'))).toHaveLength(1);
  });

  it('renews the access token when it is about to expire, and once on a 401', async () => {
    let now = 0;
    const { transport, calls } = fakeTransport([401, 200]);
    const sender = new FcmSender(account, transport, () => now);
    expect((await sender.send('t', { data: {} })).ok).toBe(true);
    expect(calls.filter((c) => c.url.includes('oauth2'))).toHaveLength(2);
    now = 3_550_000;
    await sender.send('t', { data: {} });
    expect(calls.filter((c) => c.url.includes('oauth2'))).toHaveLength(3);
  });

  it('reports a token FCM no longer knows as unregistered', async () => {
    const gone = new FcmSender(account, fakeTransport([404]).transport);
    expect(await gone.send('t', { data: {} })).toMatchObject({ ok: false, unregistered: true, status: 404 });
    const invalid = new FcmSender(account, fakeTransport([400], '{"error":{"status":"INVALID_ARGUMENT","details":[{"errorCode":"UNREGISTERED"}]}}').transport);
    expect(await invalid.send('t', { data: {} })).toMatchObject({ ok: false, unregistered: true });
    const busy = new FcmSender(account, fakeTransport([503]).transport);
    expect(await busy.send('t', { data: {} })).toMatchObject({ ok: false, unregistered: false, status: 503 });
  });
});

describe('push to devices', () => {
  it('is off without a service account, and sends nothing', async () => {
    push.registerDevice('device-aaaa', 'token-a', 'Pixel');
    expect(push.pushEnabled()).toBe(false);
    expect(await push.pushToDevices({ data: {} }, () => false)).toBe(0);
  });

  it('stays off for a key file that is not a service account', () => {
    writeFileSync(join(dataDir, push.SERVICE_ACCOUNT_FILE), '{"installed":{}}');
    expect(push.initPush({ dataDir })).toBe(false);
  });

  it('skips a device in the foreground and drops one FCM says is gone', async () => {
    writeFileSync(join(dataDir, push.SERVICE_ACCOUNT_FILE), JSON.stringify(account));
    const { transport, calls } = fakeTransport([404, 200]);
    expect(push.initPush({ dataDir, transport })).toBe(true);
    push.registerDevice('device-gone', 'token-gone', 'Old phone');
    push.registerDevice('device-live', 'token-live', 'Phone');
    push.registerDevice('device-open', 'token-open', 'Tablet');

    const sent = await push.pushToDevices({ data: { kind: 'session' } }, (id) => id === 'device-open');

    expect(sent).toBe(1);
    const targets = calls.filter((c) => c.url.includes('fcm.')).map((c) => JSON.parse(c.body).message.token);
    expect(targets).toEqual(['token-gone', 'token-live']);
    expect(push.listDevices().map((d) => d.deviceId).sort()).toEqual(['device-live', 'device-open']);
  });

  it('keeps one row per install, and moves a token to the install that now holds it', () => {
    push.registerDevice('device-1111', 'token-x', 'Phone');
    push.registerDevice('device-1111', 'token-y', 'Phone');
    push.registerDevice('device-2222', 'token-y', 'Phone (reinstalled)');
    expect(push.listDevices().map((d) => [d.deviceId, d.token])).toEqual([['device-2222', 'token-y']]);
  });
});

describe('what is pushed', () => {
  it('names the session and says what happened, all values strings', () => {
    const m = push.sessionMessage({ id: 's-1', name: 'api', claudeName: 'builder' }, 'needs-input');
    expect(m.data).toEqual({
      kind: 'session',
      event: 'needs-input',
      sessionId: 's-1',
      title: 'api needs input',
      body: 'Claude is waiting for you in api · builder.',
    });
    const land = push.landMessage({ projectCwd: 'C:\\p', track: 'Android app', ok: false, detail: 'x'.repeat(500) });
    expect(land.data.title).toBe('Land failed: Android app');
    expect(land.data.track).toBe('Android app');
    expect(land.data.body).toHaveLength(300);
    for (const value of Object.values(land.data)) expect(typeof value).toBe('string');
  });

  it('announces a job once per wait, not on every write while it stays parked', () => {
    const job = (status: string, stage = 'design', gate: string | null = 'design') =>
      ({ id: 'j-1', status, stage, gate, parkReason: 'gate', title: 't', projectName: 'p' }) as never;
    let state = newlyParked(new Set(), [job('running', 'design', null)]);
    expect(state.parked).toEqual([]);
    state = newlyParked(state.keys, [job('parked')]);
    expect(state.parked).toHaveLength(1);
    state = newlyParked(state.keys, [job('parked')]);
    expect(state.parked).toEqual([]);
    state = newlyParked(state.keys, [job('parked', 'review', 'review')]);
    expect(state.parked).toHaveLength(1);
  });
});

describe('a device in the foreground gets no push', () => {
  const conn = (lastSeenMs: number, foreground = true) =>
    ({ id: 'c', ws: { readyState: WS_OPEN }, deviceId: 'device-1234', foreground, lastSeenMs }) as never;

  it('only while its socket has been heard from lately', () => {
    const now = 10_000_000;
    try {
      connections.set('c', conn(now - 1_000));
      expect(isDeviceForeground('device-1234', now)).toBe(true);
      expect(isDeviceForeground('device-9999', now)).toBe(false);
      // Dropped off the tailnet while on screen: the socket looks open, but nothing arrives.
      connections.set('c', conn(now - FOREGROUND_STALE_MS));
      expect(isDeviceForeground('device-1234', now)).toBe(false);
      connections.set('c', conn(now - 1_000, false));
      expect(isDeviceForeground('device-1234', now)).toBe(false);
    } finally {
      connections.delete('c');
    }
  });
});

describe('the app names its device on the socket', () => {
  it('takes a plain install id from /ws?device=, and nothing else', () => {
    expect(deviceIdFromUrl('/ws?device=6f1c2b9e-0d4a-4e57-9a43-2c1d0e8b7a11')).toBe('6f1c2b9e-0d4a-4e57-9a43-2c1d0e8b7a11');
    expect(deviceIdFromUrl('/ws')).toBeUndefined();
    expect(deviceIdFromUrl('/ws?device=../../x')).toBeUndefined();
    expect(deviceIdFromUrl('/ws?device=short')).toBeUndefined();
  });
});
