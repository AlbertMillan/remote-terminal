import { describe, it, expect, beforeEach, beforeAll, afterAll, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import Fastify from 'fastify';

// Pass-through spies: every call is real, and the tests can count them — how
// often the snapshot is written, and whether the script path is looked up.
vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  return { ...actual, existsSync: vi.fn(actual.existsSync), renameSync: vi.fn(actual.renameSync) };
});
const writes = () => vi.mocked(renameSync).mock.calls.length;

// Who is logged in where, and which sessions exist, as the route sees them
// (account-watch's cached preflight and the sessions table). Each test sets its own.
const logins = new Map<string, unknown>();
const flagged = new Map<string, string>();
const sessionRows = new Map<string, { account: string }>();
const okLogin = (account: string) => ({ ok: true, account, configDir: 'x', found: { accountUuid: `login-${account}` } });
vi.mock('../src/server/sessions/account-watch.js', () => ({
  accountLogin: vi.fn((account: string) => (logins.has(account) ? logins.get(account) : okLogin(account))),
  accountWarningFor: vi.fn((id: string) => flagged.get(id) ?? null),
}));
vi.mock('../src/server/db/queries.js', () => ({
  getSession: vi.fn((id: string) => sessionRows.get(id) ?? null),
}));

/**
 * Plan-usage readings relayed from Claude Code's status line.
 *
 * Every open session reports, and an idle one can re-render its status line
 * with limits it cached long ago — so arrival order means nothing. What must
 * hold is that a stale reading never lowers the figure, a new window replaces
 * an old one, and nothing implausible from the network is ever shown.
 */

const dataDir = mkdtempSync(join(tmpdir(), 'cr-plan-'));
const configPath = join(dataDir, 'config.json');
writeFileSync(configPath, JSON.stringify({ persistence: { dataDir } }));
process.env.CLAUDE_REMOTE_CONFIG = configPath;

const { loadConfig } = await import('../src/server/config.js');
const plan = await import('../src/server/usage/plan-limits.js');
const { registerPlanUsageRoutes, statuslineCommand } = await import('../src/server/usage/plan-routes.js');

// The real clock, not a fixed date: loadSnapshot() re-validates reset times
// against Date.now(), so a hard-coded NOW expires the readings a day after it.
const NOW = Date.now();
const inHours = (h: number) => Math.round(NOW / 1000 + h * 3600);
const snapshotFile = join(dataDir, 'plan-usage.json');
/** The default folder's account's entry in the file: readings with no folder named are its. */
const onDiskOf = (text: string) => JSON.parse(text).accounts.work;
/** The account these readings are recorded under: the default folder's, as a relay post without `config_dir`. */
const A = 'work';
/** A reading verified as A's login. */
const OK = { verified: true as const, loginUuid: 'login-work' };
const onDisk = () => onDiskOf(readFileSync(snapshotFile, 'utf8'));

/** A status line payload, trimmed to what matters. */
function payload(five: number | null, seven: number | null, fiveResets = inHours(2), sevenResets = inHours(96)) {
  return {
    model: { display_name: 'Opus 5' },
    rate_limits: {
      ...(five !== null ? { five_hour: { used_percentage: five, resets_at: fiveResets } } : {}),
      ...(seven !== null ? { seven_day: { used_percentage: seven, resets_at: sevenResets } } : {}),
    },
  };
}

beforeAll(() => loadConfig());
afterAll(() => rmSync(dataDir, { recursive: true, force: true }));
beforeEach(() => {
  rmSync(snapshotFile, { force: true });
  plan.loadSnapshot();
  logins.clear();
  flagged.clear();
  sessionRows.clear();
});

describe('recording readings', () => {
  it('stores both windows from a status line payload', () => {
    expect(plan.recordReading(payload(55, 22), A, OK, NOW)).toBe(true);
    const snap = plan.getSnapshot(A)!;
    expect(snap.fiveHour).toMatchObject({ usedPercentage: 55, resetsAt: inHours(2) });
    expect(snap.sevenDay).toMatchObject({ usedPercentage: 22, resetsAt: inHours(96) });
  });

  it('ignores a payload with no limits — normal before a session’s first response', () => {
    expect(plan.recordReading({ model: { display_name: 'Opus 5' } }, A, OK, NOW)).toBe(false);
    expect(plan.getSnapshot(A)).toBeNull();
  });

  it('never lets a stale session lower the figure within a window', () => {
    plan.recordReading(payload(55, 22), A, OK, NOW);
    plan.recordReading(payload(30, 10), A, OK, NOW + 60_000); // an idle session's cached limits
    expect(plan.getSnapshot(A)!.fiveHour!.usedPercentage).toBe(55);
    expect(plan.getSnapshot(A)!.sevenDay!.usedPercentage).toBe(22);
  });

  it('lets a new window replace the old one, even at a lower percentage', () => {
    plan.recordReading(payload(90, 22), A, OK, NOW);
    plan.recordReading(payload(3, 22, inHours(7)), A, OK, NOW + 60_000);
    expect(plan.getSnapshot(A)!.fiveHour).toMatchObject({ usedPercentage: 3, resetsAt: inHours(7) });
  });

  it('refreshes the observation time when a reading confirms the value', () => {
    plan.recordReading(payload(55, 22), A, OK, NOW);
    plan.recordReading(payload(55, 22), A, OK, NOW + 5 * 60_000);
    expect(plan.getSnapshot(A)!.fiveHour!.observedAt).toBe(new Date(NOW + 5 * 60_000).toISOString());
  });

  it('keeps a window the next payload omits', () => {
    plan.recordReading(payload(55, 22), A, OK, NOW);
    plan.recordReading(payload(60, null), A, OK, NOW + 60_000);
    expect(plan.getSnapshot(A)!.sevenDay!.usedPercentage).toBe(22);
    expect(plan.getSnapshot(A)!.fiveHour!.usedPercentage).toBe(60);
  });

  it.each([
    ['a percentage over 100', payload(140, 22)],
    ['a negative percentage', payload(-1, 22)],
    ['a non-numeric percentage', { rate_limits: { five_hour: { used_percentage: '55', resets_at: inHours(2) } } }],
    ['a reset time a month out', payload(55, null, inHours(24 * 30))],
    ['a reset time long past', payload(55, null, inHours(-48))],
    ['a reset time in milliseconds', payload(55, null, inHours(2) * 1000)],
  ])('rejects %s and leaves the snapshot alone', (_label, body) => {
    plan.recordReading(payload(40, 20), A, OK, NOW);
    plan.recordReading(body, A, OK, NOW + 60_000);
    expect(plan.getSnapshot(A)!.fiveHour!.usedPercentage).toBe(40);
  });
});

describe('verification against the login', () => {
  const FLAGGED = { verified: false as const, reason: 'session-flagged' as const };
  const MISMATCH = { verified: false as const, reason: 'login-mismatch' as const };

  it.each([
    ['a session account-watch flagged', FLAGGED],
    ['a folder whose login mismatches', MISMATCH],
  ])('holds back a reading from %s, leaving the snapshot alone', (_label, verdict) => {
    plan.recordReading(payload(40, 20), A, OK, NOW);
    const before = writes();
    expect(plan.recordReading(payload(90, 80, inHours(4), inHours(150)), A, verdict, NOW + 60_000)).toBe(true);
    expect(plan.getSnapshot(A)!.fiveHour).toMatchObject({ usedPercentage: 40, resetsAt: inHours(2) });
    expect(plan.getSnapshot(A)!.sevenDay).toMatchObject({ usedPercentage: 20, resetsAt: inHours(96) });
    expect(plan.getHeld(A)).toMatchObject([
      { window: 'sevenDay', usedPercentage: 80, reason: verdict.reason },
      { window: 'fiveHour', usedPercentage: 90, reason: verdict.reason },
    ]);
    expect(writes()).toBe(before);
  });

  it('keeps the held-back list bounded: one entry per window and reset, at most ten', () => {
    for (let i = 0; i < 50; i++) plan.recordReading(payload(i, null), A, MISMATCH, NOW + i);
    expect(plan.getHeld(A)).toHaveLength(1);
    expect(plan.getHeld(A)[0]).toMatchObject({ usedPercentage: 49, arrivedAt: new Date(NOW + 49).toISOString() });
    for (let i = 0; i < 30; i++) plan.recordReading(payload(5, null, inHours(1 + i / 10)), A, MISMATCH, NOW + i);
    expect(plan.getHeld(A)).toHaveLength(10);
  });

  it('lets a verified reading for a new login replace a window with a later reset (the pinning bug)', () => {
    // Another login's reading under this account, with a later reset: it used to
    // block every true reading until it expired.
    plan.recordReading(payload(0, 0, inHours(4), inHours(150)), A, { verified: true, loginUuid: 'someone-else' }, NOW);
    plan.recordReading(payload(12, 33, inHours(2), inHours(60)), A, OK, NOW + 60_000);
    expect(plan.getSnapshot(A)!.fiveHour).toMatchObject({ usedPercentage: 12, resetsAt: inHours(2), loginUuid: 'login-work' });
    expect(plan.getSnapshot(A)!.sevenDay).toMatchObject({ usedPercentage: 33, resetsAt: inHours(60) });
  });

  it('restores a file written before verification as held back, then discards it', () => {
    // The per-account file as written before this: no loginUuid on its windows.
    writeFileSync(
      snapshotFile,
      JSON.stringify({
        accounts: {
          work: {
            fiveHour: { usedPercentage: 7, resetsAt: inHours(3), observedAt: new Date(NOW).toISOString() },
            sevenDay: { usedPercentage: 0, resetsAt: inHours(100), observedAt: new Date(NOW).toISOString() },
            relaySeenAt: new Date(NOW).toISOString(),
          },
        },
      })
    );
    plan.loadSnapshot();
    expect(plan.getSnapshot('work')).toBeNull();
    expect(plan.getRelaySeenAt('work')).toBe(new Date(NOW).toISOString());
    const held = plan.getHeld('work');
    expect(held.map((h) => h.reason)).toEqual(['unverified-legacy', 'unverified-legacy']);

    expect(plan.discardHeld({ id: held[0].id })).toBe(1);
    expect(plan.getHeld('work')).toHaveLength(1);
    expect(plan.discardHeld({ account: 'work' })).toBe(1);
    expect(plan.getHeld()).toEqual([]);
  });

  it('restores a verified window with its login', () => {
    plan.recordReading(payload(55, 22), A, OK, NOW);
    plan.loadSnapshot();
    expect(plan.getSnapshot(A)!.fiveHour).toMatchObject({ usedPercentage: 55, loginUuid: 'login-work' });
    expect(plan.getHeld(A)).toEqual([]);
  });
});

describe('persistence', () => {
  it('survives a restart', () => {
    plan.recordReading(payload(55, 22, inHours(2), inHours(96)), A, OK, Date.now());
    expect(existsSync(snapshotFile)).toBe(true);
    plan.loadSnapshot();
    expect(plan.getSnapshot(A)!.fiveHour!.usedPercentage).toBe(55);
  });

  it('starts empty from an unreadable file rather than failing', () => {
    writeFileSync(snapshotFile, '{ not json');
    plan.loadSnapshot();
    expect(plan.getSnapshot(A)).toBeNull();
  });

  it('re-validates what it reads back', () => {
    writeFileSync(
      snapshotFile,
      JSON.stringify({ fiveHour: { usedPercentage: 400, resetsAt: inHours(2), observedAt: 'x' }, sevenDay: null })
    );
    plan.loadSnapshot();
    expect(plan.getSnapshot(A)).toBeNull();
    expect(JSON.parse(readFileSync(snapshotFile, 'utf8')).fiveHour.usedPercentage).toBe(400);
  });
});

describe('writing the snapshot', () => {
  it('writes when a figure changes, not on every render that re-confirms it', () => {
    // Every session's status line posts on every render; only a changed
    // percentage or reset time is worth a synchronous write and rename.
    plan.recordReading(payload(55, 22), A, OK, NOW);
    const afterFirst = writes();
    for (let i = 1; i <= 20; i++) plan.recordReading(payload(55, 22), A, OK, NOW + i * 1000);
    expect(writes()).toBe(afterFirst);

    plan.recordReading(payload(56, 22), A, OK, NOW + 30_000);
    expect(writes()).toBe(afterFirst + 1);
    expect(onDisk().fiveHour.usedPercentage).toBe(56);
  });

  it('does not write for a stale reading the merge throws away', () => {
    plan.recordReading(payload(55, 22), A, OK, NOW);
    const before = writes();
    plan.recordReading(payload(30, 10), A, OK, NOW + 1000);
    expect(writes()).toBe(before);
  });

  it('does not rewrite an unchanged file after a restart', () => {
    plan.recordReading(payload(55, 22), A, OK, NOW);
    plan.loadSnapshot();
    const before = writes();
    plan.recordReading(payload(55, 22), A, OK, NOW + 1000);
    expect(writes()).toBe(before);
  });
});

describe('relay contact', () => {
  it('counts a post without limits as contact, without inventing a reading', () => {
    expect(plan.recordReading({ rate_limits: null }, A, OK, NOW)).toBe(false);
    expect(plan.getSnapshot(A)).toBeNull();
    expect(plan.getRelaySeenAt(A)).toBe(new Date(NOW).toISOString());
  });

  it('persists contact the first time, then at most hourly — the relay posts on every render', () => {
    plan.recordReading({ rate_limits: null }, A, OK, NOW);
    const first = readFileSync(snapshotFile, 'utf8');
    expect(onDiskOf(first).relaySeenAt).toBe(new Date(NOW).toISOString());

    plan.recordReading({ rate_limits: null }, A, OK, NOW + 10 * 60_000);
    expect(readFileSync(snapshotFile, 'utf8')).toBe(first); // not rewritten
    expect(plan.getRelaySeenAt(A)).toBe(new Date(NOW + 10 * 60_000).toISOString()); // but current in memory

    plan.recordReading({ rate_limits: null }, A, OK, NOW + 70 * 60_000);
    expect(onDisk().relaySeenAt).toBe(
      new Date(NOW + 70 * 60_000).toISOString()
    );
  });

  it('remembers contact across a restart, even with no reading', () => {
    plan.recordReading({ rate_limits: null }, A, OK, NOW);
    plan.loadSnapshot();
    expect(plan.getSnapshot(A)).toBeNull();
    expect(plan.getRelaySeenAt(A)).toBe(new Date(NOW).toISOString());
  });

  it('files a file from before accounts under the default folder account, held back', () => {
    const soon = Math.round(Date.now() / 1000);
    writeFileSync(
      snapshotFile,
      JSON.stringify({ fiveHour: { usedPercentage: 42, resetsAt: soon + 3600, observedAt: new Date().toISOString() }, sevenDay: null })
    );
    plan.loadSnapshot();
    expect(plan.getSnapshot('work')).toBeNull();
    expect(plan.getHeld('work')).toMatchObject([{ window: 'fiveHour', usedPercentage: 42, reason: 'unverified-legacy' }]);
    expect(plan.getHeld('personal')).toEqual([]);
  });

  it('ignores a malformed contact time on disk', () => {
    writeFileSync(snapshotFile, JSON.stringify({ relaySeenAt: 'yesterday-ish' }));
    plan.loadSnapshot();
    expect(plan.getRelaySeenAt(A)).toBeNull();
  });
});

describe('routes', () => {
  async function app() {
    const a = Fastify();
    registerPlanUsageRoutes(a);
    await a.ready();
    return a;
  }

  it('relays a reading in and serves it back with the setup command', async () => {
    const a = await app();
    const body = payload(55, 22, Math.round(Date.now() / 1000) + 3600, Math.round(Date.now() / 1000) + 86400);
    // No config_dir: the default ~/.claude, which is `work` in the default config.
    const post = await a.inject({ method: 'POST', url: '/api/plan-usage', payload: body });
    expect(post.json()).toEqual({ stored: true, held: false, account: 'work' });

    const get = (await a.inject({ method: 'GET', url: '/api/plan-usage?account=work' })).json();
    expect(get.account).toBe('work');
    expect(get.snapshot.fiveHour.usedPercentage).toBe(55);
    expect(typeof get.relaySeenAt).toBe('string');
    expect(get.setup.command).toMatch(/^node ".*\/scripts\/statusline\.mjs"$/);
    expect(get.setup.settingsPath).toMatch(/[\\/]\.claude[\\/]settings\.json$/);
    await a.close();
  });

  it("keeps each account's limits apart, and drops a folder no account uses", async () => {
    const a = await app();
    const soon = Math.round(Date.now() / 1000);
    await a.inject({ method: 'POST', url: '/api/plan-usage', payload: payload(90, 50, soon + 3600, soon + 86400) });
    const personal = await a.inject({
      method: 'POST',
      url: '/api/plan-usage',
      payload: { ...payload(10, 5, soon + 3600, soon + 86400), config_dir: '~/.claude-personal' },
    });
    expect(personal.json()).toEqual({ stored: true, held: false, account: 'personal' });
    const stray = await a.inject({ method: 'POST', url: '/api/plan-usage', payload: { ...payload(1, 1), config_dir: 'C:/nowhere' } });
    expect(stray.json()).toEqual({ stored: false, held: true, account: null });
    expect(plan.getHeld(null)[0]).toMatchObject({ reason: 'unknown-folder', account: null });

    const get = async (account: string) => (await a.inject({ method: 'GET', url: `/api/plan-usage?account=${account}` })).json();
    expect((await get('work')).snapshot.fiveHour.usedPercentage).toBe(90);
    expect((await get('personal')).snapshot.fiveHour.usedPercentage).toBe(10);
    expect((await get('personal')).setup.settingsPath).toMatch(/\.claude-personal[\\/]settings\.json$/);
    // No account asked: the default account's.
    expect((await get('nobody')).account).toBe('personal');
    await a.close();
  });

  it("files a session's reading under the session's account when it comes from that account's folder", async () => {
    const a = await app();
    sessionRows.set('s-personal', { account: 'personal' });
    const res = await a.inject({
      method: 'POST',
      url: '/api/plan-usage',
      payload: { ...payload(10, 5), session_id: 's-personal', config_dir: '~/.claude-personal' },
    });
    expect(res.json()).toEqual({ stored: true, held: false, account: 'personal' });
    expect(plan.getSnapshot('personal')!.fiveHour!.usedPercentage).toBe(10);
    await a.close();
  });

  it("holds back a session's reading sent from another folder: a nested claude on another login", async () => {
    // CLAUDE_REMOTE_SESSION_ID reaches everything in the session's terminal, so
    // `CLAUDE_CONFIG_DIR=~/.claude claude` inside a personal session posts work's
    // limits with the personal session's id. Personal's folder verifies; the
    // reading is still not personal's.
    const a = await app();
    sessionRows.set('s-personal', { account: 'personal' });
    const other = await a.inject({
      method: 'POST',
      url: '/api/plan-usage',
      payload: { ...payload(90, 50), session_id: 's-personal' }, // no config_dir: the default (work) folder
    });
    expect(other.json()).toEqual({ stored: false, held: true, account: 'personal' });
    const nowhere = await a.inject({
      method: 'POST',
      url: '/api/plan-usage',
      payload: { ...payload(91, 51), session_id: 's-personal', config_dir: 'C:/nowhere' },
    });
    expect(nowhere.json()).toEqual({ stored: false, held: true, account: 'personal' });
    expect(plan.getSnapshot('personal')).toBeNull();
    expect(plan.getSnapshot('work')).toBeNull();
    expect(plan.getHeld('personal').map((h) => h.reason)).toEqual([
      'unknown-folder',
      'unknown-folder',
      'login-mismatch',
      'login-mismatch',
    ]);
    await a.close();
  });

  it('treats a session_id that names no session as absent: filed by config_dir', async () => {
    const a = await app();
    const res = await a.inject({
      method: 'POST',
      url: '/api/plan-usage',
      payload: { ...payload(10, 5), session_id: 'made-up', config_dir: '~/.claude-personal' },
    });
    expect(res.json()).toEqual({ stored: true, held: false, account: 'personal' });
    // The rest of the body is still validated: a bad window is dropped, not shown.
    const bad = await a.inject({
      method: 'POST',
      url: '/api/plan-usage',
      payload: { ...payload(400, null), session_id: 'made-up', config_dir: '~/.claude-personal' },
    });
    expect(bad.json()).toEqual({ stored: false, held: false, account: 'personal' });
    expect(plan.getSnapshot('personal')!.fiveHour!.usedPercentage).toBe(10);
    const big = await a.inject({
      method: 'POST',
      url: '/api/plan-usage',
      payload: { ...payload(10, 5), session_id: 'x'.repeat(100_000) },
    });
    expect(big.statusCode).toBe(413);
    await a.close();
  });

  it('holds back a flagged session, and a folder holding the wrong login', async () => {
    const a = await app();
    sessionRows.set('s-old', { account: 'work' });
    flagged.set('s-old', 'Account "work" is logged in as someone else');
    const fromSession = await a.inject({ method: 'POST', url: '/api/plan-usage', payload: { ...payload(70, 70), session_id: 's-old' } });
    expect(fromSession.json()).toEqual({ stored: false, held: true, account: 'work' });

    logins.set('personal', { ok: false, reason: 'mismatch', found: { accountUuid: 'other' } });
    const fromFolder = await a.inject({ method: 'POST', url: '/api/plan-usage', payload: { ...payload(1, 1), config_dir: '~/.claude-personal' } });
    expect(fromFolder.json()).toEqual({ stored: false, held: true, account: 'personal' });

    expect(plan.getSnapshot('work')).toBeNull();
    expect(plan.getSnapshot('personal')).toBeNull();
    expect(plan.getHeld('work')[0].reason).toBe('session-flagged');
    expect(plan.getHeld('personal')[0].reason).toBe('login-mismatch');
    // Contact still counts: the relay is installed for both.
    expect(plan.getRelaySeenAt('personal')).not.toBeNull();

    const listed = (await a.inject({ method: 'GET', url: '/api/plan-usage/held' })).json().held;
    expect(listed).toHaveLength(4);
    const one = await a.inject({ method: 'POST', url: '/api/plan-usage/held/discard', payload: { id: listed[0].id } });
    expect(one.json()).toEqual({ discarded: 1 });
    const all = await a.inject({ method: 'POST', url: '/api/plan-usage/held/discard', payload: { account: 'personal' } });
    expect(all.json().discarded).toBeGreaterThan(0);
    const bad = await a.inject({ method: 'POST', url: '/api/plan-usage/held/discard', payload: { account: 'nobody' } });
    expect(bad.statusCode).toBe(400);
    await a.close();
  });

  it('refuses a body far larger than any status line payload', async () => {
    const a = await app();
    const res = await a.inject({
      method: 'POST',
      url: '/api/plan-usage',
      payload: { ...payload(55, 22), padding: 'x'.repeat(100_000) },
    });
    expect(res.statusCode).toBe(413);
    await a.close();
  });

  it('points the setup command at the script with forward slashes', () => {
    // Claude Code runs the command through bash, even on Windows.
    expect(statuslineCommand()).not.toContain('\\');
  });

  it('works the command out once rather than on every poll', async () => {
    const first = statuslineCommand();
    vi.mocked(existsSync).mockClear();
    const a = await app();
    for (let i = 0; i < 3; i++) await a.inject({ method: 'GET', url: '/api/plan-usage' });
    const lookups = vi.mocked(existsSync).mock.calls.filter(([p]) => String(p).endsWith('statusline.mjs'));
    expect(lookups).toHaveLength(0);
    expect(statuslineCommand()).toBe(first);
    await a.close();
  });
});
