/**
 * Public entry point for the job pipeline.
 *
 * The pipeline was split out of this file for size: `pipeline.ts` holds the
 * pump/stage-advance engine (queueJob, pump, runNextStage and every stage's
 * executor — these recurse into one another, so they cannot be split further
 * without an import cycle), `lifecycle.ts` holds the actions a user or the
 * server itself takes on a job from outside a running stage (gates, cancel,
 * discard, startup reconciliation), `errors.ts` and `in-flight.ts` are the
 * small pieces both of those share. Every symbol this module used to export
 * is re-exported here, so `./jobs/runner.js` remains the one import path
 * callers and tests rely on.
 */
export { JobError } from './errors.js';
export { type CreateJobOptions, pump, queueJob } from './pipeline.js';
export {
  answerQuestion,
  approveGate,
  cancelJob,
  discardJob,
  type DiscardResult,
  reconcileJobsOnStartup,
  retryJob,
} from './lifecycle.js';
