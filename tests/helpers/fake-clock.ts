import type { DecisionClock } from '../../src/client/factory-decisions.js';

/**
 * A clock for the board's Undo window (src/client/factory-decisions.ts): time
 * moves only on `advance()`, so a test decides how long a toast has been up
 * without real waits, and the `setTimeout(0)` flushes the DOM tests use still run.
 */
export class FakeClock implements DecisionClock {
  t = 0;
  private timers: { at: number; fn: () => void; id: number }[] = [];
  private next = 1;

  now(): number {
    return this.t;
  }

  setTimeout(fn: () => void, ms: number): number {
    const id = this.next++;
    this.timers.push({ at: this.t + ms, fn, id });
    return id;
  }

  clearTimeout(handle: unknown): void {
    this.timers = this.timers.filter((x) => x.id !== handle);
  }

  advance(ms: number): void {
    this.t += ms;
    const due = this.timers.filter((x) => x.at <= this.t);
    this.timers = this.timers.filter((x) => x.at > this.t);
    for (const x of due) x.fn();
  }
}
