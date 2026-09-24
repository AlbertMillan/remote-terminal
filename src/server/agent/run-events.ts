/**
 * "A headless run has settled" — success, rejection, crash or cancel.
 *
 * Its own module, with no imports, so `claude-run` can announce it without
 * depending on whoever listens. The usage ledger subscribes to ingest the run's
 * transcript; having claude-run import the ledger instead made the ledger unable
 * to import anything that imports claude-run (jobs/worktree among them).
 */
type Listener = () => void;

const listeners = new Set<Listener>();

/** Subscribe; returns the unsubscribe function. */
export function onRunSettled(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Never throws: a listener's failure must not become the run's. */
export function emitRunSettled(): void {
  for (const listener of listeners) {
    try {
      listener();
    } catch {
      // a listener's problem, not the run's
    }
  }
}
