import { describe, it, expect, beforeEach, beforeAll, afterAll } from 'vitest';
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

/**
 * The ledger attributes each message to the login that ran it (f-7oap94), not
 * the folder its transcript lives in: `f-ilxxdj` moved transcripts that ran
 * under the default folder's login into the personal folder, and counting them
 * as personal's put a week of work usage under the wrong account.
 */

const home = mkdtempSync(join(tmpdir(), 'cr-usage-account-'));
const dataDir = join(home, 'data');
mkdirSync(dataDir, { recursive: true });
const configPath = join(dataDir, 'config.json');
writeFileSync(
  configPath,
  JSON.stringify({
    persistence: { dataDir },
    accounts: {
      personal: { configDir: '~/.claude-personal', accountUuid: 'acc-personal' },
      work: { configDir: '~/.claude', organizationUuid: 'org-work' },
    },
    defaultAccount: 'personal',
  })
);
process.env.CLAUDE_REMOTE_CONFIG = configPath;

const { loadConfig } = await import('../src/server/config.js');
const { initDatabase, closeDatabase, getDatabase } = await import('../src/server/db/schema.js');
const { ingestUsage, backfillMessageAccounts } = await import('../src/server/usage/ledger.js');
const { usageByAccount, invalidateUsageCache, recordRunStart } = await import('../src/server/usage/store.js');
const { clearIdentityCache } = await import('../src/server/accounts.js');

const PROJECT = 'C:\\p\\alpha';
const workProjects = join(home, '.claude', 'projects');
const personalProjects = join(home, '.claude-personal', 'projects');
/** When the personal login was created: earlier messages in its folder were moved in. */
const CREATED = '2026-10-28T16:20:46.454326Z';
const BEFORE = '2026-10-27T09:00:00.000Z';
const AFTER = '2026-10-28T18:00:00.000Z';

const S1 = '11111111-1111-4111-8111-111111111111';
const S2 = '22222222-2222-4222-8222-222222222222';
const S3 = '33333333-3333-4333-8333-333333333333';

function personalLogin(oauth: Record<string, unknown>): void {
  mkdirSync(join(home, '.claude-personal'), { recursive: true });
  writeFileSync(join(home, '.claude-personal', '.claude.json'), JSON.stringify({ oauthAccount: oauth }));
  clearIdentityCache();
}

function line(id: string, ts: string, output = 20): string {
  return JSON.stringify({
    type: 'assistant',
    cwd: PROJECT,
    timestamp: ts,
    message: {
      id,
      model: 'claude-opus-5',
      usage: { input_tokens: 10, output_tokens: output, cache_read_input_tokens: 30, cache_creation_input_tokens: 40 },
    },
  });
}

function transcript(projectsDir: string, sessionId: string, lines: string[]): string {
  const dir = join(projectsDir, 'C--p-alpha');
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${sessionId}.jsonl`);
  writeFileSync(path, lines.map((l) => `${l}\n`).join(''));
  return path;
}

const ingest = () => ingestUsage({ projectsDirs: [workProjects, personalProjects], docProjects: [PROJECT], home });
const accountOf = (id: string) =>
  (getDatabase().prepare('SELECT account FROM usage_messages WHERE message_id = ?').get(id) as { account: string | null })
    .account;

beforeAll(() => {
  loadConfig();
  initDatabase();
});

afterAll(() => {
  closeDatabase();
  rmSync(home, { recursive: true, force: true });
});

beforeEach(() => {
  getDatabase().exec('DELETE FROM usage_messages; DELETE FROM usage_files; DELETE FROM agent_runs');
  invalidateUsageCache();
  rmSync(workProjects, { recursive: true, force: true });
  rmSync(personalProjects, { recursive: true, force: true });
  personalLogin({ accountUuid: 'acc-personal', accountCreatedAt: CREATED });
});

describe('attribution at ingest', () => {
  it("gives a moved transcript's older messages to the default folder's account, newer ones to the folder's", async () => {
    transcript(personalProjects, S1, [line('msg_old', BEFORE), line('msg_new', AFTER)]);
    transcript(workProjects, S2, [line('msg_work', BEFORE)]);
    await ingest();
    expect(accountOf('msg_old')).toBe('work');
    expect(accountOf('msg_new')).toBe('personal');
    expect(accountOf('msg_work')).toBe('work');
  });

  it('leaves a message unattributed when its login is unknown, never guessed', async () => {
    personalLogin({ accountUuid: 'acc-personal' }); // no accountCreatedAt
    transcript(personalProjects, S1, [line('msg_p', AFTER)]);
    const elsewhere = join(home, 'other-projects');
    transcript(elsewhere, S3, [line('msg_x', AFTER)]);
    await ingestUsage({ projectsDirs: [personalProjects, elsewhere], docProjects: [PROJECT], home });
    expect(accountOf('msg_p')).toBeNull();
    expect(accountOf('msg_x')).toBeNull();
  });
});

describe('backfill', () => {
  it('attributes earlier rows by the same rule, idempotently, and re-ingest keeps it', async () => {
    const path = transcript(personalProjects, S1, [line('msg_old', BEFORE), line('msg_new', AFTER)]);
    await ingest();
    // Rows from before the column existed.
    getDatabase().exec('UPDATE usage_messages SET account = NULL');

    expect(backfillMessageAccounts(home)).toBe(2);
    expect(accountOf('msg_old')).toBe('work');
    expect(accountOf('msg_new')).toBe('personal');
    expect(backfillMessageAccounts(home)).toBe(0);

    // Re-reading the file (it grew) never flips an attribution.
    appendFileSync(path, `${line('msg_more', AFTER)}\n`);
    await ingest();
    expect(accountOf('msg_old')).toBe('work');
    expect(accountOf('msg_more')).toBe('personal');
  });

  it("follows a subagent's rows through its parent's session id", async () => {
    const dir = join(personalProjects, 'C--p-alpha', S1, 'subagents');
    transcript(personalProjects, S1, [line('msg_parent', AFTER)]);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'agent-1.jsonl'), `${line('msg_sub', BEFORE)}\n`);
    await ingest();
    getDatabase().exec('UPDATE usage_messages SET account = NULL');
    backfillMessageAccounts(home);
    expect(accountOf('msg_parent')).toBe('personal');
    expect(accountOf('msg_sub')).toBe('work');
  });
});

describe('usageByAccount', () => {
  it('sums one login per window, with sessions, job runs and moved messages', async () => {
    transcript(personalProjects, S1, [line('m1', BEFORE, 100), line('m2', AFTER, 5)]);
    transcript(workProjects, S2, [line('m3', AFTER, 7), line('m4', '2026-10-20T00:00:00.000Z', 1000)]);
    recordRunStart(S2, { projectCwd: PROJECT, kind: 'stage', jobId: 'job-1', stage: 'implement' });
    await ingest();

    const since = '2026-10-26T00:00:00.000Z';
    const work = usageByAccount('work', since, workProjects)!;
    // m1 (moved into personal's folder, ran under work) + m3; m4 is before the window.
    expect(work).toMatchObject({ messages: 2, outputTokens: 107, inputTokens: 20, cacheReadTokens: 60, sessions: 2 });
    expect(work.cacheWriteTokens).toBe(80);
    expect(work.elsewhere).toBe(1);
    expect(work.jobRuns).toBe(1);
    expect(work.costUsd).toBeGreaterThan(0);

    const personal = usageByAccount('personal', since, personalProjects)!;
    expect(personal).toMatchObject({ messages: 1, outputTokens: 5, sessions: 1, elsewhere: 0, jobRuns: 0 });

    // The 5-hour window holds only what ran since its start.
    expect(usageByAccount('work', '2026-10-28T17:00:00.000Z')!.messages).toBe(1);
  });

  it('serves repeats from memory until the ledger changes', async () => {
    transcript(workProjects, S2, [line('m3', AFTER)]);
    await ingest();
    const first = usageByAccount('work', BEFORE);
    expect(usageByAccount('work', BEFORE)).toBe(first);
    invalidateUsageCache();
    expect(usageByAccount('work', BEFORE)).not.toBe(first);
  });
});
