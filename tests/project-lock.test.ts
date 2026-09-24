import { describe, it, expect } from 'vitest';
import { ProjectBusyError, withProjectLock } from '../src/server/projects/project-lock.js';

/**
 * Track operations are try-locked per project: a second one is refused with
 * what is holding the lock, never queued (queueing deadlocks a Delete against
 * the merge stage it is cancelling — see project-lock.ts).
 */

describe('withProjectLock', () => {
  it('refuses a second operation on the same project while the first runs', async () => {
    let release!: () => void;
    const first = withProjectLock('C:\\p\\alpha', 'landing "A"', () => new Promise<void>((r) => (release = r)));

    await expect(withProjectLock('c:/p/alpha/', 'deleting "B"', async () => 1)).rejects.toThrow(
      /busy \(landing "A"\)/
    );
    await expect(withProjectLock('C:\\p\\alpha', 'x', async () => 1)).rejects.toBeInstanceOf(ProjectBusyError);

    release();
    await first;
    await expect(withProjectLock('C:\\p\\alpha', 'again', async () => 2)).resolves.toBe(2);
  });

  it('does not block a different project, and releases after a failure', async () => {
    let release!: () => void;
    const held = withProjectLock('C:\\p\\alpha', 'landing', () => new Promise<void>((r) => (release = r)));
    await expect(withProjectLock('C:\\p\\beta', 'deleting', async () => 'ok')).resolves.toBe('ok');
    release();
    await held;

    await expect(
      withProjectLock('C:\\p\\alpha', 'boom', async () => {
        throw new Error('boom');
      })
    ).rejects.toThrow('boom');
    await expect(withProjectLock('C:\\p\\alpha', 'after', async () => 3)).resolves.toBe(3);
  });
});
