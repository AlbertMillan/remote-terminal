import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

/**
 * The Log in session a refused launch offers (docs/accounts.md): `session.create`
 * with `login: true` opens `claude` in the account's folder, skipping the preflight
 * that refused it, and — when its process exits — tells every connection, so the
 * client that opened it retries even if it has switched to another session since.
 * The session manager is faked; the accounts are fixture folders.
 */

const dataDir = mkdtempSync(join(tmpdir(), 'cr-account-login-'));
const personalDir = join(dataDir, 'claude-personal');
const workDir = join(dataDir, 'claude-work');
const configPath = join(dataDir, 'config.json');
writeFileSync(
  configPath,
  JSON.stringify({
    persistence: { dataDir },
    accounts: {
      personal: { configDir: personalDir, accountUuid: 'acc-personal' },
      work: { configDir: workDir, organizationUuid: 'org-work' },
    },
    defaultAccount: 'personal',
  })
);
process.env.CLAUDE_REMOTE_CONFIG = configPath;

const exitListeners = new Map<string, Set<(code: number) => void>>();
const created: Record<string, unknown>[] = [];
const typed: string[] = [];

vi.mock('../src/server/sessions/manager.js', () => ({
  sessionManager: {
    createSession: vi.fn(async (opts: Record<string, unknown>) => {
      created.push(opts);
      return {
        id: `login-${created.length}`,
        name: opts.name,
        shell: 'pwsh',
        cwd: opts.cwd,
        createdAt: new Date(),
        lastAccessedAt: new Date(),
        status: 'running',
        cols: 80,
        rows: 24,
        account: opts.account,
      };
    }),
    onExit: vi.fn((id: string, listener: (code: number) => void) => {
      if (!exitListeners.has(id)) exitListeners.set(id, new Set());
      exitListeners.get(id)!.add(listener);
      return () => exitListeners.get(id)?.delete(listener);
    }),
    onData: vi.fn(() => () => {}),
    addClient: vi.fn(),
    removeClient: vi.fn(),
  },
}));

vi.mock('../src/server/sessions/session-open.js', () => ({
  injectCommand: vi.fn((_session: unknown, command: string) => typed.push(command)),
}));

vi.mock('../src/server/db/queries.js', async (importActual) => ({
  ...(await importActual<typeof import('../src/server/db/queries.js')>()),
  getSession: vi.fn(() => null),
}));

const { loadConfig } = await import('../src/server/config.js');
const { connections } = await import('../src/server/websocket/connections.js');
const { handleSessionCreate } = await import('../src/server/websocket/handlers/sessions.js');
loadConfig();

afterAll(() => rmSync(dataDir, { recursive: true, force: true }));

/** A fake connection: records what it was sent, by message type. */
function connect(id: string) {
  const sent: { type: string; payload: Record<string, unknown>; id?: string }[] = [];
  const conn = {
    id,
    ws: { readyState: 1, send: (raw: string) => sent.push(JSON.parse(raw)) },
    identity: null,
    attachedSession: null,
    dataUnsubscribe: null,
    exitUnsubscribe: null,
  };
  connections.set(id, conn as never);
  return { conn, sent, of: (type: string) => sent.filter((m) => m.type === type) };
}

function exit(sessionId: string, code = 0): void {
  for (const listener of [...(exitListeners.get(sessionId) ?? [])]) listener(code);
}

beforeEach(() => {
  connections.clear();
  exitListeners.clear();
  created.length = 0;
  typed.length = 0;
});

describe('a Log in session', () => {
  it("opens claude in the account's folder without the preflight that refused the launch", async () => {
    const opener = connect('c1');
    await handleSessionCreate(opener.conn as never, { type: 'session.create', id: 'm1', payload: { account: 'personal', login: true } });
    expect(created[0]).toMatchObject({ account: 'personal', skipPreflight: true, name: 'Log in: personal' });
    expect(typed).toEqual(['claude']);
    expect(opener.of('session.created')[0]).toMatchObject({ id: 'm1', payload: { session: { id: 'login-1', account: 'personal' } } });
  });

  it('tells every connection when it exits, attached to it or not, once', async () => {
    const opener = connect('c1');
    const other = connect('c2');
    await handleSessionCreate(opener.conn as never, { type: 'session.create', id: 'm1', payload: { account: 'personal', login: true } });
    // The opener switched away before the login finished: it is no longer attached.
    opener.conn.attachedSession = null;

    exit('login-1', 0);
    expect(opener.of('session.loginEnded')).toEqual([{ type: 'session.loginEnded', payload: { sessionId: 'login-1', exitCode: 0 } }]);
    expect(other.of('session.loginEnded')).toHaveLength(1);

    // Its listener is gone: nothing more is sent for this session.
    exit('login-1', 0);
    expect(opener.of('session.loginEnded')).toHaveLength(1);
  });

  it('Clean up deletes the org-pushed settings first; an org account refuses it', async () => {
    mkdirSync(personalDir, { recursive: true });
    writeFileSync(join(personalDir, 'remote-settings.json'), '{}');
    const opener = connect('c1');
    await handleSessionCreate(opener.conn as never, { type: 'session.create', id: 'm1', payload: { account: 'personal', login: true, cleanup: true } });
    expect(existsSync(join(personalDir, 'remote-settings.json'))).toBe(false);

    await handleSessionCreate(opener.conn as never, { type: 'session.create', id: 'm2', payload: { account: 'work', login: true, cleanup: true } });
    expect(opener.of('session.error')[0]).toMatchObject({ id: 'm2' });
    expect(created).toHaveLength(1);
  });

  it('refuses an account the config does not define', async () => {
    const opener = connect('c1');
    await handleSessionCreate(opener.conn as never, { type: 'session.create', id: 'm1', payload: { account: 'nobody', login: true } });
    expect(opener.of('session.error')).toHaveLength(1);
    expect(created).toHaveLength(0);
  });
});
