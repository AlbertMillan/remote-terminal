import { existsSync } from 'fs';
import { getDatabase } from '../db/schema.js';
import { createLogger } from '../utils/logger.js';
import { getMerge } from './merge-queue-store.js';
import { removeWorktree, type TeardownResult } from '../worktrees/worktree.js';
import { startFactory } from './dispatcher.js';
import { enqueueMerge, type MergeOutcome, type MergeTicket } from './merge-queue.js';
import { setMergeSink, type MergeEntry, type MergeSink } from './merge-sink.js';

const logger = createLogger('factory-boot');

/**
 * Turning the factory on: the engine hands passed units to the real merge
 * queue, and the dispatcher starts claiming ready work.
 *
 * A loose item's worktree is its own (the engine created it for the item), so
 * once its merge lands it is torn down under the usual rules (removeWorktree:
 * links unlinked first, every step independent). A parked merge keeps it: the
 * user, or the resolver on a requeue, still needs it. A track's worktree is
 * the track's, and Land retires it.
 */

export interface SinkDeps {
  enqueue(entry: MergeEntry): MergeTicket;
  teardown(entry: MergeEntry): Promise<TeardownResult>;
}

export const defaultSinkDeps: SinkDeps = {
  enqueue: enqueueMerge,
  teardown: (entry) =>
    removeWorktree(entry.projectCwd, `factory-${entry.featureIds[0] ?? 'item'}`, {
      path: entry.worktreePath,
      // Merged: its commits are in the base, so the branch has nothing left to keep.
      deleteBranch: entry.branch,
    }),
};

export function factoryMergeSink(deps: SinkDeps = defaultSinkDeps): MergeSink {
  return {
    enqueue(entry) {
      const ticket = deps.enqueue(entry);
      if (entry.kind !== 'item') return;
      void ticket.done
        .then(async (outcome: MergeOutcome) => {
          if (outcome.status !== 'merged') return;
          const result = await deps.teardown(entry);
          logger.info({ branch: entry.branch, path: entry.worktreePath, ...result }, 'factory: merged item worktree torn down');
        })
        .catch((error: unknown) => {
          logger.warn({ branch: entry.branch, error: (error as Error).message }, 'factory: item worktree teardown failed');
        });
    },
  };
}

/**
 * Tear down the worktrees of loose items that merged without the sink seeing
 * it: entries resumed by resumeMergeQueues() at an earlier boot, or a merge
 * that finished as the server stopped. Only merged `item` entries whose
 * folder is still there. Returns the paths it tore down. Never throws.
 */
export async function sweepMergedWorktrees(deps: Pick<SinkDeps, 'teardown'> = defaultSinkDeps): Promise<string[]> {
  const swept: string[] = [];
  try {
    const rows = getDatabase()
      .prepare(`SELECT id FROM factory_merges WHERE kind = 'item' AND status = 'merged'`)
      .all() as { id: string }[];
    for (const { id } of rows) {
      const record = getMerge(id);
      if (!record || !existsSync(record.worktreePath)) continue;
      const result = await deps.teardown(record);
      if (result.removed) swept.push(record.worktreePath);
    }
  } catch (error) {
    logger.warn({ error: (error as Error).message }, 'factory: sweeping merged worktrees failed');
  }
  if (swept.length > 0) logger.info({ swept }, 'factory: tore down worktrees of items merged earlier');
  return swept;
}

/**
 * At boot, after the merge queue resumed. Never under vitest: a test that
 * builds the app must not start claiming work. An isolated boot
 * (CLAUDE_REMOTE_CONFIG) does run it, against its own database, so QA can
 * exercise the factory without touching the live server's.
 */
export function startFactoryAtBoot(env: NodeJS.ProcessEnv = process.env, deps: SinkDeps = defaultSinkDeps): boolean {
  if (env.VITEST) return false;
  void sweepMergedWorktrees(deps);
  setMergeSink(factoryMergeSink(deps));
  startFactory();
  logger.info({ isolated: Boolean(env.CLAUDE_REMOTE_CONFIG) }, 'factory: started');
  return true;
}
