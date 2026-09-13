import { describe, it, expect, beforeEach, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

/**
 * Per-stage token accounting against a real database.
 *
 * The behaviour that matters: usage ACCUMULATES. A stage is not one agent run —
 * qa runs a pass per flow, fix can run more than once, and a retried stage
 * genuinely costs again — so a write that replaced rather than added would
 * report the last run as if it were the whole stage.
 */

const dataDir = mkdtempSync(join(tmpdir(), 'cr-usage-'));
const configPath = join(dataDir, 'config.json');
writeFileSync(configPath, JSON.stringify({ persistence: { dataDir } }));
process.env.CLAUDE_REMOTE_CONFIG = configPath;

const { loadConfig } = await import('../src/server/config.js');
const { initDatabase, closeDatabase, getDatabase } = await import('../src/server/db/schema.js');
const store = await import('../src/server/jobs/store.js');
const { ZERO_USAGE, sumUsage } = await import('../src/server/jobs/types.js');
// The board's labels: what the user actually reads off the numbers.
const { formatCost, formatTokens, usageTooltip } = await import('../src/client/job-board.js');

const CWD = 'C:\\p\\alpha';

const RUN = {
  inputTokens: 9,
  outputTokens: 176,
  cacheReadTokens: 18004,
  cacheCreationTokens: 13004,
  costUsd: 0.0287,
};

beforeAll(() => {
  loadConfig();
  initDatabase();
});

afterAll(() => {
  closeDatabase();
  rmSync(dataDir, { recursive: true, force: true });
});

beforeEach(() => {
  getDatabase().exec('DELETE FROM jobs');
});

function newJob(title = 'A feature') {
  return store.createJob({ projectCwd: CWD, featureId: 'f-1', title });
}

describe('stage usage', () => {
  it('starts at zero with no runs recorded', () => {
    const job = store.getJobWithStages(newJob().id)!;
    expect(job.usage).toEqual(ZERO_USAGE);
    for (const stage of job.stages) expect(stage.usage).toEqual(ZERO_USAGE);
  });

  it('records one run against the stage that made it', () => {
    const id = newJob().id;
    store.addStageUsage(id, 'design', RUN);

    const job = store.getJobWithStages(id)!;
    const design = job.stages.find((s) => s.name === 'design')!;
    expect(design.usage).toEqual({ ...RUN, runCount: 1 });
    // Nothing leaks onto the stages that did not run.
    expect(job.stages.find((s) => s.name === 'qa')!.usage).toEqual(ZERO_USAGE);
  });

  it('accumulates across the several runs one stage can make', () => {
    const id = newJob().id;
    store.addStageUsage(id, 'qa', RUN);
    store.addStageUsage(id, 'qa', RUN);
    store.addStageUsage(id, 'qa', RUN);

    const qa = store.getJobWithStages(id)!.stages.find((s) => s.name === 'qa')!;
    expect(qa.usage.runCount).toBe(3);
    expect(qa.usage.outputTokens).toBe(RUN.outputTokens * 3);
    expect(qa.usage.costUsd).toBeCloseTo(RUN.costUsd * 3, 10);
  });

  it('rolls a job up from its stages', () => {
    const id = newJob().id;
    store.addStageUsage(id, 'design', RUN);
    store.addStageUsage(id, 'implement', RUN);

    const job = store.getJobWithStages(id)!;
    expect(job.usage.runCount).toBe(2);
    expect(job.usage.inputTokens).toBe(RUN.inputTokens * 2);
    expect(job.usage.cacheReadTokens).toBe(RUN.cacheReadTokens * 2);
  });

  it('totals a project across its jobs, listed or fetched', () => {
    const a = newJob('one').id;
    const b = newJob('two').id;
    store.addStageUsage(a, 'design', RUN);
    store.addStageUsage(b, 'design', RUN);
    store.addStageUsage(b, 'review', RUN);

    const jobs = store.listJobsForProject(CWD);
    expect(jobs).toHaveLength(2);
    // listJobs() groups stages in memory; make sure that path rolls up too.
    expect(sumUsage(jobs).runCount).toBe(3);
    expect(sumUsage(jobs).costUsd).toBeCloseTo(RUN.costUsd * 3, 10);
  });

  it('counts cancelled and failed jobs — abandoned work still cost something', () => {
    const id = newJob().id;
    store.addStageUsage(id, 'design', RUN);
    store.updateJob(id, { status: 'cancelled' });

    expect(sumUsage(store.listJobsForProject(CWD)).runCount).toBe(1);
  });

  it('ignores usage for a job that no longer exists rather than throwing', () => {
    expect(() => store.addStageUsage('gone', 'design', RUN)).not.toThrow();
  });

  it('keeps token counts integral so SQLite can store them', () => {
    const id = newJob().id;
    store.addStageUsage(id, 'design', { ...RUN, inputTokens: 10.6 });
    const design = store.getJobWithStages(id)!.stages.find((s) => s.name === 'design')!;
    expect(design.usage.inputTokens).toBe(11);
  });
});

describe('how usage reads on the board', () => {
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

  it('says plainly when a stage ran nothing', () => {
    expect(usageTooltip({ ...ZERO_USAGE })).toBe('no agent runs');
  });
});
