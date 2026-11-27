import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

/**
 * The Android app speaks /ws with Kotlin types that mirror protocol.ts (docs/android-app.md).
 * Both test suites read tests/fixtures/protocol/messages.json: this half fails when the
 * server's protocol moves away from the fixture (a new message type, a new field on a
 * session, category, factory unit or merge entry), and the app's ProtocolFixtureTest fails when its Kotlin types
 * no longer decode the fixture. Together a protocol change cannot land with the app behind.
 */

const dataDir = mkdtempSync(join(tmpdir(), 'cr-protocol-fixture-'));
const configPath = join(dataDir, 'config.json');
writeFileSync(configPath, JSON.stringify({ persistence: { dataDir } }));
process.env.CLAUDE_REMOTE_CONFIG = configPath;

const { loadConfig } = await import('../src/server/config.js');
const { initDatabase, closeDatabase } = await import('../src/server/db/schema.js');
const { CLIENT_MESSAGE_TYPES, SERVER_MESSAGE_TYPES } = await import('../src/server/websocket/protocol.js');
const { sessionToInfo, categoryToInfo } = await import('../src/server/websocket/connections.js');
const factory = await import('../src/server/factory/store.js');
const mergeStore = await import('../src/server/factory/merge-queue-store.js');
const { buildFactorySummary } = await import('../src/server/factory/board.js');

interface FixtureMessage {
  type: string;
  id?: string;
  payload?: unknown;
}

interface Fixture {
  shapes: Record<'session' | 'category' | 'unit' | 'merge', Record<string, unknown>>;
  client: FixtureMessage[];
  server: FixtureMessage[];
}

const fixture = JSON.parse(
  readFileSync(join(__dirname, 'fixtures', 'protocol', 'messages.json'), 'utf8')
) as Fixture;

beforeAll(() => {
  loadConfig();
  initDatabase();
});

afterAll(() => {
  closeDatabase();
  rmSync(dataDir, { recursive: true, force: true });
});

const sorted = (values: Iterable<string>) => [...new Set(values)].sort();

describe('protocol fixture', () => {
  it('has an example of every client message type, and no other', () => {
    expect(sorted(fixture.client.map((m) => m.type))).toEqual(sorted(CLIENT_MESSAGE_TYPES));
  });

  it('has an example of every server message type, and no other', () => {
    expect(sorted(fixture.server.map((m) => m.type))).toEqual(sorted(SERVER_MESSAGE_TYPES));
  });

  it('describes a session with exactly the fields the server sends', () => {
    const info = sessionToInfo({
      id: 's-1',
      name: 'shell',
      shell: 'pwsh.exe',
      cwd: dataDir,
      createdAt: new Date(),
      lastAccessedAt: new Date(),
      status: 'running',
      cols: 80,
      rows: 24,
    });
    expect(sorted(Object.keys(fixture.shapes.session))).toEqual(sorted(Object.keys(info)));
  });

  it('describes a category with exactly the fields the server sends', () => {
    const info = categoryToInfo({ id: 'c-1', name: 'Games', sortOrder: 0, collapsed: false });
    expect(sorted(Object.keys(fixture.shapes.category))).toEqual(sorted(Object.keys(info)));
  });

  it('describes a factory unit, its features and a merge entry with exactly the fields the server sends', () => {
    factory.createItem({ projectCwd: dataDir, featureId: 'f-t1', trackName: 'T', workflow: 'track' });
    mergeStore.insertMerge({ projectCwd: dataDir, kind: 'track', branch: 'track/t', worktreePath: dataDir, baseBranch: 'main', featureIds: ['f-t1'], trackName: 'T' });
    const summary = buildFactorySummary();
    const [unit] = summary.units;
    expect(sorted(Object.keys(fixture.shapes.unit))).toEqual(sorted(Object.keys(unit)));
    const featureKeys = Object.keys((fixture.shapes.unit.features as Record<string, unknown>[])[0]);
    expect(sorted(featureKeys)).toEqual(sorted(Object.keys(unit.features[0])));
    expect(sorted(Object.keys(fixture.shapes.merge))).toEqual(sorted(Object.keys(summary.merges[0])));
    const message = fixture.server.find((m) => m.type === 'factory.summary')?.payload as Record<string, unknown>;
    expect(sorted(Object.keys(message))).toEqual(sorted(Object.keys(summary)));
    expect(sorted(Object.keys(message.counts as object))).toEqual(sorted(Object.keys(summary.counts)));
    expect(sorted(Object.keys(message.dispatch as object))).toEqual(sorted(Object.keys(summary.dispatch)));
  });

  it('refers only to shapes it defines', () => {
    const refs = JSON.stringify([fixture.client, fixture.server]).match(/"\$[a-z]+"/g) ?? [];
    for (const ref of refs) {
      expect(Object.keys(fixture.shapes)).toContain(ref.slice(2, -1));
    }
  });
});

describe('app.state', () => {
  it('marks a device foreground only while its socket is open and it said so', async () => {
    const { connections, isDeviceForeground, WS_OPEN } = await import('../src/server/websocket/connections.js');
    const conn = (id: string, deviceId: string | undefined, foreground: boolean, readyState = WS_OPEN) =>
      ({ id, deviceId, foreground, lastSeenMs: Date.now(), ws: { readyState }, identity: null, attachedSession: null, dataUnsubscribe: null, exitUnsubscribe: null }) as never;
    connections.set('browser', conn('browser', undefined, true));
    connections.set('phone', conn('phone', 'device-1111', false));
    expect(isDeviceForeground('device-1111')).toBe(false);
    connections.set('phone', conn('phone', 'device-1111', true));
    expect(isDeviceForeground('device-1111')).toBe(true);
    connections.set('phone', conn('phone', 'device-1111', true, 3));
    expect(isDeviceForeground('device-1111')).toBe(false);
    connections.delete('browser');
    connections.delete('phone');
  });
});
