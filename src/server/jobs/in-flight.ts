/** A stage executing in this process, with the handles needed to stop it. */
export interface InFlightStage {
  /** Aborts the stage's `claude -p` run, queued or already spawned. */
  aborter: AbortController;
  /** Settles when the stage has fully unwound; awaited before worktree teardown. */
  run: Promise<void>;
}

/**
 * Jobs currently executing a stage in this process.
 *
 * A single module-level instance shared by `pipeline.ts` (which populates it
 * around each stage run) and `lifecycle.ts` (whose `cancelJob` reads it to abort
 * and await the in-flight run) — never duplicated, or a cancel in one copy
 * would be invisible to the other.
 */
export const inFlight = new Map<string, InFlightStage>();
