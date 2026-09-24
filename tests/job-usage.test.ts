import { describe, it, expect, beforeEach, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

/**
 * What the job board reads off the usage ledger, against a real database.
 *
 * A message belongs to the stage whose run window holds it. That one rule is
 * what the old envelope counters could not express: a resumed session spans
 * two stages under one id, a Take over spends in the job's session with no run
 * at all, and a killed run leaves no envelope — yet all three spent tokens.
 */

const dataDir = mkdtempSync(join(tmpdir(), 'cr-usage-'));
const configPath = join(dataDir, 'config.json');
writeFileSync(configPath, JSON.stringify({ persistence: { dataDir } }));
process.env.CLAUDE_REMOTE_CONFIG = configPath;

const { loadConfig } = await import('../src/server/config.js');
const { initDatabase, closeDatabase, getDatabase } = await import('../src/server/db/schema.js');
const store = await import('../src/server/jobs/store.js');
const { ZERO_USAGE } = await import('../src/server/jobs/types.js');
const { recordRunStart, recordRunEnd, usageByProject, invalidateUsageCache } = await import(
  '../src/server/usage/store.js'
);
// The board's labels: what the user actually reads off the numbers.
const { formatCost, formatTokens, usageTooltip } = await import('../src/client/job-board.js');

const CWD = 'C:\\p\\alpha';
const SESSION = 'sess-1';

beforeAll(() => {
  loadConfig();
  initDatabase();
});

afterAll(() => {
  closeDatabase();
  rmSync(dataDir, { recursive: true, force: true });
});

beforeEach(() => {
  getDatabase().exec('DELETE FROM jobs; DELETE FROM usage_messages; DELETE FROM agent_runs');
  invalidateUsageCache();
});

function newJob(title = 'A feature') {
  return store.createJob({ projectCwd: CWD, featureId: 'f-1', title });
}

/** A run window, as runClaude records it around a spawn. */
function run(jobId: string, stage: string, startedAt: string, endedAt: string | null, session = SESSION): void {
  getDatabase()
    .prepare(
      `INSERT INTO agent_runs (session_id, project_cwd, kind, job_id, stage, started_at, ended_at)
       VALUES (?, ?, 'stage', ?, ?, ?, ?)`
    )
    .run(session, CWD, jobId, stage, startedAt, endedAt);
  // Written behind the store's back, as the ledger's own writers never do.
  invalidateUsageCache();
}

let seq = 0;
/** One API response the ledger read from the job's transcript. 1M output tokens = $25 on Opus 5. */
function spent(jobId: string | null, ts: string, output = 1_000_000, session = SESSION): void {
  getDatabase()
    .prepare(
      `INSERT INTO usage_messages (message_id, session_id, project_cwd, job_id, model, ts, output_tokens)
       VALUES (?, ?, ?, ?, 'claude-opus-5', ?, ?)`
    )
    .run(`msg_${++seq}`, session, CWD, jobId, ts, output);
  invalidateUsageCache();
}

const stageOf = (jobId: string, name: string) =>
  store.getJobWithStages(jobId)!.stages.find((s) => s.name === name)!;

describe('stage usage', () => {
  it('starts at zero with no runs recorded', () => {
    const job = store.getJobWithStages(newJob().id)!;
    expect(job.usage).toEqual(ZERO_USAGE);
    for (const stage of job.stages) expect(stage.usage).toEqual(ZERO_USAGE);
  });

  it('puts a run’s spend on the stage that made it, priced from tokens', () => {
    const id = newJob().id;
    run(id, 'design', '2026-09-20T10:00:00.000Z', '2026-09-20T10:10:00.000Z');
    spent(id, '2026-09-20T10:05:00.000Z');

    const design = stageOf(id, 'design');
    expect(design.usage.runCount).toBe(1);
    expect(design.usage.outputTokens).toBe(1_000_000);
    expect(design.usage.costUsd).toBeCloseTo(25, 9);
    expect(stageOf(id, 'qa').usage).toEqual(ZERO_USAGE);
  });

  it('counts a killed run, which never printed an envelope', () => {
    // The old counters recorded nothing here: the envelope arrives only on
    // completion. The run row and the transcript both exist regardless.
    const id = newJob().id;
    run(id, 'implement', '2026-09-20T10:00:00.000Z', '2026-09-20T10:20:00.000Z');
    spent(id, '2026-09-20T10:19:00.000Z');
    expect(stageOf(id, 'implement').usage.costUsd).toBeCloseTo(25, 9);
  });

  it('splits one resumed session between the stages that used it', () => {
    // An answer resumes the asking session, so design and implement share an
    // id. Only the run windows tell their spend apart.
    const id = newJob().id;
    run(id, 'design', '2026-09-20T10:00:00.000Z', '2026-09-20T10:10:00.000Z');
    run(id, 'implement', '2026-09-20T11:00:00.000Z', '2026-09-20T11:30:00.000Z');
    spent(id, '2026-09-20T10:05:00.000Z');
    spent(id, '2026-09-20T11:05:00.000Z');
    spent(id, '2026-09-20T11:25:00.000Z');

    expect(stageOf(id, 'design').usage.outputTokens).toBe(1_000_000);
    expect(stageOf(id, 'implement').usage.outputTokens).toBe(2_000_000);
  });

  it('counts a Take over in the job but in no stage', () => {
    const id = newJob().id;
    run(id, 'design', '2026-09-20T10:00:00.000Z', '2026-09-20T10:10:00.000Z');
    spent(id, '2026-09-20T10:05:00.000Z');
    spent(id, '2026-09-20T12:00:00.000Z'); // the terminal, an hour after the run

    const job = store.getJobWithStages(id)!;
    expect(job.usage.outputTokens).toBe(2_000_000);
    expect(stageOf(id, 'design').usage.outputTokens).toBe(1_000_000);
  });

  it('counts every run a stage makes', () => {
    const id = newJob().id;
    for (let i = 0; i < 3; i++) {
      run(id, 'qa', `2026-09-20T1${i}:00:00.000Z`, `2026-09-20T1${i}:10:00.000Z`);
      spent(id, `2026-09-20T1${i}:05:00.000Z`);
    }
    const qa = stageOf(id, 'qa');
    expect(qa.usage.runCount).toBe(3);
    expect(qa.usage.costUsd).toBeCloseTo(75, 9);
  });

  it('attributes a still-running stage’s spend as it arrives', () => {
    const id = newJob().id;
    run(id, 'review', '2026-09-20T10:00:00.000Z', null);
    spent(id, '2026-09-20T10:05:00.000Z');
    expect(stageOf(id, 'review').usage.outputTokens).toBe(1_000_000);
  });

  it('gives the same figures listed as fetched', () => {
    const id = newJob().id;
    run(id, 'design', '2026-09-20T10:00:00.000Z', '2026-09-20T10:10:00.000Z');
    spent(id, '2026-09-20T10:05:00.000Z');
    const listed = store.listJobs().find((j) => j.id === id)!;
    expect(listed.usage).toEqual(store.getJobWithStages(id)!.usage);
    expect(listed.stages.find((s) => s.name === 'design')!.usage.runCount).toBe(1);
  });
});

describe('what outlives the job', () => {
  it('keeps a discarded job’s spend in the project total', () => {
    const id = newJob().id;
    run(id, 'design', '2026-09-20T10:00:00.000Z', '2026-09-20T10:10:00.000Z');
    spent(id, '2026-09-20T10:05:00.000Z');
    store.deleteJob(id);

    const project = usageByProject().get(CWD)!;
    expect(project.total.costUsd).toBeCloseTo(25, 9);
    expect(project.pipeline.costUsd).toBeCloseTo(25, 9);
  });
});

describe('recording runs', () => {
  it('opens a window at start and closes it at the end', () => {
    const id = newJob().id;
    const runId = recordRunStart('sess-live', { projectCwd: CWD, kind: 'stage', jobId: id, stage: 'fix' });
    expect(runId).not.toBeNull();
    const open = getDatabase().prepare('SELECT * FROM agent_runs WHERE id = ?').get(runId) as {
      ended_at: string | null;
      stage: string;
    };
    expect(open.stage).toBe('fix');
    expect(open.ended_at).toBeNull();

    recordRunEnd(runId);
    const closed = getDatabase().prepare('SELECT ended_at FROM agent_runs WHERE id = ?').get(runId) as {
      ended_at: string | null;
    };
    expect(closed.ended_at).not.toBeNull();
  });
});

describe('how usage reads on the board', () => {
  const RUN = {
    ...ZERO_USAGE,
    inputTokens: 9,
    outputTokens: 176,
    cacheReadTokens: 18004,
    cacheCreationTokens: 13004,
    costUsd: 0.0287,
  };

  it('never shows a real cost as $0.00', () => {
    expect(formatCost(0.0004)).toBe('<$0.01');
    expect(formatCost(0)).toBe('$0.00');
    expect(formatCost(1.5)).toBe('$1.50');
  });

  it('abbreviates token counts without inventing precision', () => {
    expect(formatTokens(9)).toBe('9');
    expect(formatTokens(1250)).toBe('1.3k');
    expect(formatTokens(18004)).toBe('18k');
    expect(formatTokens(2_400_000)).toBe('2.4M');
  });

  it('calls the cost an estimate at list price, because that is what it is', () => {
    const tip = usageTooltip({ ...RUN, runCount: 1 });
    expect(tip).toContain('est.');
    expect(tip).toContain('list price');
    expect(tip).toContain('1 run');
    // Cache traffic is shown, but as its own figure rather than folded into
    // input/output where it would read as work done.
    expect(tip).toContain('cached 31k');
  });

  it('shows Take over spend rather than calling it "no runs"', () => {
    expect(usageTooltip({ ...RUN, runCount: 0 })).toContain('outside any agent run');
  });

  it('says when some tokens could not be priced', () => {
    expect(usageTooltip({ ...RUN, runCount: 1, unpriced: true })).toContain('no known price');
  });

  it('says plainly when a stage ran nothing', () => {
    expect(usageTooltip({ ...ZERO_USAGE })).toBe('no agent runs');
  });
});
