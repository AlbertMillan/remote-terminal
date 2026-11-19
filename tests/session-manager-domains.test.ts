// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { CategoryStore } from '../src/client/category-store.js';
import { SessionNotifications, type SessionNotificationsHost } from '../src/client/session-notifications.js';
import { AccountMoves, type AccountMovesHost } from '../src/client/account-moves.js';
import type { ServerMessage, SessionInfo } from '../src/client/session-types.js';

const msg = (m: unknown) => m as ServerMessage;

describe('CategoryStore', () => {
  const sent: [string, unknown][] = [];
  const render = vi.fn();
  let store: CategoryStore;
  beforeEach(() => {
    sent.length = 0;
    render.mockClear();
    store = new CategoryStore({ send: (type, payload) => (sent.push([type, payload]), 'id'), render });
  });

  it('applies every category.* message and redraws once per message', () => {
    const cat = (id: string, sortOrder: number) => ({ id, name: id, sortOrder, collapsed: false });
    expect(store.handleMessage(msg({ type: 'category.list', payload: { categories: [cat('a', 0), cat('b', 1)] } }))).toBe(true);
    store.handleMessage(msg({ type: 'category.created', payload: { category: cat('c', 2) } }));
    store.handleMessage(msg({ type: 'category.renamed', payload: { categoryId: 'a', name: 'Alpha' } }));
    store.handleMessage(msg({ type: 'category.toggled', payload: { categoryId: 'b', collapsed: true } }));
    store.handleMessage(msg({ type: 'category.reordered', payload: { categories: [{ id: 'c', sortOrder: 0 }] } }));
    store.handleMessage(msg({ type: 'category.deleted', payload: { categoryId: 'b' } }));
    expect([...store.categories.values()]).toEqual([
      { id: 'a', name: 'Alpha', sortOrder: 0, collapsed: false },
      { id: 'c', name: 'c', sortOrder: 0, collapsed: false },
    ]);
    expect(render).toHaveBeenCalledTimes(6);
  });

  it('leaves other messages alone', () => {
    expect(store.handleMessage(msg({ type: 'session.list', payload: { sessions: [] } }))).toBe(false);
    expect(render).not.toHaveBeenCalled();
  });

  it('sends the category commands', () => {
    store.list();
    store.create('New');
    store.rename('a', 'B');
    store.remove('a');
    store.toggle('a', true);
    expect(sent).toEqual([
      ['category.list', undefined],
      ['category.create', { name: 'New' }],
      ['category.rename', { categoryId: 'a', name: 'B' }],
      ['category.delete', { categoryId: 'a' }],
      ['category.toggle', { categoryId: 'a', collapsed: true }],
    ]);
  });
});

describe('SessionNotifications', () => {
  const session = { id: 's1', name: 'Build' } as SessionInfo;
  let host: SessionNotificationsHost & { sent: [string, unknown][] };
  let notifications: SessionNotifications;
  beforeEach(() => {
    const sent: [string, unknown][] = [];
    host = {
      sent,
      send: (type, payload) => (sent.push([type, payload]), 'id'),
      session: (id) => (id === 's1' ? session : undefined),
      currentSessionId: () => null,
      attach: vi.fn(),
      renderBadges: vi.fn(),
      preferencesChanged: vi.fn(),
      landed: vi.fn(),
    };
    notifications = new SessionNotifications(host);
  });

  it('badges a session that needs input, unless visual badges are off', () => {
    notifications.handleMessage(msg({ type: 'notification', payload: { sessionId: 's1', type: 'needs-input', timestamp: 't' } }));
    expect(notifications.badges.get('s1')).toEqual({ type: 'needs-input', timestamp: 't' });
    expect(host.renderBadges).toHaveBeenCalledTimes(1);

    notifications.dismiss('s1');
    expect(notifications.badges.has('s1')).toBe(false);
    expect(host.sent).toContainEqual(['notification.dismiss', { sessionId: 's1' }]);

    const prefs = { browserEnabled: false, visualEnabled: false, notifyOnInput: true, notifyOnCompleted: true };
    notifications.handleMessage(msg({ type: 'notification.preferences.updated', payload: prefs }));
    expect(notifications.preferences).toEqual(prefs);
    expect(host.preferencesChanged).toHaveBeenCalled();
    notifications.handleMessage(msg({ type: 'notification', payload: { sessionId: 's1', type: 'completed', timestamp: 't' } }));
    expect(notifications.badges.has('s1')).toBe(false);
  });

  it('ignores a notification for an unknown session', () => {
    notifications.handleMessage(msg({ type: 'notification', payload: { sessionId: 'gone', type: 'completed', timestamp: 't' } }));
    expect(notifications.badges.size).toBe(0);
  });

  it('hands a Land result to the host, never badging', () => {
    notifications.handleMessage(
      msg({ type: 'notification', payload: { kind: 'land', projectCwd: '/p', track: 't', ok: true, detail: 'Landed', timestamp: 't' } })
    );
    expect(host.landed).toHaveBeenCalledWith(true);
    expect(notifications.badges.size).toBe(0);
  });

  it('claims only notification messages', () => {
    expect(notifications.handleMessage(msg({ type: 'category.list', payload: { categories: [] } }))).toBe(false);
  });
});

describe('AccountMoves', () => {
  let host: AccountMovesHost & { sent: [string, unknown][] };
  let moves: AccountMoves;
  let current: string | null;
  const session = { id: 's1', name: 'Build', account: 'work' } as SessionInfo;
  beforeEach(() => {
    current = 's1';
    session.account = 'work';
    const sent: [string, unknown][] = [];
    let n = 0;
    host = {
      sent,
      send: (type, payload) => (sent.push([type, payload]), `m${++n}`),
      launchRetries: new Map(),
      session: (id) => (id === 's1' ? session : undefined),
      currentSessionId: () => current,
      revive: vi.fn(),
      render: vi.fn(),
      menuFinished: vi.fn(),
      showRefusal: vi.fn(),
    };
    moves = new AccountMoves(host);
  });

  it('sends a move, then applies its answer and resumes the session on screen', () => {
    moves.change('s1', 'personal');
    expect(host.sent).toEqual([['session.changeAccount', { sessionId: 's1', account: 'personal' }]]);
    expect(host.launchRetries.has('m1')).toBe(true);

    const handled = moves.handleMessage(
      msg({ type: 'session.accountChanged', id: 'm1', payload: { sessionId: 's1', account: 'personal', resume: true } })
    );
    expect(handled).toBe(true);
    expect(session.account).toBe('personal');
    expect(host.launchRetries.size).toBe(0);
    expect(host.menuFinished).toHaveBeenCalled();
    expect(host.revive).toHaveBeenCalledWith('s1');
  });

  it('does not pull the user back to a session they left', () => {
    moves.change('s1', 'personal');
    current = 'other';
    moves.handleMessage(msg({ type: 'session.accountChanged', id: 'm1', payload: { sessionId: 's1', account: 'personal', resume: true } }));
    expect(host.revive).not.toHaveBeenCalled();
  });

  it('claims only errors that answer a move', () => {
    expect(moves.failed('m9', { message: 'nope' })).toBe(false);
    expect(moves.failed(undefined, { message: 'nope' })).toBe(false);
  });

  it('offers Log in for a refused move, with the move as the retry', () => {
    moves.change('s1', 'personal');
    const refusal = { account: 'personal' } as never;
    expect(moves.failed('m1', { message: 'refused', refusal })).toBe(true);
    expect(host.showRefusal).toHaveBeenCalledWith(refusal, expect.any(Function));
    expect(host.launchRetries.size).toBe(0);
  });

  it('revives a session stopped for a move that failed, while it is on screen', () => {
    moves.change('s1', 'personal');
    expect(moves.failed('m1', { message: 'Copy failed', code: 'stopped' })).toBe(true);
    expect(host.revive).toHaveBeenCalledWith('s1');
  });

  it('forgets moves in flight when the socket drops', () => {
    moves.change('s1', 'personal');
    moves.clear();
    expect(host.launchRetries.size).toBe(0);
    expect(moves.failed('m1', { message: 'late' })).toBe(false);
  });
});
