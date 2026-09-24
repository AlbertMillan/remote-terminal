import { pathKey } from '../sessions/project-discovery.js';

/**
 * One track operation at a time per project: Land, Delete track, Branch now,
 * and the merge stage when it merges into a track branch.
 *
 * Each of these checks the repository's state and then acts on it over many
 * git calls. Two at once — a double-clicked Delete, a job approved at its merge
 * gate while its track lands — both pass their checks and then undo each
 * other's work, or merge into a worktree the other is removing.
 *
 * TRY-acquire, never wait: Delete holds the lock while cancelJob() awaits a
 * running stage, and a merge stage waiting on the same lock would never unwind
 * — a deadlock. A second caller is refused with a message instead (409 from a
 * route; a failed, retryable stage from the merge).
 */

export class ProjectBusyError extends Error {
  readonly status = 409;
  constructor(message: string) {
    super(message);
    this.name = 'ProjectBusyError';
  }
}

const held = new Map<string, string>();

/** Run `fn` holding the project's lock, or throw ProjectBusyError if it is taken. */
export async function withProjectLock<T>(cwd: string, what: string, fn: () => Promise<T>): Promise<T> {
  const key = pathKey(cwd);
  const holder = held.get(key);
  if (holder !== undefined) {
    throw new ProjectBusyError(`This project is busy (${holder}). Try again when that finishes.`);
  }
  held.set(key, what);
  try {
    return await fn();
  } finally {
    held.delete(key);
  }
}
