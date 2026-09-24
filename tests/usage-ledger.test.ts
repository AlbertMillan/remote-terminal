import { describe, it, expect, beforeEach, beforeAll, afterAll } from 'vitest';
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

/**
 * The usage ledger, read from real transcript files on disk.
 *
 * The properties that matter are the ones the old envelope counters got wrong
 * or never had: a response counted ONCE however many lines repeat it, spend
 * that lives outside the parent transcript (subagents, scratchpads) landing on
 * the right project, and history that is imported the moment a project gains
 * a PROJECT.md rather than lost because it predates the doc.
 */

const dataDir = mkdtempSync(join(tmpdir(), 'cr-ledger-'));
const projectsDir = join(dataDir, 'claude-projects');
const configPath = join(dataDir, 'config.json');
writeFileSync(configPath, JSON.stringify({ persistence: { dataDir } }));
process.env.CLAUDE_REMOTE_CONFIG = configPath;

const { loadConfig } = await import('../src/server/config.js');
const { initDatabase, closeDatabase, getDatabase } = await import('../src/server/db/schema.js');
const { ingestUsage } = await import('../src/server/usage/ledger.js');
const { usageByProject, usageByJob, invalidateUsageCache, recordRunStart, withProjectUsage } = await import(
  '../src/server/usage/store.js'
);
const { priceTokens } = await import('../src/server/usage/prices.js');

const ALPHA = 'C:\\p\\alpha';
const BETA = 'C:\\p\\beta';
const S1 = '11111111-1111-4111-8111-111111111111';
const S2 = '22222222-2222-4222-8222-222222222222';
const JOB = '33333333-3333-4333-8333-333333333333';
const TRACK = '44444444-4444-4444-8444-444444444444';

beforeAll(() => {
  loadConfig();
  initDatabase();
});

afterAll(() => {
  closeDatabase();
  rmSync(dataDir, { recursive: true, force: true });
});

beforeEach(() => {
  const db = getDatabase();
  db.exec('DELETE FROM usage_messages; DELETE FROM usage_files; DELETE FROM agent_runs; DELETE FROM jobs; DELETE FROM track_branches');
  // Written behind the store's back, so its cache must be told.
  invalidateUsageCache();
  rmSync(projectsDir, { recursive: true, force: true });
  mkdirSync(projectsDir, { recursive: true });
});

interface Tokens {
  input?: number;
  output?: number;
  read?: number;
  w5m?: number;
  w1h?: number;
  model?: string;
}

/** One transcript line as Claude Code writes it: an assistant response with usage. */
function line(id: string, cwd: string, t: Tokens = {}, ts = '2026-09-20T10:00:00.000Z'): string {
  return JSON.stringify({
    type: 'assistant',
    cwd,
    timestamp: ts,
    message: {
      id,
      model: t.model ?? 'claude-opus-5',
      usage: {
        input_tokens: t.input ?? 10,
        output_tokens: t.output ?? 20,
        cache_read_input_tokens: t.read ?? 30,
        cache_creation_input_tokens: (t.w5m ?? 0) + (t.w1h ?? 40),
        cache_creation: { ephemeral_5m_input_tokens: t.w5m ?? 0, ephemeral_1h_input_tokens: t.w1h ?? 40 },
      },
    },
  });
}

function transcript(folder: string, sessionId: string, lines: string[]): string {
  const dir = join(projectsDir, folder);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${sessionId}.jsonl`);
  writeFileSync(path, lines.map((l) => `${l}\n`).join(''));
  return path;
}

const ingest = (docs = [ALPHA], readChunkBytes?: number) =>
  ingestUsage({ projectsDir, docProjects: docs, readChunkBytes });
const total = (cwd = ALPHA) => usageByProject().get(cwd)?.total;

describe('counting', () => {
  it('counts a response once, however many lines repeat it', async () => {
    // Claude Code writes one line per content block, each carrying the whole
    // response's usage. Summing lines roughly doubled every figure.
    const dup = line('msg_a', ALPHA);
    transcript('alpha', S1, [dup, dup, dup]);
    await ingest();
    expect(total()?.outputTokens).toBe(20);
    expect(total()?.inputTokens).toBe(10);
  });

  it('reads only what was appended since the last pass', async () => {
    const path = transcript('alpha', S1, [line('msg_a', ALPHA)]);
    await ingest();
    appendFileSync(path, `${line('msg_b', ALPHA)}\n`);
    const stats = await ingest();
    expect(stats.inserted).toBe(1);
    expect(total()?.outputTokens).toBe(40);
  });

  it('leaves a half-written last line for the next pass, then counts it once', async () => {
    const path = transcript('alpha', S1, [line('msg_a', ALPHA)]);
    const next = line('msg_b', ALPHA);
    appendFileSync(path, next.slice(0, 25));
    await ingest();
    expect(total()?.outputTokens).toBe(20);

    appendFileSync(path, `${next.slice(25)}\n`);
    await ingest();
    expect(total()?.outputTokens).toBe(40);
  });

  it('re-reads a transcript that shrank, without counting anything twice', async () => {
    transcript('alpha', S1, [line('msg_a', ALPHA), line('msg_b', ALPHA)]);
    await ingest();
    transcript('alpha', S1, [line('msg_a', ALPHA)]);
    await ingest();
    expect(total()?.outputTokens).toBe(40);
  });

  it('keeps the 5-minute and 1-hour cache writes apart so they price apart', async () => {
    transcript('alpha', S1, [line('msg_a', ALPHA, { input: 0, output: 0, read: 0, w5m: 1_000_000, w1h: 1_000_000 })]);
    await ingest();
    // Opus 5 input is $5/MTok: a 5m write is 1.25x, a 1h write 2x.
    expect(total()?.costUsd).toBeCloseTo(5 * 1.25 + 5 * 2, 6);
    expect(total()?.cacheCreationTokens).toBe(2_000_000);
  });

  it('skips client-side placeholder responses', async () => {
    transcript('alpha', S1, [line('msg_a', ALPHA, { model: '<synthetic>' })]);
    await ingest();
    expect(total()).toBeUndefined();
  });
});

describe('attribution', () => {
  it('counts a subdirectory session toward the project that contains it', async () => {
    transcript('alpha-api', S1, [line('msg_a', `${ALPHA}\\api`)]);
    await ingest();
    expect(total()?.outputTokens).toBe(20);
  });

  it('gives a nested project with its own PROJECT.md its own spend', async () => {
    const nested = `${ALPHA}\\tools`;
    transcript('alpha-tools', S1, [line('msg_a', nested)]);
    await ingest([ALPHA, nested]);
    expect(total(nested)?.outputTokens).toBe(20);
    expect(total(ALPHA)).toBeUndefined();
  });

  it('counts subagent spend, which lives outside the parent transcript', async () => {
    transcript('alpha', S1, [line('msg_parent', ALPHA)]);
    const sub = join(projectsDir, 'alpha', S1, 'subagents');
    mkdirSync(sub, { recursive: true });
    // Subagent lines carry no cwd of their own that the ledger relies on.
    writeFileSync(join(sub, 'agent-abc.jsonl'), `${line('msg_sub', 'C:\\elsewhere')}\n`);
    await ingest();
    expect(total()?.outputTokens).toBe(40);
    // Filed under the parent session, so it falls inside the parent's run windows.
    const row = getDatabase().prepare("SELECT session_id FROM usage_messages WHERE message_id = 'msg_sub'").get() as {
      session_id: string;
    };
    expect(row.session_id).toBe(S1);
  });

  it('folds a scratchpad session into the session that created it', async () => {
    transcript('alpha', S1, [line('msg_parent', ALPHA)]);
    const scratch = `C:\\Users\\me\\AppData\\Local\\Temp\\claude\\C--p-alpha\\${S1}\\scratchpad\\bare`;
    transcript('scratch', S2, [line('msg_scratch', scratch)]);
    await ingest();
    expect(total()?.outputTokens).toBe(40);
  });

  it('ignores projects without a PROJECT.md, then imports their history when they gain one', async () => {
    transcript('beta', S1, [line('msg_a', BETA), line('msg_b', BETA)]);
    await ingest([ALPHA]);
    expect(total(BETA)).toBeUndefined();

    await ingest([ALPHA, BETA]);
    expect(total(BETA)?.outputTokens).toBe(40);
  });

  it('attributes a job worktree to its job, even after the job row is gone', async () => {
    // Discard deletes the job row; the run recorded before it spawned remains.
    getDatabase()
      .prepare(`INSERT INTO agent_runs (session_id, project_cwd, kind, job_id, stage, started_at)
                VALUES ('other-session', ?, 'stage', ?, 'design', '2026-09-20T09:00:00.000Z')`)
      .run(ALPHA, JOB);
    const wt = join(dataDir, 'worktrees', JOB);
    transcript('job', S1, [line('msg_a', wt)]);
    await ingest();
    expect(total()?.outputTokens).toBe(20);
    expect(usageByJob([JOB]).get(JOB)?.total.outputTokens).toBe(20);
    expect(usageByProject().get(ALPHA)?.pipeline.outputTokens).toBe(20);
  });

  it('attributes a track worktree session to the track project, as a session', async () => {
    getDatabase()
      .prepare(`INSERT INTO track_branches (id, project_cwd, project_key, track_name, branch, worktree_path, base_branch, created_at)
                VALUES (?, ?, ?, 'Usage', 'track/usage', 'x', 'main', '2026-09-20T09:00:00.000Z')`)
      .run(TRACK, ALPHA, ALPHA.toLowerCase());
    transcript('track', S1, [line('msg_a', join(dataDir, 'worktrees', 'tracks', TRACK))]);
    await ingest();
    expect(usageByProject().get(ALPHA)?.sessions.outputTokens).toBe(20);
  });

  it('files a tagged background run under background, not sessions', async () => {
    getDatabase()
      .prepare(`INSERT INTO agent_runs (session_id, project_cwd, kind, started_at)
                VALUES (?, ?, 'session-log', '2026-09-20T09:00:00.000Z')`)
      .run(S1, ALPHA);
    transcript('alpha', S1, [line('msg_a', ALPHA)]);
    transcript('alpha', S2, [line('msg_b', ALPHA)]);
    await ingest();
    const p = usageByProject().get(ALPHA)!;
    expect(p.background.outputTokens).toBe(20);
    expect(p.sessions.outputTokens).toBe(20);
    expect(p.total.outputTokens).toBe(40);
  });
});

describe('prices', () => {
  const t = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWrite5mTokens: 0, cacheWrite1hTokens: 0 };

  it('matches a real envelope to the last digit', () => {
    // A Haiku `claude -p` run measured on 2026-09-24: total_cost_usd 0.017542.
    const cost = priceTokens('claude-haiku-4-5-20251001', {
      ...t,
      inputTokens: 9,
      outputTokens: 63,
      cacheWrite1hTokens: 8609,
    });
    expect(cost).toBeCloseTo(0.017542, 9);
  });

  it('never prices a newer model as its shorter-named predecessor', () => {
    const m = { ...t, inputTokens: 1_000_000 };
    expect(priceTokens('claude-opus-5-5', m)).toBeCloseTo(4, 9);
    expect(priceTokens('claude-opus-5', m)).toBeCloseTo(5, 9);
  });

  it('uses a published cache-read rate over the 0.1x default', () => {
    expect(priceTokens('claude-fable-5-1', { ...t, cacheReadTokens: 1_000_000 })).toBeCloseTo(0.25, 9);
    expect(priceTokens('claude-sonnet-5', { ...t, cacheReadTokens: 1_000_000 })).toBeCloseTo(0.2, 9);
  });

  it('prices an unknown model as unknown, never as free', () => {
    expect(priceTokens('claude-someday-9', { ...t, inputTokens: 5 })).toBeNull();
  });

  it('applies the fast-mode premium only where the model has one', () => {
    const m = { ...t, outputTokens: 1_000_000 };
    expect(priceTokens('claude-opus-5', m, 'fast')).toBeCloseTo(50, 9);
    expect(priceTokens('claude-sonnet-5', m, 'fast')).toBeCloseTo(10, 9);
  });
});

describe('reading in steps', () => {
  it('keeps its offset exact when a step boundary splits a multi-byte character', async () => {
    // Offsets are byte positions. Decoding a step before cutting it would turn
    // a split "é" into a replacement character and skew every later read.
    const withAccents = (id: string) =>
      JSON.stringify({ ...JSON.parse(line(id, ALPHA)), note: 'café ☕ naïve '.repeat(3) });
    const path = transcript('alpha', S1, [withAccents('msg_a'), withAccents('msg_b')]);
    // 7-byte steps put a boundary inside some multi-byte sequence for certain.
    await ingest([ALPHA], 7);
    appendFileSync(path, `${withAccents('msg_c')}\n`);
    await ingest([ALPHA], 7);

    expect(total()?.outputTokens).toBe(60);
    const row = getDatabase().prepare('SELECT offset, size FROM usage_files WHERE path = ?').get(path) as {
      offset: number;
      size: number;
    };
    expect(row.offset).toBe(row.size);
  });

  it('finds a cwd far past the head of the file, and ignores one nested in a tool call', async () => {
    // A session that opens with a huge paste: no top-level cwd until well past
    // any fixed head read, and a tool input carrying its own "cwd" before it.
    const paste = JSON.stringify({
      type: 'user',
      message: { content: [{ type: 'tool_use', input: { cwd: BETA } }, { type: 'text', text: 'x'.repeat(200_000) }] },
    });
    transcript('alpha', S1, [paste, line('msg_a', ALPHA)]);
    await ingest([ALPHA, BETA]);
    expect(total(ALPHA)?.outputTokens).toBe(20);
    expect(total(BETA)).toBeUndefined();
  });
});

describe('copies of the same response', () => {
  const RUN = '55555555-5555-4555-8555-555555555555';
  const FORK = '66666666-6666-4666-8666-666666666666';

  function tagRun(): void {
    getDatabase()
      .prepare(`INSERT INTO agent_runs (session_id, project_cwd, kind, job_id, stage, started_at)
                VALUES (?, ?, 'stage', ?, 'design', '2026-09-20T09:00:00.000Z')`)
      .run(RUN, ALPHA, JOB);
  }
  const owner = () =>
    (getDatabase().prepare("SELECT session_id FROM usage_messages WHERE message_id = 'msg_a'").get() as {
      session_id: string;
    }).session_id;

  it('gives a response to the tagged run, even when a Fork’s copy is read first', async () => {
    tagRun();
    const fork = transcript('alpha', FORK, [line('msg_a', ALPHA)]);
    const run = transcript('alpha', RUN, [line('msg_a', ALPHA)]);
    // Oldest first is the read order; make the fork's copy the older file.
    utimesSync(fork, new Date('2026-09-20T10:00:00Z'), new Date('2026-09-20T10:00:00Z'));
    utimesSync(run, new Date('2026-09-20T11:00:00Z'), new Date('2026-09-20T11:00:00Z'));
    await ingest();
    expect(owner()).toBe(RUN);
    expect(total()?.outputTokens).toBe(20);
  });

  it('never moves a response away from the tagged run', async () => {
    tagRun();
    const run = transcript('alpha', RUN, [line('msg_a', ALPHA)]);
    const fork = transcript('alpha', FORK, [line('msg_a', ALPHA)]);
    utimesSync(run, new Date('2026-09-20T10:00:00Z'), new Date('2026-09-20T10:00:00Z'));
    utimesSync(fork, new Date('2026-09-20T11:00:00Z'), new Date('2026-09-20T11:00:00Z'));
    await ingest();
    expect(owner()).toBe(RUN);
  });
});

describe('the read cache', () => {
  it('serves repeat reads from memory until the ledger changes', async () => {
    transcript('alpha', S1, [line('msg_a', ALPHA)]);
    await ingest();
    const first = usageByProject();
    expect(usageByProject()).toBe(first);

    // A pass that stores something makes the next read fresh.
    appendFileSync(join(projectsDir, 'alpha', `${S1}.jsonl`), `${line('msg_b', ALPHA)}\n`);
    await ingest();
    expect(usageByProject()).not.toBe(first);
    expect(total()?.outputTokens).toBe(40);
  });

  it('refreshes when a run is recorded', () => {
    const first = usageByJob();
    recordRunStart(S2, { projectCwd: ALPHA, kind: 'stage', jobId: JOB, stage: 'qa' });
    expect(usageByJob().get(JOB)?.stages.get('qa')?.runCount).toBe(1);
    expect(usageByJob()).not.toBe(first);
  });
});

describe('project usage on the board', () => {
  it('matches projects by path, whatever the spelling, and says null for none', async () => {
    transcript('alpha', S1, [line('msg_a', ALPHA)]);
    await ingest();
    const [alpha, beta] = withProjectUsage([{ cwd: 'c:/P/Alpha/' }, { cwd: BETA }]);
    expect(alpha.usage?.total.outputTokens).toBe(20);
    expect(beta.usage).toBeNull();
  });
});
