/**
 * What something spent — a stage, a job, a project.
 *
 * Counts stay SPLIT, never summed: cache traffic dwarfs real input and output,
 * so "N tokens" would measure the cache rather than the work. `costUsd` is an
 * estimate at API list price, not money charged, since these runs bill
 * against the subscription; the UI must keep labelling it that way.
 */
export interface Usage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  /** 5-minute and 1-hour writes together; they are priced apart before summing. */
  cacheCreationTokens: number;
  costUsd: number;
  /**
   * Agent runs recorded. 0 means no run — though a job can still show tokens
   * from a Take over, which is spend outside any run.
   */
  runCount: number;
  /** True when some tokens came from a model the price table does not know. */
  unpriced: boolean;
}

export const ZERO_USAGE: Usage = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheCreationTokens: 0,
  costUsd: 0,
  runCount: 0,
  unpriced: false,
};

export function addUsage(a: Usage, b: Usage): Usage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
    cacheCreationTokens: a.cacheCreationTokens + b.cacheCreationTokens,
    costUsd: a.costUsd + b.costUsd,
    runCount: a.runCount + b.runCount,
    unpriced: a.unpriced || b.unpriced,
  };
}
