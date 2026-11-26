import { createLogger } from '../utils/logger.js';

const logger = createLogger('factory-merge');

/**
 * The seam between the factory engine and the merge queue
 * (project/code-factory.md, "Merges go through one queue per project").
 *
 * When an item or a track passes review, the engine hands it here and lets go:
 * the item stays `open` at step `merge` with no claim, and dispatch skips it.
 * The queue, not the engine, rebases, merges, marks the items done and ticks
 * main's PROJECT.md. A session's Land enters the same queue (`session-land`).
 */
export interface MergeEntry {
  projectCwd: string;
  kind: 'item' | 'track' | 'session-land';
  branch: string;
  worktreePath: string;
  baseBranch: string;
  featureIds: string[];
  trackName?: string;
}

export interface MergeSink {
  enqueue(entry: MergeEntry): void;
}

/**
 * Until the real queue plugs in: log the handoff and nothing else, so a passed
 * item waits at step `merge` instead of merging unqueued.
 */
export const loggingMergeSink: MergeSink = {
  enqueue(entry) {
    logger.info({ ...entry }, 'factory: ready to merge; no merge queue is installed, so it waits at step merge');
  },
};

let sink: MergeSink = loggingMergeSink;

/** Install the merge queue (or a test double). */
export function setMergeSink(next: MergeSink): void {
  sink = next;
}

export function getMergeSink(): MergeSink {
  return sink;
}
