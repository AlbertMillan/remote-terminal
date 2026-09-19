import { describe, it, expect } from 'vitest';
import { runQueued, activeRunCount } from '../src/server/agent/claude-run.js';
import { isQueued, elapsedSince, type JobStage } from '../src/client/job-board.js';

/**
 * How agent runs take their turn, and how a turn spent waiting is reported.
 *
 * One global queue made the scheduler's promise untrue below the job level: it
 * admits one job per project, and then every stage of every project serialised
 * behind a single slot. A stage of project A would sit for minutes while
 * project B held it — marked `running` from the moment it was admitted, with no
 * process in existence — which is exactly how a job comes to look hung.
 */

/** A task that resolves when told to, so ordering can be asserted exactly. */
function gate(): { task: () => Promise<string>; release: () => void; started: () => boolean } {
  let begun = false;
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  return {
    task: async () => {
      begun = true;
      await held;
      return 'done';
    },
    release,
    started: () => begun,
  };
}

const settle = () => new Promise((r) => setTimeout(r, 0));

describe('run lanes', () => {
  it('serialises runs within one lane', async () => {
    const first = gate();
    const second = gate();

    const a = runQueued(first.task, 'project-a');
    const b = runQueued(second.task, 'project-a');
    await settle();

    expect(first.started()).toBe(true);
    // The whole point: the second run has NOT started, it is waiting its turn.
    expect(second.started()).toBe(false);

    first.release();
    await a;
    await settle();
    expect(second.started()).toBe(true);

    second.release();
    await b;
  });

  it('runs different lanes at the same time', async () => {
    const a = gate();
    const b = gate();

    const ra = runQueued(a.task, 'project-a');
    const rb = runQueued(b.task, 'project-b');
    await settle();

    // Neither project waits on the other — the bug this file exists for.
    expect(a.started()).toBe(true);
    expect(b.started()).toBe(true);
    expect(activeRunCount()).toBe(2);

    a.release();
    b.release();
    await Promise.all([ra, rb]);
  });

  it('keeps background work in one shared lane', async () => {
    // The session-log generator and PROJECT.md migration pass no lane. They are
    // background work and should not multiply across the machine.
    const first = gate();
    const second = gate();

    const a = runQueued(first.task);
    const b = runQueued(second.task);
    await settle();

    expect(first.started()).toBe(true);
    expect(second.started()).toBe(false);

    first.release();
    await a;
    second.release();
    await b;
  });

  it('releases the lane when a run throws', async () => {
    const after = gate();
    await expect(
      runQueued(async () => {
        throw new Error('stage blew up');
      }, 'project-a')
    ).rejects.toThrow('stage blew up');

    const run = runQueued(after.task, 'project-a');
    await settle();
    // A lane that leaked its slot on failure would deadlock the project.
    expect(after.started()).toBe(true);
    after.release();
    await run;
    // The slot is released in a `finally` chained after the caller's promise
    // settles, so it frees one microtask later — not on the same tick.
    await settle();
    expect(activeRunCount()).toBe(0);
  });
});

describe('queued vs running', () => {
  const stage = (over: Partial<JobStage> = {}): JobStage => ({
    name: 'implement',
    status: 'running',
    detail: null,
    startedAt: '2026-09-19T17:55:42.000Z',
    spawnedAt: null,
    finishedAt: null,
    ...over,
  });

  it('calls a stage with no process queued', () => {
    expect(isQueued(stage())).toBe(true);
  });

  it('calls a stage with a process running', () => {
    expect(isQueued(stage({ spawnedAt: '2026-09-19T18:00:54.000Z' }))).toBe(false);
  });

  it('never calls a finished stage queued', () => {
    expect(isQueued(stage({ status: 'passed', spawnedAt: null }))).toBe(false);
  });

  it('treats a stage that predates the column as running, not queued', () => {
    // Rows written before spawned_at existed have it undefined rather than
    // null. They did run; reporting them as queued would rewrite history.
    const old = stage();
    delete (old as { spawnedAt?: string | null }).spawnedAt;
    expect(isQueued(old)).toBe(false);
  });
});

describe('elapsedSince', () => {
  const now = new Date('2026-09-19T18:07:00.000Z').getTime();

  it('reads in seconds, minutes and hours', () => {
    expect(elapsedSince('2026-09-19T18:06:30.000Z', now)).toBe('30s');
    expect(elapsedSince('2026-09-19T17:55:42.000Z', now)).toBe('11m');
    expect(elapsedSince('2026-09-19T16:00:00.000Z', now)).toBe('2h7m');
  });

  it('says nothing rather than something wrong', () => {
    expect(elapsedSince(null, now)).toBe('');
    expect(elapsedSince('not a date', now)).toBe('');
    // Clock skew between server and browser must not print "-3m".
    expect(elapsedSince('2026-09-19T18:09:00.000Z', now)).toBe('');
  });
});
