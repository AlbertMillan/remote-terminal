import { describe, it, expect, beforeEach, vi } from 'vitest';
import { homedir } from 'os';
import { join } from 'path';

/**
 * session.create's `createCwd` (project/new-session-folder-picker.md): the handler checks its
 * shape and hands it to createSession, which creates the folder once the launch is admitted
 * (that order is tested in session-manager.test.ts).
 */

const manager = { createSession: vi.fn(async () => ({ id: 's-1' })) };
vi.mock('../src/server/sessions/manager.js', () => ({ sessionManager: manager }));
vi.mock('../src/server/websocket/connections.js', async (orig) => ({
  ...(await orig<typeof import('../src/server/websocket/connections.js')>()),
  attachToSession: vi.fn(),
  sessionToInfo: vi.fn(() => ({})),
}));
vi.mock('../src/server/db/queries.js', async (orig) => ({
  ...(await orig<typeof import('../src/server/db/queries.js')>()),
  getSession: vi.fn(() => null),
}));
vi.mock('../src/server/utils/logger.js', () => ({
  createLogger: vi.fn(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() })),
}));

const { handleSessionCreate } = await import('../src/server/websocket/handlers/sessions.js');
type Conn = Parameters<typeof handleSessionCreate>[0];

function browser(): Conn & { sent: { type: string; payload: { message?: string } }[] } {
  const sent: { type: string; payload: { message?: string } }[] = [];
  return { ws: { readyState: 1, send: (raw: string) => sent.push(JSON.parse(raw)) }, sent } as unknown as Conn & {
    sent: typeof sent;
  };
}

const create = (conn: Conn, payload: Record<string, unknown>) =>
  handleSessionCreate(conn, { type: 'session.create', id: '1', payload });

beforeEach(() => {
  manager.createSession.mockClear();
});

describe('session.create with createCwd', () => {
  it('hands createSession the options as booleans and the folder as an absolute path', async () => {
    await create(browser(), { cwd: '~/NodeProjects/new-thing', createCwd: { git: true, projectDoc: 'yes' } });
    expect(manager.createSession).toHaveBeenCalledWith(
      expect.objectContaining({
        cwd: join(homedir(), 'NodeProjects', 'new-thing'),
        createCwd: { git: true, projectDoc: false },
      })
    );
  });

  it('refuses a malformed createCwd before any session is asked for', async () => {
    const conn = browser();
    await create(conn, { cwd: '~/NodeProjects/x', createCwd: 'please' });
    expect(manager.createSession).not.toHaveBeenCalled();
    expect(conn.sent.map((m) => m.type)).toEqual(['session.error']);
  });

  it('refuses createCwd without a folder', async () => {
    const conn = browser();
    await create(conn, { createCwd: { git: true, projectDoc: true } });
    expect(manager.createSession).not.toHaveBeenCalled();
    expect(conn.sent[0]?.payload.message).toContain('createCwd');
  });
});
