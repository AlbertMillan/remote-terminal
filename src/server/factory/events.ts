import { createLogger } from '../utils/logger.js';

const logger = createLogger('factory-events');

/**
 * "Something in the factory changed" — an item, a dependency, a unit's run
 * state or a merge entry. Nothing more: subscribers rebuild from the store
 * (board.ts), so a burst of writes inside one transition never delivers a
 * half-applied view. The jobs/events.ts pattern, for the factory's tables.
 *
 * A leaf module: store.ts, run-state.ts and merge-queue-store.ts fire it, and
 * the WebSocket handler subscribes, so the data layer never imports the transport.
 */

type ChangeCallback = () => void;

class FactoryEvents {
  private callbacks = new Set<ChangeCallback>();

  onChange(callback: ChangeCallback): () => void {
    this.callbacks.add(callback);
    return () => {
      this.callbacks.delete(callback);
    };
  }

  /** A listener that throws must not fail the write that fired it. */
  emitChange(): void {
    for (const callback of this.callbacks) {
      try {
        callback();
      } catch (error) {
        logger.error({ error }, 'Error in factory change listener');
      }
    }
  }
}

export const factoryEvents = new FactoryEvents();
