import { listMerges } from './merge-queue-store.js';
import { listItems } from './store.js';

/**
 * A track's factory work that Land and Update of that track must wait for
 * (docs/track-branches.md): an item an agent is running (a `run` claim), or a
 * factory merge entry queued, holding or running. Landing or updating under
 * either merges and tears down a worktree an agent is still writing in, or
 * races the queue's own merge into the track.
 *
 * Doesn't block: a unit a terminal session holds (Land closes the worktree's
 * sessions after every refusal), a parked or closed unit, and `ownMerge`, the
 * queue's own entry whose Land or update is the one asking.
 *
 * Returns one line per blocker, naming it and what it is doing; empty when
 * nothing blocks. Reads only the factory's leaf stores, so projects/ can call it.
 */
export function trackFactoryWork(projectCwd: string, trackName: string, ownMerge?: string): string[] {
  const items = listItems({ projectCwd }).filter((i) => i.trackName === trackName);
  const ids = new Set(items.map((i) => i.featureId));
  const out: string[] = [];
  for (const i of items) {
    if (i.status === 'in_progress' && i.claimKind === 'run') {
      out.push(`${i.featureId} (an agent is running ${i.step ?? 'its first step'})`);
    }
  }
  for (const m of listMerges(projectCwd, ['queued', 'holding', 'running'])) {
    if (m.id === ownMerge || m.kind === 'session-land') continue;
    if (m.trackName !== trackName && !m.featureIds.some((f) => ids.has(f))) continue;
    out.push(`the factory's merge of ${m.kind === 'track' ? `"${trackName}"` : m.featureIds.join(', ')} (${m.status} in the merge queue)`);
  }
  return out;
}

/** The refusal Land and Update give while trackFactoryWork() is not empty. */
export function trackFactoryWorkMessage(verb: 'land' | 'update', blockers: string[]): string {
  return `The factory is still working on this track: ${blockers.join('; ')}. Wait for it to finish, or cancel it, before you ${verb} the track`;
}
