import { createLogger } from '../utils/logger.js';

const logger = createLogger('job-events');

/**
 * "Something about a job changed" — nothing more.
 *
 * Deliberately payload-free: subscribers rebuild from the store, so a burst of
 * writes inside one stage transition cannot deliver a half-applied view.
 *
 * Lives here rather than in the WebSocket layer because `store.ts` fires it —
 * the data layer must not import the transport.
 */

type ChangeCallback = () => void;

class JobEvents {
  private callbacks = new Set<ChangeCallback>();

  onChange(callback: ChangeCallback): () => void {
    this.callbacks.add(callback);
    return () => {
      this.callbacks.delete(callback);
    };
  }

  /**
   * A listener that throws must not break the DB write that triggered it —
   * a broadcast failing is not a reason for a stage transition to fail.
   */
  emitChange(): void {
    for (const callback of this.callbacks) {
      try {
        callback();
      } catch (error) {
        logger.error({ error }, 'Error in job change listener');
      }
    }
  }
}

export const jobEvents = new JobEvents();
