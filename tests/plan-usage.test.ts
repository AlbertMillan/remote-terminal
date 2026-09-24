import { describe, it, expect, beforeEach, beforeAll, afterAll } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import Fastify from 'fastify';

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

const NOW = Date.parse('2026-09-25T12:00:00Z');
const inHours = (h: number) => Math.round(NOW / 1000 + h * 3600);
const snapshotFile = join(dataDir, 'plan-usage.json');

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
});

describe('recording readings', () => {
  it('stores both windows from a status line payload', () => {
    expect(plan.recordReading(payload(55, 22), NOW)).toBe(true);
    const snap = plan.getSnapshot()!;
    expect(snap.fiveHour).toMatchObject({ usedPercentage: 55, resetsAt: inHours(2) });
    expect(snap.sevenDay).toMatchObject({ usedPercentage: 22, resetsAt: inHours(96) });
  });

  it('ignores a payload with no limits — normal before a session’s first response', () => {
    expect(plan.recordReading({ model: { display_name: 'Opus 5' } }, NOW)).toBe(false);
    expect(plan.getSnapshot()).toBeNull();
  });

  it('never lets a stale session lower the figure within a window', () => {
    plan.recordReading(payload(55, 22), NOW);
    plan.recordReading(payload(30, 10), NOW + 60_000); // an idle session's cached limits
    expect(plan.getSnapshot()!.fiveHour!.usedPercentage).toBe(55);
    expect(plan.getSnapshot()!.sevenDay!.usedPercentage).toBe(22);
  });

  it('lets a new window replace the old one, even at a lower percentage', () => {
    plan.recordReading(payload(90, 22), NOW);
    plan.recordReading(payload(3, 22, inHours(7)), NOW + 60_000);
    expect(plan.getSnapshot()!.fiveHour).toMatchObject({ usedPercentage: 3, resetsAt: inHours(7) });
  });

  it('refreshes the observation time when a reading confirms the value', () => {
    plan.recordReading(payload(55, 22), NOW);
    plan.recordReading(payload(55, 22), NOW + 5 * 60_000);
    expect(plan.getSnapshot()!.fiveHour!.observedAt).toBe(new Date(NOW + 5 * 60_000).toISOString());
  });

  it('keeps a window the next payload omits', () => {
    plan.recordReading(payload(55, 22), NOW);
    plan.recordReading(payload(60, null), NOW + 60_000);
    expect(plan.getSnapshot()!.sevenDay!.usedPercentage).toBe(22);
    expect(plan.getSnapshot()!.fiveHour!.usedPercentage).toBe(60);
  });

  it.each([
    ['a percentage over 100', payload(140, 22)],
    ['a negative percentage', payload(-1, 22)],
    ['a non-numeric percentage', { rate_limits: { five_hour: { used_percentage: '55', resets_at: inHours(2) } } }],
    ['a reset time a month out', payload(55, null, inHours(24 * 30))],
    ['a reset time long past', payload(55, null, inHours(-48))],
    ['a reset time in milliseconds', payload(55, null, inHours(2) * 1000)],
  ])('rejects %s and leaves the snapshot alone', (_label, body) => {
    plan.recordReading(payload(40, 20), NOW);
    plan.recordReading(body, NOW + 60_000);
    expect(plan.getSnapshot()!.fiveHour!.usedPercentage).toBe(40);
  });
});

describe('persistence', () => {
  it('survives a restart', () => {
    plan.recordReading(payload(55, 22, inHours(2), inHours(96)), Date.now());
    expect(existsSync(snapshotFile)).toBe(true);
    plan.loadSnapshot();
    expect(plan.getSnapshot()!.fiveHour!.usedPercentage).toBe(55);
  });

  it('starts empty from an unreadable file rather than failing', () => {
    writeFileSync(snapshotFile, '{ not json');
    plan.loadSnapshot();
    expect(plan.getSnapshot()).toBeNull();
  });

  it('re-validates what it reads back', () => {
    writeFileSync(
      snapshotFile,
      JSON.stringify({ fiveHour: { usedPercentage: 400, resetsAt: inHours(2), observedAt: 'x' }, sevenDay: null })
    );
    plan.loadSnapshot();
    expect(plan.getSnapshot()).toBeNull();
    expect(JSON.parse(readFileSync(snapshotFile, 'utf8')).fiveHour.usedPercentage).toBe(400);
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
    const post = await a.inject({ method: 'POST', url: '/api/plan-usage', payload: body });
    expect(post.json()).toEqual({ stored: true });

    const get = (await a.inject({ method: 'GET', url: '/api/plan-usage' })).json();
    expect(get.snapshot.fiveHour.usedPercentage).toBe(55);
    expect(get.setup.command).toMatch(/^node ".*\/scripts\/statusline\.mjs"$/);
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
});
