import { describe, it, expect, beforeEach, vi } from 'vitest';

/**
 * handleTerminalResize with several viewers of one session: every viewer shares the PTY, so
 * when one changes its size the others are told (`terminal.resized`) and re-attach on their
 * next use; otherwise output drawn for the phone's width lands in a wide browser's scrollback
 * in the wrong cells. The connections module is real; only the session manager is a stand-in.
 */

const session = { id: 's-1', cols: 200, rows: 50 };
const manager = {
  getSession: vi.fn((id: string) => (id === session.id ? { ...session } : undefined)),
  resizeSession: vi.fn((id: string, cols: number, rows: number) => {
    if (id !== session.id) return false;
    session.cols = cols;
    session.rows = rows;
    return true;
  }),
};
vi.mock('../src/server/sessions/manager.js', () => ({ sessionManager: manager }));
vi.mock('../src/server/utils/logger.js', () => ({
  createLogger: vi.fn(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() })),
}));

const { connections } = await import('../src/server/websocket/connections.js');
const { handleTerminalResize } = await import('../src/server/websocket/handlers/sessions.js');
type Conn = Parameters<typeof handleTerminalResize>[0];

function viewer(id: string, sessionId: string | null): Conn & { sent: { type: string; payload: any }[] } {
  const sent: { type: string; payload: any }[] = [];
  const conn = {
    id,
    ws: { readyState: 1, send: (raw: string) => sent.push(JSON.parse(raw)) },
    identity: null,
    attachedSession: sessionId,
    dataUnsubscribe: null,
    exitUnsubscribe: null,
    sent,
  } as unknown as Conn & { sent: typeof sent };
  connections.set(id, conn);
  return conn;
}

const resize = (conn: Conn, cols: number, rows: number) =>
  handleTerminalResize(conn, { type: 'terminal.resize', payload: { sessionId: 's-1', cols, rows } });

beforeEach(() => {
  vi.clearAllMocks();
  connections.clear();
  session.cols = 200;
  session.rows = 50;
});

describe('handleTerminalResize', () => {
  it("tells the session's other viewers the new size, not the resizer or other sessions' viewers", () => {
    const phone = viewer('phone', 's-1');
    const pc = viewer('pc', 's-1');
    const elsewhere = viewer('elsewhere', 's-2');

    resize(phone, 48, 30);

    expect(manager.resizeSession).toHaveBeenCalledWith('s-1', 48, 30);
    expect(pc.sent).toEqual([{ type: 'terminal.resized', payload: { sessionId: 's-1', cols: 48, rows: 30 } }]);
    expect(phone.sent).toEqual([]);
    expect(elsewhere.sent).toEqual([]);
  });

  it('says nothing when the size does not change', () => {
    const phone = viewer('phone', 's-1');
    const pc = viewer('pc', 's-1');

    resize(phone, 200, 50);

    expect(pc.sent).toEqual([]);
  });

  it('ignores a resize from a connection not attached to the session', () => {
    const stranger = viewer('stranger', 's-2');
    const pc = viewer('pc', 's-1');

    resize(stranger, 48, 30);

    expect(manager.resizeSession).not.toHaveBeenCalled();
    expect(pc.sent).toEqual([]);
  });
});
