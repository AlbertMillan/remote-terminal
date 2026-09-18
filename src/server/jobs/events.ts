import { createLogger } from '../utils/logger.js';

const logger = createLogger('job-events');

/**
 * "Something about a job changed" — nothing more.
 *
 * Deliberately payload-free. Subscribers rebuild the whole summary from the
 * store, so a burst of writes inside one stage transition cannot deliver a
 * half-applied view, and no caller has to remember which fields a listener
 * cares about.
 *
 * Lives here rather than in the WebSocket layer because `store.ts` fires it:
 * the data layer must not import the transport. Mirrors `notificationService`,
 * which the same handler already subscribes to.
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
