import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import Fastify from 'fastify';

/**
 * `GET /api/plan-usage` with every configured account (f-dnapj1): one entry
 * each, with its plan label, whether its login is the expected one, its
 * running sessions and this window's ledger usage. The plan comes from the
 * login's credentials file, which also holds its OAuth tokens: none of that may
 * reach the response, which any tailnet device can read.
 */

const root = mkdtempSync(join(tmpdir(), 'cr-plan-accounts-'));
const dataDir = join(root, 'data');
const personalDir = join(root, 'personal');
const workDir = join(root, 'work');
for (const d of [dataDir, personalDir, workDir]) mkdirSync(d, { recursive: true });
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

const SECRETS = ['sk-ant-oat-SECRET-ACCESS', 'sk-ant-ort-SECRET-REFRESH'];
function credentials(dir: string, subscriptionType: string, rateLimitTier: string): void {
  writeFileSync(
    join(dir, '.credentials.json'),
    JSON.stringify({
      claudeAiOauth: {
        accessToken: SECRETS[0],
        refreshToken: SECRETS[1],
        expiresAt: 1,
        scopes: ['user:inference'],
        subscriptionType,
        rateLimitTier,
      },
      mcpOAuth: { server: { accessToken: 'SECRET-MCP' } },
    })
  );
}
credentials(personalDir, 'max', 'default_claude_max_5x');
credentials(workDir, 'team', 'default_raven');
writeFileSync(
  join(personalDir, '.claude.json'),
  JSON.stringify({ oauthAccount: { accountUuid: 'acc-personal', accountCreatedAt: '2026-10-28T16:20:46.454326Z' } })
);
writeFileSync(join(workDir, '.claude.json'), JSON.stringify({ oauthAccount: { accountUuid: 'acc-w', organizationUuid: 'org-work' } }));

const { loadConfig } = await import('../src/server/config.js');
const { initDatabase, closeDatabase, getDatabase } = await import('../src/server/db/schema.js');
const plan = await import('../src/server/usage/plan-limits.js');
const { invalidateUsageCache } = await import('../src/server/usage/store.js');
const { registerPlanUsageRoutes } = await import('../src/server/usage/plan-routes.js');
const { planLabel } = await import('../src/server/accounts.js');

beforeAll(() => {
  loadConfig();
  initDatabase();
  plan.loadSnapshot();
});
afterAll(() => {
  closeDatabase();
  rmSync(root, { recursive: true, force: true });
});

const nowS = () => Math.round(Date.now() / 1000);

async function app() {
  const a = Fastify();
  registerPlanUsageRoutes(a, { runningSessions: () => [{ account: 'work' }, { account: 'work' }, { account: 'personal' }] });
  await a.ready();
  return a;
}

describe('plan labels', () => {
  it('reads the plan, and only the plan, from the credentials file', () => {
    expect(planLabel('personal')).toBe('Max 5x');
    expect(planLabel('work')).toBe('Team');
  });

  it('serves the label from memory until the file changes', () => {
    expect(planLabel('personal')).toBe('Max 5x');
    credentials(personalDir, 'max', 'default_claude_max_20x'); // a different size: the cache key moves
    expect(planLabel('personal')).toBe('Max 20x');
    credentials(personalDir, 'max', 'default_claude_max_5x');
    expect(planLabel('personal')).toBe('Max 5x');
  });
});

describe('GET /api/plan-usage', () => {
  it('returns every configured account, marks the attached one, and counts running sessions', async () => {
    const a = await app();
    // A verified reading for work, posted the way its relay does.
    const post = await a.inject({
      method: 'POST',
      url: '/api/plan-usage',
      payload: {
        rate_limits: {
          five_hour: { used_percentage: 41, resets_at: nowS() + 3600 },
          seven_day: { used_percentage: 12, resets_at: nowS() + 3 * 86400 },
        },
        config_dir: workDir,
      },
    });
    expect(post.json()).toMatchObject({ stored: true, account: 'work' });

    // Two of work's messages in this 5-hour window, one long before it.
    const db = getDatabase();
    const insert = db.prepare(
      `INSERT INTO usage_messages (message_id, session_id, project_cwd, model, ts, input_tokens, output_tokens,
         cache_read_tokens, cache_write_5m_tokens, cache_write_1h_tokens, account)
       VALUES (?, ?, 'C:\\p', 'claude-opus-5', ?, 1, ?, 0, 0, 0, ?)`
    );
    insert.run('m1', 's1', new Date(Date.now() - 60_000).toISOString(), 100, 'work');
    insert.run('m2', 's2', new Date(Date.now() - 120_000).toISOString(), 50, 'work');
    insert.run('m3', 's3', new Date(Date.now() - 6 * 3600_000).toISOString(), 1000, 'work');
    invalidateUsageCache();

    const res = await a.inject({ method: 'GET', url: '/api/plan-usage?account=personal' });
    const body = res.json();
    expect(body.attached).toBe('personal');
    expect(body.accounts.map((x: { account: string }) => x.account)).toEqual(['personal', 'work']);
    const [personal, work] = body.accounts;
    expect(personal).toMatchObject({ plan: 'Max 5x', verified: true, snapshot: null, running: 1, held: 0, tokens: null });
    expect(work).toMatchObject({ plan: 'Team', verified: true, running: 2 });
    expect(work.snapshot.fiveHour.usedPercentage).toBe(41);
    expect(work.tokens.fiveHour).toMatchObject({ messages: 2, outputTokens: 150, sinceLogin: false });
    // The week counts m3 too.
    expect(work.tokens.sevenDay.messages).toBe(3);
    // No project folder given: jobs run under the default account.
    expect(personal.jobs).toBe(true);
    expect(work.jobs).toBe(false);
    // An older tab still finds the attached account's fields at the top level.
    expect(body.account).toBe('personal');
    expect(body.setup.command).toMatch(/statusline\.mjs/);
    await a.close();
  });

  it('works without ?account= (no attached session)', async () => {
    const a = await app();
    const body = (await a.inject({ method: 'GET', url: '/api/plan-usage' })).json();
    expect(body.attached).toBeUndefined();
    expect(body.accounts).toHaveLength(2);
    expect(body.account).toBe('personal');
    await a.close();
  });

  it('never contains a token, or any other field, from the credentials file', async () => {
    const a = await app();
    const text = (await a.inject({ method: 'GET', url: '/api/plan-usage?account=work' })).body;
    for (const secret of [...SECRETS, 'SECRET-MCP']) expect(text).not.toContain(secret);
    for (const field of ['accessToken', 'refreshToken', 'expiresAt', 'scopes', 'subscriptionType', 'rateLimitTier', 'mcpOAuth']) {
      expect(text).not.toContain(field);
    }
    // Nor who is logged in.
    expect(text).not.toContain('acc-personal');
    expect(text).not.toContain('acc-w');
    await a.close();
  });

  it('says unverified for an account whose folder holds another login', async () => {
    writeFileSync(join(personalDir, '.claude.json'), JSON.stringify({ oauthAccount: { accountUuid: 'someone-else' } }));
    const { stopAccountWatch } = await import('../src/server/sessions/account-watch.js');
    stopAccountWatch(); // drop the cached login so the change is read now
    const { clearIdentityCache } = await import('../src/server/accounts.js');
    clearIdentityCache();
    const a = await app();
    const body = (await a.inject({ method: 'GET', url: '/api/plan-usage' })).json();
    expect(body.accounts[0]).toMatchObject({ account: 'personal', verified: false });
    await a.close();
  });
});
