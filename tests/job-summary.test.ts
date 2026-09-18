import { describe, it, expect, beforeEach, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

/**
 * The pushed job feed behind the live overlay.
 *
 * Two things matter here. First, the window: a finished job has to stay in the
 * feed long enough for a client to see it finish, and has to leave before a
 * client that reconnects an hour later is handed it as news. Second, the shape:
 * the overlay's strip is positional, so every job must carry all eight stages
 * in STAGE_ORDER whether or not it has reached them.
 */

const dataDir = mkdtempSync(join(tmpdir(), 'cr-summary-'));
const configPath = join(dataDir, 'config.json');
writeFileSync(configPath, JSON.stringify({ persistence: { dataDir } }));
process.env.CLAUDE_REMOTE_CONFIG = configPath;

const { loadConfig } = await import('../src/server/config.js');
const { initDatabase, closeDatabase, getDatabase } = await import('../src/server/db/schema.js');
const store = await import('../src/server/jobs/store.js');
const { jobEvents } = await import('../src/server/jobs/events.js');
const { buildJobsSummary, RECENT_TERMINAL_MS } = await import('../src/server/jobs/summary.js');
const { STAGE_ORDER } = await import('../src/server/jobs/types.js');
// The client half of the pair: how long a finished card stays on the panel.
const { FINISHED_LINGER_MS } = await import('../src/client/job-overlay.js');

const ALPHA = 'C:\\projects\\alpha-service';
const BETA = 'C:\\projects\\beta';

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
  rmSync(join(dataDir, 'projects.json'), { force: true });
});

function newJob(cwd = ALPHA, title = 'A feature') {
  return store.createJob({ projectCwd: cwd, featureId: 'f-1', title });
}

/** Terminal jobs age out on updated_at, which the store stamps itself. */
function backdate(id: string, msAgo: number): void {
  getDatabase()
    .prepare('UPDATE jobs SET updated_at = ? WHERE id = ?')
    .run(new Date(Date.now() - msAgo).toISOString(), id);
}

describe('buildJobsSummary', () => {
  it('includes every live job', () => {
    const queued = newJob(ALPHA, 'Queued one').id;
    const running = newJob(ALPHA, 'Running one').id;
    const parked = newJob(BETA, 'Parked one').id;
    store.updateJob(running, { status: 'running', stage: 'implement' });
    store.updateJob(parked, { status: 'parked', gate: 'review', parkReason: 'gate' });

    const ids = buildJobsSummary().jobs.map((j) => j.id);
    expect(ids).toHaveLength(3);
    expect(ids).toEqual(expect.arrayContaining([queued, running, parked]));
  });

  it('keeps a job that finished moments ago', () => {
    const id = newJob().id;
    store.updateJob(id, { status: 'done' });
    backdate(id, 30_000);

    expect(buildJobsSummary().jobs.map((j) => j.id)).toEqual([id]);
  });

  it('drops a job that finished long ago', () => {
    const id = newJob().id;
    store.updateJob(id, { status: 'done' });
    backdate(id, RECENT_TERMINAL_MS + 60_000);

    expect(buildJobsSummary().jobs).toHaveLength(0);
  });

  it('ages out cancelled and failed jobs on the same window', () => {
    const cancelled = newJob().id;
    const failed = newJob().id;
    store.updateJob(cancelled, { status: 'cancelled' });
    store.updateJob(failed, { status: 'failed' });
    backdate(cancelled, RECENT_TERMINAL_MS + 1000);
    backdate(failed, RECENT_TERMINAL_MS + 1000);

    expect(buildJobsSummary().jobs).toHaveLength(0);
  });

  it('never ages out a live job, however old', () => {
    const id = newJob().id;
    store.updateJob(id, { status: 'parked', parkReason: 'question' });
    backdate(id, 30 * 24 * 60 * 60 * 1000); // parked for a month

    expect(buildJobsSummary().jobs.map((j) => j.id)).toEqual([id]);
  });

  it('carries all eight stages in order, unreached ones as pending', () => {
    const id = newJob().id;
    store.finishStage(id, 'design', 'passed');
    store.startStage(id, 'implement');

    const summary = buildJobsSummary().jobs[0];
    expect(summary.stages.map((s) => s.name)).toEqual(STAGE_ORDER);
    expect(summary.stages[0]).toEqual({ name: 'design', status: 'passed' });
    expect(summary.stages[1]).toEqual({ name: 'implement', status: 'running' });
    expect(summary.stages[7]).toEqual({ name: 'rebuild', status: 'pending' });
  });

  it('truncates a long detail to a card-sized excerpt', () => {
    const id = newJob().id;
    store.updateJob(id, { status: 'parked', parkReason: 'question', detail: 'x'.repeat(2000) });

    const detail = buildJobsSummary().jobs[0].detail!;
    expect(detail.length).toBeLessThan(260);
    expect(detail.endsWith('…')).toBe(true);
  });

  it('reports an empty detail as null rather than blank text', () => {
    const id = newJob().id;
    store.updateJob(id, { status: 'running', detail: '   ' });
    expect(buildJobsSummary().jobs[0].detail).toBeNull();
  });

  it('names a project by its directory basename', () => {
    newJob(ALPHA);
    expect(buildJobsSummary().jobs[0].projectName).toBe('alpha-service');
  });

  it('prefers a registry name override, as the workspace board does', () => {
    writeFileSync(
      join(dataDir, 'projects.json'),
      JSON.stringify({ projects: [{ cwd: ALPHA, name: 'Alpha (prod)' }] })
    );
    newJob(ALPHA);
    expect(buildJobsSummary().jobs[0].projectName).toBe('Alpha (prod)');
  });

  it('rolls a job cost up from its stages', () => {
    const id = newJob().id;
    store.addStageUsage(id, 'design', {
      inputTokens: 10,
      outputTokens: 20,
      cacheReadTokens: 30,
      cacheCreationTokens: 40,
      costUsd: 0.25,
    });
    store.addStageUsage(id, 'implement', {
      inputTokens: 10,
      outputTokens: 20,
      cacheReadTokens: 30,
      cacheCreationTokens: 40,
      costUsd: 0.75,
    });

    expect(buildJobsSummary().jobs[0].costUsd).toBeCloseTo(1.0, 10);
  });
});

describe('the terminal-job window', () => {
  it('outlasts the panel window, or a finished card would vanish before its minute', () => {
    // The panel shows a finished job for FINISHED_LINGER_MS from when it first
    // saw it. If the server stopped sending it sooner, the card would disappear
    // early -- silently, and only for whoever happened to be watching.
    expect(FINISHED_LINGER_MS).toBeLessThan(RECENT_TERMINAL_MS);
  });
});

describe('jobEvents', () => {
  it('fires on create, on a job patch and on a stage write', () => {
    let fired = 0;
    const off = jobEvents.onChange(() => fired++);
    try {
      const id = newJob().id;
      expect(fired).toBe(1);

      store.updateJob(id, { status: 'running' });
      expect(fired).toBe(2);

      // startStage and finishStage both route through updateStage.
      store.startStage(id, 'design');
      expect(fired).toBe(3);

      store.finishStage(id, 'design', 'passed');
      expect(fired).toBe(4);

      store.deleteJob(id);
      expect(fired).toBe(5);
    } finally {
      off();
    }
  });

  it('does not fire when a delete removed nothing', () => {
    let fired = 0;
    const off = jobEvents.onChange(() => fired++);
    try {
      store.deleteJob('no-such-job');
      expect(fired).toBe(0);
    } finally {
      off();
    }
  });

  it('survives a listener that throws, so a stage write cannot fail on it', () => {
    const offBad = jobEvents.onChange(() => {
      throw new Error('listener exploded');
    });
    let good = 0;
    const offGood = jobEvents.onChange(() => good++);
    try {
      expect(() => newJob()).not.toThrow();
      expect(good).toBe(1);
    } finally {
      offBad();
      offGood();
    }
  });
});
