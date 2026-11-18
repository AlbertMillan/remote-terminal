import type { SessionInfo } from './session-types.js';

/**
 * The sidebar's model, free of the DOM: how sessions group under the session that started
 * them and under tracks, each row's state, what needs the user, and the filter.
 */

/**
 * Sessions grouped under the session that started them (docs/session-orchestration.md).
 * A child renders under its parent, in the parent's category, whatever its own categoryId.
 * One level only: a child whose parent is gone (deleted), or is itself a child, is
 * top-level. Children keep creation order, except that a read-only peer renders right
 * after its builder (peersAfterBuilders).
 */
export function groupStartedSessions(sessions: Map<string, SessionInfo>): {
  childrenOf: Map<string, SessionInfo[]>;
  nested: Set<string>;
} {
  const childrenOf = new Map<string, SessionInfo[]>();
  const nested = new Set<string>();
  for (const session of sessions.values()) {
    const parent = session.spawnedBy ? sessions.get(session.spawnedBy) : undefined;
    if (!parent || parent.spawnedBy || parent.id === session.id) continue;
    const list = childrenOf.get(parent.id) ?? [];
    list.push(session);
    childrenOf.set(parent.id, list);
    nested.add(session.id);
  }
  for (const [id, list] of childrenOf) childrenOf.set(id, peersAfterBuilders(list));
  return { childrenOf, nested };
}

/** A builder and every read-only peer beside it, or one session on its own (no peers). */
export interface TrackGroup {
  lead: SessionInfo;
  peers: SessionInfo[];
}

/**
 * One parent's children as tracks, in creation order. A read-only peer joins the newest
 * writer in the same worktree started before it; a builder may have any number of peers
 * (project/builder-critic-pairs.md). A peer with no such builder is a group of its own.
 */
export function trackGroups(children: SessionInfo[]): TrackGroup[] {
  const sorted = [...children].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const builderOf = (peer: SessionInfo): SessionInfo | undefined => {
    let found: SessionInfo | undefined;
    for (const s of sorted) {
      if (s.createdAt > peer.createdAt) break;
      if (s.access !== 'read' && s.cwd === peer.cwd) found = s;
    }
    return found;
  };
  const builders = new Map(sorted.filter((s) => s.access === 'read').map((p) => [p.id, builderOf(p)]));
  const groups: TrackGroup[] = [];
  const byLead = new Map<string, TrackGroup>();
  for (const s of sorted) {
    if (s.access === 'read' && builders.get(s.id)) continue;
    const group = { lead: s, peers: [] as SessionInfo[] };
    groups.push(group);
    byLead.set(s.id, group);
  }
  for (const s of sorted) {
    const builder = s.access === 'read' ? builders.get(s.id) : undefined;
    if (builder) byLead.get(builder.id)?.peers.push(s);
  }
  return groups;
}

/**
 * One parent's children in creation order, each read-only peer moved right after its
 * builder: the newest writer in the same worktree started before it. A peer with no such
 * builder keeps its place.
 */
export function peersAfterBuilders(children: SessionInfo[]): SessionInfo[] {
  return trackGroups(children).flatMap((g) => [g.lead, ...g.peers]);
}

export type RowState = 'input' | 'done' | 'live' | 'stopped';
export const STATE_RANK: Record<RowState, number> = { input: 0, done: 1, live: 2, stopped: 3 };
export const STATE_LABEL: Record<RowState, string> = {
  input: 'Waiting for input',
  done: 'Task completed',
  live: 'Running',
  stopped: 'Stopped',
};

type Notification = { type: 'needs-input' | 'completed'; timestamp: string } | undefined;

/** A row's status glyph. A session with no live PTY is stopped whatever it last reported. */
export function rowState(session: SessionInfo, notification: Notification): RowState {
  if (!session.attachable) return 'stopped';
  if (notification?.type === 'needs-input') return 'input';
  if (notification?.type === 'completed') return 'done';
  return 'live';
}

/** The most urgent of several states (a track's members, a category's rows). */
export function worstState(states: RowState[]): RowState {
  return states.reduce<RowState>((w, s) => (STATE_RANK[s] < STATE_RANK[w] ? s : w), 'stopped');
}

/** Every live session waiting for input, children included, longest-waiting first. */
export function needsYou(
  sessions: Map<string, SessionInfo>,
  notifications: Map<string, { type: 'needs-input' | 'completed'; timestamp: string }>
): SessionInfo[] {
  return [...sessions.values()]
    .filter((s) => s.attachable && notifications.get(s.id)?.type === 'needs-input')
    .sort((a, b) => (notifications.get(a.id)?.timestamp ?? '').localeCompare(notifications.get(b.id)?.timestamp ?? ''));
}

/**
 * The sidebar filter: every whitespace-separated word must appear in the session's name,
 * its `@claudeName`, account, category, the name of the session that started it,
 * `read-only` for a peer, or `stopped` for a row with no live PTY.
 */
export function matchesFilter(
  session: SessionInfo,
  query: string,
  ctx: { parentName?: string | null; categoryName?: string | null } = {}
): boolean {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return true;
  const hay = [
    session.name,
    session.claudeName ? `@${session.claudeName}` : '',
    session.account ?? '',
    ctx.categoryName ?? '',
    ctx.parentName ?? '',
    session.access === 'read' ? 'read-only' : '',
    session.attachable ? '' : 'stopped',
  ]
    .join(' ')
    .toLowerCase();
  return words.every((w) => hay.includes(w));
}
