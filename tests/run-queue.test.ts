import { describe, it, expect } from 'vitest';
import { runQueued, activeRunCount } from '../src/server/agent/claude-run.js';

/**
 * How agent runs take their turn: per project lane (claude-run.ts), so one
 * project's long run never holds another project's agents in a single slot.
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
