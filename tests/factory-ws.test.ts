import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { writeFileSync } from 'fs';
import { join } from 'path';
import { makeTmpDataDir } from './helpers/tmp-data-dir.js';

/**
 * The pushed factory feed (project/code-factory.md, f-c23d5b): every factory
 * write reaches every open socket as one `factory.summary` per burst, built
 * from the store, and nothing is built while nobody listens.
 */

const dataDir = makeTmpDataDir('factory-ws');
const configPath = join(dataDir, 'config.json');
writeFileSync(configPath, JSON.stringify({ persistence: { dataDir } }));
process.env.CLAUDE_REMOTE_CONFIG = configPath;

const { loadConfig } = await import('../src/server/config.js');
const { initDatabase, closeDatabase, getDatabase } = await import('../src/server/db/schema.js');
// Importing the handler subscribes it to the factory's change events.
await import('../src/server/websocket/handler.js');
const { connections, WS_OPEN } = await import('../src/server/websocket/connections.js');
const store = await import('../src/server/factory/store.js');
const board = await import('../src/server/factory/board.js');

beforeAll(() => {
  loadConfig();
  initDatabase();
});
afterAll(() => closeDatabase());
afterEach(() => {
  connections.clear();
  vi.restoreAllMocks();
  getDatabase().exec('DELETE FROM factory_runs; DELETE FROM factory_items');
});

function socket(readyState = WS_OPEN) {
  const send = vi.fn();
  connections.set(`c-${Math.random()}`, { id: 'c', ws: { readyState, send }, identity: null } as never);
  return send;
}

const tick = () => new Promise((r) => setTimeout(r, 0));

describe('factory.summary', () => {
  it('pushes one summary per burst of writes, to every open socket', async () => {
    const build = vi.spyOn(board, 'buildFactorySummary');
    const a = socket();
    const b = socket();
    const closed = socket(3);
    store.createItem({ projectCwd: dataDir, featureId: 'f-aaaaaa', trackName: 'Inbox', workflow: 'item' });
    store.updateItem(dataDir, 'f-aaaaaa', { priority: 1 });
    await tick();
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);
    expect(closed).not.toHaveBeenCalled();
    expect(build).toHaveBeenCalledTimes(1);
    const message = JSON.parse(a.mock.calls[0][0] as string);
    expect(message.type).toBe('factory.summary');
    expect(message.payload.units.map((u: { unitId: string }) => u.unitId)).toEqual(['f-aaaaaa']);
    expect(message.payload.counts.running).toBe(1);
  });

  it('builds nothing while nobody listens', async () => {
    const build = vi.spyOn(board, 'buildFactorySummary');
    store.createItem({ projectCwd: dataDir, featureId: 'f-bbbbbb', trackName: 'Inbox', workflow: 'item' });
    await tick();
    expect(build).not.toHaveBeenCalled();
  });
});
