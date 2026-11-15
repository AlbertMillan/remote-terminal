import { describe, it, expect, beforeEach, vi } from 'vitest';

/**
 * handleSessionChangeAccount (project/move-conversation-account.md): the viewers refusal and
 * its `force`, the answer, the `stopped` code for a move that failed after stopping the
 * session, and the row broadcast either way. The connections module is real; only the
 * session manager is a stand-in.
 */

class ChangeAccountError extends Error {
  constructor(message: string, readonly stopped: boolean) {
    super(message);
  }
}
const manager = {
  isRunning: vi.fn((_id: string) => true),
  changeSessionAccount: vi.fn(
    async (_id: string, _account: string, _opts: { beforeKill?: (id: string) => void }) => ({ resume: true })
  ),
  removeClient: vi.fn(),
  getSessionList: vi.fn(() => [] as Record<string, unknown>[]),
};
vi.mock('../src/server/sessions/manager.js', () => ({ sessionManager: manager, ChangeAccountError }));
vi.mock('../src/server/utils/logger.js', () => ({
  createLogger: vi.fn(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() })),
}));

const { connections } = await import('../src/server/websocket/connections.js');
const { handleSessionChangeAccount } = await import('../src/server/websocket/handlers/sessions.js');
type Conn = Parameters<typeof handleSessionChangeAccount>[0];
type Sent = { type: string; id?: string; payload: any };

const SID = 's-1';

function browser(id: string, sessionId: string | null): Conn & { sent: Sent[] } {
  const sent: Sent[] = [];
  const conn = {
    id,
    ws: { readyState: 1, send: (raw: string) => sent.push(JSON.parse(raw)) },
    identity: null,
    attachedSession: sessionId,
    dataUnsubscribe: vi.fn(),
    exitUnsubscribe: vi.fn(),
    sent,
  } as unknown as Conn & { sent: Sent[] };
  connections.set(id, conn);
  return conn;
}

const move = (conn: Conn, payload: Record<string, unknown> = { sessionId: SID, account: 'work' }) =>
  handleSessionChangeAccount(conn, { type: 'session.changeAccount', id: '9', payload });

const row = {
  id: SID,
  name: 'planner',
  shell: 'cmd.exe',
  cwd: 'C:\\p',
  createdAt: '2026-11-09T10:00:00.000Z',
  lastAccessedAt: '2026-11-09T10:00:00.000Z',
  status: 'idle',
  cols: 80,
  rows: 24,
  attachable: false,
  account: 'work',
  claudeSessionId: '22222222-2222-4222-8222-222222222222',
};

beforeEach(() => {
  vi.clearAllMocks();
  connections.clear();
  manager.isRunning.mockReturnValue(true);
  manager.getSessionList.mockReturnValue([row]);
  manager.changeSessionAccount.mockImplementation(async (id, _account, opts) => {
    opts.beforeKill?.(id);
    return { resume: true };
  });
});

describe('handleSessionChangeAccount', () => {
  it('answers the requester and sends every sidebar the row, with its move field', async () => {
    const me = browser('me', SID);
    const watcher = browser('watcher', null);

    await move(me);

    expect(manager.changeSessionAccount).toHaveBeenCalledWith(SID, 'work', expect.anything());
    expect(me.sent.find((m) => m.id === '9')).toEqual({
      type: 'session.accountChanged',
      id: '9',
      payload: { sessionId: SID, account: 'work', resume: true },
    });
    const update = watcher.sent.find((m) => m.type === 'session.updated');
    expect(update?.payload.session.accountMoveBlocked).toBeNull();
  });

  it('refuses while another browser views a running session, and moves nothing until forced', async () => {
    const me = browser('me', SID);
    const other = browser('other', SID);

    await move(me);
    expect(me.sent.at(-1)).toMatchObject({ type: 'session.error', id: '9', payload: { code: 'viewers' } });
    expect(manager.changeSessionAccount).not.toHaveBeenCalled();

    await move(me, { sessionId: SID, account: 'work', force: true });
    expect(manager.changeSessionAccount).toHaveBeenCalled();
    // The other browser was detached by the stop, as Stop does it.
    expect(other.attachedSession).toBeNull();
  });

  it('lets a stopped session move while someone looks at its scrollback', async () => {
    const me = browser('me', SID);
    browser('other', SID);
    manager.isRunning.mockReturnValue(false);
    await move(me);
    expect(manager.changeSessionAccount).toHaveBeenCalled();
  });

  it('marks a move that failed after stopping the session, and still re-sends the row', async () => {
    const me = browser('me', SID);
    const watcher = browser('watcher', null);
    manager.changeSessionAccount.mockRejectedValue(new ChangeAccountError('Could not move: EBUSY', true));

    await move(me);

    expect(me.sent.find((m) => m.id === '9')).toMatchObject({
      type: 'session.error',
      payload: { message: 'Could not move: EBUSY', code: 'stopped' },
    });
    expect(watcher.sent.some((m) => m.type === 'session.updated')).toBe(true);
  });

  it('gives a refusal no code, and rejects a payload without an account', async () => {
    const me = browser('me', null);
    manager.changeSessionAccount.mockRejectedValue(new Error('A fork can’t move'));
    await move(me);
    expect(me.sent.at(-1)?.payload).toEqual({ message: 'A fork can’t move' });

    await move(me, { sessionId: SID });
    expect(me.sent.at(-1)?.payload.message).toBe('Account required');
  });
});
