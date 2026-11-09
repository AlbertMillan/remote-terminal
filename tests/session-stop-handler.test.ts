import { describe, it, expect, beforeEach, vi } from 'vitest';

/**
 * handleSessionStop (project/stop-sessions.md): the viewers refusal and its `force`, that a
 * session's browsers are detached only right before its own kill, and that every target
 * reaches every sidebar even when the stop fails part-way. The connections module is real
 * (its map, detach and broadcast); only the session manager is a stand-in.
 */

const manager = {
  stopTargets: vi.fn((_id: string): string[] => []),
  stopSession: vi.fn(
    async (_id: string, _opts: { targets?: string[]; beforeKill?: (id: string) => void }): Promise<string[]> => []
  ),
  removeClient: vi.fn(),
  getSessionList: vi.fn(() => [] as Record<string, unknown>[]),
};
vi.mock('../src/server/sessions/manager.js', () => ({ sessionManager: manager }));
vi.mock('../src/server/utils/logger.js', () => ({
  createLogger: vi.fn(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() })),
}));

const { connections } = await import('../src/server/websocket/connections.js');
const { handleSessionStop } = await import('../src/server/websocket/handlers/sessions.js');
type Conn = Parameters<typeof handleSessionStop>[0];

const PARENT = 'p-1';
const CHILD = 'c-1';

/** A browser, attached to `sessionId` or to nothing. */
function browser(id: string, sessionId: string | null): Conn & { sent: { type: string; id?: string; payload: any }[] } {
  const sent: { type: string; id?: string; payload: any }[] = [];
  const conn = {
    id,
    ws: { readyState: 1, send: (raw: string) => sent.push(JSON.parse(raw)) },
    identity: null,
    attachedSession: sessionId,
    dataUnsubscribe: vi.fn(),
    exitUnsubscribe: vi.fn(),
    sent,
  } as unknown as Conn & { sent: typeof sent };
  connections.set(id, conn);
  return conn;
}

const stop = (conn: Conn, force?: boolean) =>
  handleSessionStop(conn, { type: 'session.stop', id: '7', payload: { sessionId: PARENT, ...(force ? { force } : {}) } });

const row = (id: string, attachable: boolean) => ({
  id,
  name: id,
  shell: 'cmd.exe',
  cwd: 'C:\\p',
  createdAt: '2026-11-09T10:00:00.000Z',
  lastAccessedAt: '2026-11-09T10:00:00.000Z',
  status: 'idle',
  cols: 80,
  rows: 24,
  attachable,
  account: 'personal',
});

beforeEach(() => {
  vi.clearAllMocks();
  connections.clear();
  manager.stopTargets.mockReturnValue([CHILD, PARENT]);
  manager.getSessionList.mockReturnValue([row(CHILD, false), row(PARENT, false)]);
  // A real stop: each target's browsers detached right before it is killed.
  manager.stopSession.mockImplementation(async (_id, opts) => {
    for (const id of opts.targets ?? []) opts.beforeKill?.(id);
    return opts.targets ?? [];
  });
});

describe('handleSessionStop', () => {
  it('refuses while another browser views a target, naming it, and stops nothing', async () => {
    const me = browser('me', PARENT);
    const other = browser('other', CHILD);

    await stop(me);

    expect(me.sent).toEqual([
      { type: 'session.error', id: '7', payload: { message: 'Another browser is viewing this session', code: 'viewers' } },
    ]);
    expect(manager.stopSession).not.toHaveBeenCalled();
    expect(other.attachedSession).toBe(CHILD);
  });

  it('does not count the requester as another viewer', async () => {
    const me = browser('me', PARENT);
    await stop(me);
    expect(manager.stopSession).toHaveBeenCalled();
  });

  it('with force, stops the checked targets, detaches every viewer and tells every sidebar', async () => {
    const me = browser('me', PARENT);
    const other = browser('other', CHILD);
    const bystander = browser('bystander', null);

    await stop(me, true);

    // The list the viewers check saw, not a fresh one.
    expect(manager.stopSession).toHaveBeenCalledWith(PARENT, expect.objectContaining({ targets: [CHILD, PARENT] }));
    expect(me.attachedSession).toBeNull();
    expect(other.attachedSession).toBeNull();
    expect(me.sent).toContainEqual({ type: 'session.stopped', id: '7', payload: { sessionIds: [CHILD, PARENT] } });
    for (const conn of [me, other, bystander]) {
      const updated = conn.sent.filter((m) => m.type === 'session.updated').map((m) => m.payload.session.id);
      expect(updated).toEqual([CHILD, PARENT]);
    }
  });

  it('a stop that fails part-way leaves the unreached session attached, and still broadcasts every target', async () => {
    const me = browser('me', PARENT);
    // The child stops, then the parent's scrollback write fails before its kill.
    manager.stopSession.mockImplementation(async (_id, opts) => {
      opts.beforeKill?.(CHILD);
      throw new Error('database is locked');
    });
    manager.getSessionList.mockReturnValue([row(CHILD, false), row(PARENT, true)]);

    await stop(me);

    expect(me.attachedSession).toBe(PARENT);
    expect(me.sent).toContainEqual({ type: 'session.error', id: '7', payload: { message: 'database is locked' } });
    const updated = me.sent.filter((m) => m.type === 'session.updated').map((m) => m.payload.session);
    expect(updated.map((s) => [s.id, s.attachable])).toEqual([
      [CHILD, false],
      [PARENT, true],
    ]);
  });

  it('answers a refusal from the manager (a fork, a stopped session) without stopping', async () => {
    const me = browser('me', PARENT);
    manager.stopTargets.mockImplementation(() => {
      throw new Error('Forked sessions cannot be stopped; they could not be resumed');
    });

    await stop(me);

    expect(me.sent).toEqual([
      { type: 'session.error', id: '7', payload: { message: 'Forked sessions cannot be stopped; they could not be resumed' } },
    ]);
    expect(me.attachedSession).toBe(PARENT);
  });
});
