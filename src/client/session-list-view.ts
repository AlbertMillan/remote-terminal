import { escapeHtml, escapeAttr } from './html-utils.js';
import type { SessionInfo, CategoryInfo } from './session-types.js';

/**
 * The narrow surface SessionListView needs from SessionManager. `sessions`,
 * `categories` and `sessionNotifications` are SessionManager's Maps, shared
 * by reference (it owns their identity and content; this view only reads
 * them) so a mutation there is visible on the next render without a copy.
 */
export interface SessionListViewHost {
  sessions: Map<string, SessionInfo>;
  categories: Map<string, CategoryInfo>;
  sessionNotifications: Map<string, { type: 'needs-input' | 'completed'; timestamp: string }>;
  getCurrentSessionId(): string | null;
  attachToSession(sessionId: string): void;
  reviveSession(sessionId: string): void;
  deleteSession(sessionId: string): void;
  moveSession(sessionId: string, categoryId: string | null): void;
  toggleCategory(categoryId: string, collapsed: boolean): void;
  deleteCategory(categoryId: string): void;
  showCategoryModal(mode: 'create' | 'rename', category?: CategoryInfo): void;
  reorderSessions(updates: { id: string; sortOrder: number }[]): void;
}

// Per browser, so a phone and a desktop can each keep their own view
// (project/sidebar-redesign.md). Started sessions are folded by default, so the stored set
// holds what is *expanded*: parent ids, and `track:<builderId>` for a builder's peers. The
// old key held collapsed ids; reading it here would invert every group, so it is dropped.
const EXPANDED_GROUPS_KEY = 'claude-remote.expandedSessionGroups';
const LEGACY_COLLAPSED_GROUPS_KEY = 'claude-remote.collapsedSessionGroups';
const STOPPED_OPEN_KEY = 'claude-remote.stoppedDrawerOpen';
/** Settings → Sidebar: keep stopped sessions in their category instead of the drawer. */
export const KEEP_STOPPED_IN_PLACE_KEY = 'claude-remote.keepStoppedInPlace';
const TRACK_PREFIX = 'track:';
/** How long the copy feedback (check icon, row edge, toast) stays. */
const COPY_FEEDBACK_MS = 1600;
/** Peers shown as squares on a track row before the rest become "+n". */
const MAX_PEER_GLYPHS = 3;
/** Child tracks shown as dots on a folded parent. */
const MAX_TALLY_DOTS = 8;
/** Account colours (styles.css `--account-0…3`), by position in /api/accounts, as the usage chip. */
const ACCOUNT_COLOURS = 4;

function loadExpanded(): Set<string> {
  try {
    localStorage.removeItem(LEGACY_COLLAPSED_GROUPS_KEY);
    const raw = JSON.parse(localStorage.getItem(EXPANDED_GROUPS_KEY) || '[]');
    return new Set(Array.isArray(raw) ? raw.filter((v): v is string => typeof v === 'string') : []);
  } catch {
    return new Set();
  }
}

export function readFlag(key: string): boolean {
  try {
    return localStorage.getItem(key) === 'true';
  } catch {
    return false;
  }
}

export function writeFlag(key: string, value: boolean): void {
  try {
    localStorage.setItem(key, String(value));
  } catch {
    /* storage blocked: the choice still holds for this page */
  }
}

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
const STATE_RANK: Record<RowState, number> = { input: 0, done: 1, live: 2, stopped: 3 };
const STATE_LABEL: Record<RowState, string> = {
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

/** Copy text: the async clipboard first, then the selection fallback plain HTTP still allows. */
async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* refused (insecure origin, no permission): try the fallback */
  }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    const ok = typeof document.execCommand === 'function' && document.execCommand('copy');
    ta.remove();
    return ok;
  } catch {
    return false;
  }
}

const ICON = {
  chevron:
    '<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"></polyline></svg>',
  handle:
    '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="9" cy="5" r="1"/><circle cx="9" cy="12" r="1"/><circle cx="9" cy="19" r="1"/><circle cx="15" cy="5" r="1"/><circle cx="15" cy="12" r="1"/><circle cx="15" cy="19" r="1"/></svg>',
  at: '<svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="4"></circle><path d="M16 8v5a3 3 0 0 0 6 0v-1a10 10 0 1 0-4 8"></path></svg>',
  check:
    '<svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="4 12 10 18 20 6"></polyline></svg>',
  play: '<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="5 3 19 12 5 21 5 3"></polygon></svg>',
  trash:
    '<svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg>',
  pen: '<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/></svg>',
  x: '<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>',
};

interface RowOptions {
  /** Nested under a parent (or a track): indented, never dragged. */
  child?: boolean;
  /** The sessions it started; a folded parent shows them as a tally. */
  children?: SessionInfo[];
  /** A builder's track: its peers as squares and its own fold arrow. */
  track?: TrackGroup;
  /** Outside the category tree (strip, drawer, filter matches): no fold, no drag. */
  flat?: boolean;
  /** Muted text after the name: the parent or category it lives in. */
  context?: string | null;
  /** Shown as a chip (the drawer names the category a stopped row came from). */
  chip?: string | null;
  /** In the tree but outside a category (the drawer): folds, but no drag. */
  noDrag?: boolean;
}

/**
 * The sidebar session list (project/sidebar-redesign.md): a "Needs you" strip, categories
 * of one-line rows with started sessions folded under their parent, a "Stopped" drawer,
 * and a filter. Drag/drop reordering is unchanged.
 */
export class SessionListView {
  private draggedSessionId: string | null = null;
  private dropIndicatorEl: HTMLElement | null = null;
  private childrenOf = new Map<string, SessionInfo[]>();
  private nested = new Set<string>();
  private expanded = loadExpanded();
  private stoppedOpen = readFlag(STOPPED_OPEN_KEY);
  private filter = '';
  private wired = false;
  /** Account names in config order (GET /api/accounts), for the dot colours; null until loaded. */
  private accountOrder: string[] | null = null;
  private toastTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly host: SessionListViewHost) {}

  /** Focus the filter box (Alt+K). The caller opens the sidebar first. */
  focusFilter(): void {
    const input = document.getElementById('session-filter') as HTMLInputElement | null;
    input?.focus();
    input?.select();
  }

  private wireOnce(): void {
    if (this.wired) return;
    this.wired = true;
    const input = document.getElementById('session-filter') as HTMLInputElement | null;
    input?.addEventListener('input', () => {
      this.filter = input.value;
      this.render();
    });
    input?.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      input.value = '';
      this.filter = '';
      input.blur();
      this.render();
    });
    void this.loadAccountOrder();
  }

  private async loadAccountOrder(): Promise<void> {
    try {
      const res = await fetch('/api/accounts');
      if (!res.ok) return;
      const data = (await res.json()) as { accounts?: { name: string }[] };
      this.accountOrder = (data.accounts ?? []).map((a) => a.name);
      this.render();
    } catch {
      /* no colours: the dots stay neutral, the title still names the account */
    }
  }

  private saveExpanded(): void {
    // Forget sessions that are gone, so the stored list never grows. Only here, on a
    // deliberate toggle: at load the session list may not have arrived yet.
    for (const key of this.expanded) {
      const id = key.startsWith(TRACK_PREFIX) ? key.slice(TRACK_PREFIX.length) : key;
      if (!this.host.sessions.has(id)) this.expanded.delete(key);
    }
    try {
      localStorage.setItem(EXPANDED_GROUPS_KEY, JSON.stringify([...this.expanded]));
    } catch {
      /* storage blocked: the toggle still holds for this page */
    }
  }

  private toggleExpanded(key: string): void {
    if (this.expanded.has(key)) this.expanded.delete(key);
    else this.expanded.add(key);
    this.saveExpanded();
    this.render();
  }

  private stateOf(session: SessionInfo): RowState {
    return rowState(session, this.host.sessionNotifications.get(session.id));
  }

  render(): void {
    const listEl = document.getElementById('session-list');
    if (!listEl) return;
    this.wireOnce();

    listEl.innerHTML = '';

    // Started sessions are rendered by their parent's row, so only top-level ones
    // take part in the category grouping below.
    const { childrenOf, nested } = groupStartedSessions(this.host.sessions);
    this.childrenOf = childrenOf;
    this.nested = nested;

    if (this.filter.trim()) {
      this.renderMatches(listEl, this.filter.trim());
      return;
    }

    const waiting = needsYou(this.host.sessions, this.host.sessionNotifications);
    if (waiting.length > 0) this.renderAttention(listEl, waiting);

    const sortedSessions = Array.from(this.host.sessions.values())
      .filter((s) => !nested.has(s.id))
      .sort((a, b) => a.sortOrder - b.sortOrder);

    // A row goes to the drawer only when nothing in its group is live: a stopped parent
    // whose started sessions still run stays in place, or they would disappear with it.
    const keepInPlace = readFlag(KEEP_STOPPED_IN_PLACE_KEY);
    const groupLive = (s: SessionInfo) => s.attachable || (childrenOf.get(s.id) ?? []).some((c) => c.attachable);
    const inPlace = keepInPlace ? sortedSessions : sortedSessions.filter(groupLive);
    const stopped = keepInPlace ? [] : sortedSessions.filter((s) => !groupLive(s));

    const sortedCategories = Array.from(this.host.categories.values()).sort((a, b) => a.sortOrder - b.sortOrder);
    if (sortedCategories.length === 0) {
      const ul = document.createElement('ul');
      ul.className = 'category-sessions';
      for (const session of inPlace) this.renderSessionGroup(ul, session);
      listEl.appendChild(ul);
    } else {
      for (const category of sortedCategories) {
        this.renderCategory(listEl, category, inPlace.filter((s) => s.categoryId === category.id));
      }
      const uncategorized = inPlace.filter((s) => !s.categoryId || !this.host.categories.has(s.categoryId));
      this.renderUncategorizedSection(listEl, uncategorized);
    }

    if (stopped.length > 0) this.renderStopped(listEl, stopped);
  }

  /** "Needs you": every waiting session, children included, with the parent as context. */
  private renderAttention(container: HTMLElement, waiting: SessionInfo[]): void {
    const section = document.createElement('div');
    section.className = 'category-section attention-section';
    section.innerHTML = `<div class="category-header attention-header"><span class="category-name">Needs you</span><span class="category-count">${waiting.length}</span></div>`;
    const ul = document.createElement('ul');
    ul.className = 'category-sessions';
    for (const s of waiting) {
      const parent = this.nested.has(s.id) && s.spawnedBy ? this.host.sessions.get(s.spawnedBy) : undefined;
      this.renderSessionItem(ul, s, { flat: true, context: parent?.name ?? null });
    }
    section.appendChild(ul);
    container.appendChild(section);
  }

  /** The drawer of stopped top-level sessions, folded by default, each naming its category. */
  private renderStopped(container: HTMLElement, stopped: SessionInfo[]): void {
    const section = document.createElement('div');
    section.className = 'category-section stopped-section' + (this.stoppedOpen ? '' : ' collapsed');
    const header = document.createElement('button');
    header.type = 'button';
    header.className = 'category-header stopped-header';
    header.setAttribute('aria-expanded', String(this.stoppedOpen));
    header.innerHTML = `<span class="category-toggle">${ICON.chevron}</span><span class="category-name">Stopped</span><span class="category-count">${this.rowCount(stopped)}</span>`;
    header.addEventListener('click', () => {
      this.stoppedOpen = !this.stoppedOpen;
      writeFlag(STOPPED_OPEN_KEY, this.stoppedOpen);
      this.render();
    });
    section.appendChild(header);
    if (this.stoppedOpen) {
      const ul = document.createElement('ul');
      ul.className = 'category-sessions';
      for (const s of stopped) {
        const category = s.categoryId ? this.host.categories.get(s.categoryId) : undefined;
        this.renderSessionGroup(ul, s, { noDrag: true, chip: category?.name ?? null });
      }
      section.appendChild(ul);
    }
    container.appendChild(section);
  }

  /** A non-empty filter: every matching session, flat, with its parent or category as context. */
  private renderMatches(container: HTMLElement, query: string): void {
    const ordered: SessionInfo[] = [];
    const top = [...this.host.sessions.values()].filter((s) => !this.nested.has(s.id)).sort((a, b) => a.sortOrder - b.sortOrder);
    for (const s of top) ordered.push(s, ...(this.childrenOf.get(s.id) ?? []));
    const contextOf = (s: SessionInfo) => {
      const parent = this.nested.has(s.id) && s.spawnedBy ? this.host.sessions.get(s.spawnedBy) : undefined;
      const category = s.categoryId ? this.host.categories.get(s.categoryId) : undefined;
      return { parentName: parent?.name ?? null, categoryName: category?.name ?? null };
    };
    const hits = ordered.filter((s) => matchesFilter(s, query, contextOf(s)));

    const section = document.createElement('div');
    section.className = 'category-section matches-section';
    section.innerHTML = `<div class="category-header"><span class="category-name">Matches</span><span class="category-count">${hits.length}</span></div>`;
    const ul = document.createElement('ul');
    ul.className = 'category-sessions';
    for (const s of hits) {
      const ctx = contextOf(s);
      this.renderSessionItem(ul, s, { flat: true, context: ctx.parentName ?? ctx.categoryName });
    }
    if (hits.length === 0) {
      const empty = document.createElement('li');
      empty.className = 'session-filter-empty';
      empty.textContent = `No session matches "${query}".`;
      ul.appendChild(empty);
    }
    section.appendChild(ul);
    container.appendChild(section);
  }

  /** "2 waiting · 1 done" over a category's rows and their children; empty when quiet. */
  private categoryTally(sessions: SessionInfo[]): string {
    let waiting = 0;
    let done = 0;
    for (const s of sessions) {
      for (const member of [s, ...(this.childrenOf.get(s.id) ?? [])]) {
        const state = this.stateOf(member);
        if (state === 'input') waiting++;
        else if (state === 'done') done++;
      }
    }
    const parts: string[] = [];
    if (waiting > 0) parts.push(`<span class="tally-input">${waiting} waiting</span>`);
    if (done > 0) parts.push(`<span class="tally-done">${done} done</span>`);
    return parts.length ? `<span class="category-tally">${parts.join(' · ')}</span>` : '';
  }

  private renderCategory(container: HTMLElement, category: CategoryInfo, sessions: SessionInfo[]): void {
    const section = document.createElement('div');
    section.className = 'category-section';
    if (category.collapsed) section.classList.add('collapsed');
    if (sessions.length === 0) section.classList.add('empty');
    section.dataset.categoryId = category.id;

    const header = document.createElement('div');
    header.className = 'category-header';
    header.innerHTML = `
      <button class="category-toggle" title="${category.collapsed ? 'Expand' : 'Collapse'}" aria-expanded="${category.collapsed ? 'false' : 'true'}">${ICON.chevron}</button>
      <span class="category-name">${escapeHtml(category.name)}</span>
      <span class="category-count">${this.rowCount(sessions)}</span>
      ${this.categoryTally(sessions)}
      <div class="category-actions">
        <button class="category-rename-btn" title="Rename">${ICON.pen}</button>
        <button class="category-delete-btn" title="Delete">${ICON.x}</button>
      </div>
    `;

    header.querySelector('.category-toggle')?.addEventListener('click', (e) => {
      e.stopPropagation();
      this.host.toggleCategory(category.id, !category.collapsed);
    });
    // The whole header folds the category, except its buttons.
    header.addEventListener('click', (e) => {
      if ((e.target as HTMLElement).closest('button')) return;
      this.host.toggleCategory(category.id, !category.collapsed);
    });
    header.querySelector('.category-rename-btn')?.addEventListener('click', (e) => {
      e.stopPropagation();
      this.host.showCategoryModal('rename', category);
    });
    header.querySelector('.category-delete-btn')?.addEventListener('click', (e) => {
      e.stopPropagation();
      if (confirm(`Delete category "${category.name}"? Sessions will become uncategorized.`)) {
        this.host.deleteCategory(category.id);
      }
    });
    this.setupHeaderDrop(header, category.id);

    section.appendChild(header);

    const sessionList = document.createElement('ul');
    sessionList.className = 'category-sessions';
    this.setupDropZone(sessionList, category.id);
    for (const session of sessions) this.renderSessionGroup(sessionList, session);
    section.appendChild(sessionList);
    container.appendChild(section);
  }

  private renderUncategorizedSection(container: HTMLElement, sessions: SessionInfo[]): void {
    const section = document.createElement('div');
    section.className = 'category-section uncategorized';
    if (sessions.length === 0) section.classList.add('empty');
    section.dataset.categoryId = '';

    const header = document.createElement('div');
    header.className = 'category-header';
    header.innerHTML = `
      <span class="category-name">Uncategorized</span>
      <span class="category-count">${this.rowCount(sessions)}</span>
      ${this.categoryTally(sessions)}
    `;
    this.setupHeaderDrop(header, null);
    section.appendChild(header);

    const sessionList = document.createElement('ul');
    sessionList.className = 'category-sessions';
    this.setupDropZone(sessionList, null);
    for (const session of sessions) this.renderSessionGroup(sessionList, session);
    section.appendChild(sessionList);
    container.appendChild(section);
  }

  /** A category header takes drops too, so an empty or folded category can be filled. */
  private setupHeaderDrop(header: HTMLElement, categoryId: string | null): void {
    header.addEventListener('dragover', (e) => {
      e.preventDefault();
      header.classList.add('drop-target');
    });
    header.addEventListener('dragleave', (e) => {
      if (!header.contains(e.relatedTarget as Node)) header.classList.remove('drop-target');
    });
    header.addEventListener('drop', (e) => {
      e.preventDefault();
      e.stopPropagation();
      header.classList.remove('drop-target');
      if (!this.draggedSessionId) return;
      const session = this.host.sessions.get(this.draggedSessionId);
      if (session && session.categoryId !== categoryId) this.host.moveSession(this.draggedSessionId, categoryId);
    });
  }

  /** Sessions shown in a category: its top-level ones plus the children nested under them. */
  private rowCount(sessions: SessionInfo[]): number {
    return sessions.reduce((n, s) => n + 1 + (this.childrenOf.get(s.id)?.length ?? 0), 0);
  }

  /**
   * A session's row, then — when expanded — its children as tracks: a builder's row carries
   * its peers until that track is expanded too, which lists the peers under it.
   */
  private renderSessionGroup(container: HTMLElement, session: SessionInfo, opts: RowOptions = {}): void {
    const children = this.childrenOf.get(session.id) ?? [];
    this.renderSessionItem(container, session, { ...opts, children });
    if (children.length === 0 || !this.expanded.has(session.id)) return;
    for (const group of trackGroups(children)) {
      if (group.peers.length === 0) {
        this.renderSessionItem(container, group.lead, { child: true });
        continue;
      }
      this.renderSessionItem(container, group.lead, { child: true, track: group });
      if (!this.expanded.has(TRACK_PREFIX + group.lead.id)) continue;
      for (const peer of group.peers) {
        const li = this.renderSessionItem(container, peer, { child: true });
        li.classList.add('session-track-member');
      }
    }
  }

  private glyph(state: RowState, readOnly: boolean, title?: string, peerId?: string): string {
    const label = title ?? (readOnly ? `${STATE_LABEL[state]} · read-only` : STATE_LABEL[state]);
    return `<span class="session-glyph state-${state}${readOnly ? ' ro' : ''}"${peerId ? ` data-peer-id="${escapeAttr(peerId)}" role="button" tabindex="0"` : ''} title="${escapeAttr(label)}"></span>`;
  }

  /** A folded parent's children: one dot per track at its worst state, then the count. */
  private kidsTally(children: SessionInfo[]): string {
    const groups = trackGroups(children).map((g) => worstState([g.lead, ...g.peers].map((s) => this.stateOf(s))));
    groups.sort((a, b) => STATE_RANK[a] - STATE_RANK[b]);
    let waiting = 0;
    let done = 0;
    for (const c of children) {
      const st = this.stateOf(c);
      if (st === 'input') waiting++;
      else if (st === 'done') done++;
    }
    const parts: string[] = [];
    if (waiting > 0) parts.push(`${waiting} need${waiting === 1 ? 's' : ''} input`);
    if (done > 0) parts.push(`${done} done`);
    parts.push(`${children.length} started`);
    const dots = groups
      .slice(0, MAX_TALLY_DOTS)
      .map((st) => `<i class="tally-dot state-${st}"></i>`)
      .join('');
    return `<span class="session-kids" title="${escapeAttr(parts.join(' · '))}" aria-label="${escapeAttr(parts.join(' · '))}">${dots}<span class="session-kids-count">${children.length}</span></span>`;
  }

  private accountDot(session: SessionInfo): string {
    if (!session.account) return '';
    const accounts = new Set([...this.host.sessions.values()].map((s) => s.account).filter(Boolean));
    if (accounts.size < 2) return '';
    const index = this.accountOrder?.indexOf(session.account) ?? -1;
    const colour = index >= 0 ? ` acct-c${index % ACCOUNT_COLOURS}` : '';
    return `<span class="session-account-dot${colour}" title="Runs under the ${escapeAttr(session.account)} Claude account"></span>`;
  }

  /** The selected row's second line: what used to sit on every row. */
  private detailLine(session: SessionInfo, isChild: boolean): string {
    const bits: string[] = [];
    if (session.account) bits.push(`<span>${escapeHtml(session.account)}</span>`);
    const parts = session.cwd.split(/[\\/]+/).filter(Boolean);
    const shortCwd = parts.slice(-2).join('/') || session.cwd;
    bits.push(`<span class="session-detail-cwd" title="${escapeAttr(session.cwd)}">${escapeHtml(shortCwd)}</span>`);
    // Shown unless `auto`, the default: a `manual` child waits for the user.
    // Rows started before `manual` existed are stored as `default`.
    const mode = session.permissionMode === 'default' ? 'manual' : session.permissionMode;
    if (isChild && mode && mode !== 'auto') {
      bits.push(`<span class="session-mode-chip" title="Started in ${escapeAttr(mode)} permission mode">${escapeHtml(mode)}</span>`);
    }
    // A read-only peer beside its track's builder (project/builder-critic-pairs.md).
    if (session.access === 'read') {
      bits.push('<span class="session-access-chip" title="A read-only peer: it cannot edit its track’s worktree">read-only</span>');
    }
    const parent = isChild && session.spawnedBy ? this.host.sessions.get(session.spawnedBy) : undefined;
    if (parent) bits.push(`<span>started by ${escapeHtml(parent.name)}</span>`);
    if (session.status === 'terminated') bits.push('<span>exited</span>');
    else if (!session.attachable) bits.push('<span>stopped</span>');
    if (session.accountWarning) bits.push(`<span class="session-detail-warning">⚠ ${escapeHtml(session.accountWarning)}</span>`);
    return `<div class="session-detail">${bits.join('')}</div>`;
  }

  private renderSessionItem(container: HTMLElement, session: SessionInfo, opts: RowOptions = {}): HTMLElement {
    const isChild = opts.child === true;
    const flat = opts.flat === true;
    const children = flat ? [] : opts.children ?? [];
    const track = opts.track;
    const currentId = this.host.getCurrentSessionId();
    const trackKey = track ? TRACK_PREFIX + track.lead.id : '';
    const trackOpen = track ? this.expanded.has(trackKey) : false;

    const li = document.createElement('li');
    li.className = 'session-item';
    // Children stay in creation order under their parent: dragging one to another
    // category would look like it did nothing while it still shows here. Rows outside
    // the category tree (strip, drawer, matches) have no category to drop into.
    const draggable = !isChild && !flat && opts.noDrag !== true;
    li.draggable = draggable;
    li.dataset.sessionId = session.id;
    if (isChild) li.classList.add('session-child');
    if (children.length > 0) li.classList.add('session-parent');
    if (track) li.classList.add('session-track');
    const isActive = session.id === currentId;
    if (isActive) li.classList.add('active');
    if (track && !trackOpen && track.peers.some((p) => p.id === currentId)) li.classList.add('contains-active');
    if (session.status === 'terminated') li.classList.add('terminated');
    if (!session.attachable) li.classList.add('not-attachable');

    const state = this.stateOf(session);
    li.classList.add(`state-${state}`);

    let lead = '<span class="session-lead"></span>';
    if (children.length > 0) {
      const open = this.expanded.has(session.id);
      lead = `<button class="session-group-toggle${open ? '' : ' collapsed'}" aria-expanded="${open}" title="${open ? 'Hide' : 'Show'} started sessions">${ICON.chevron}</button>`;
    } else if (track) {
      lead = `<button class="session-group-toggle session-track-toggle${trackOpen ? '' : ' collapsed'}" aria-expanded="${trackOpen}" title="${trackOpen ? 'Hide' : 'Show'} this track's read-only peers">${ICON.chevron}</button>`;
    } else if (draggable) {
      lead = `<span class="session-lead session-drag-handle">${ICON.handle}</span>`;
    }

    let glyphs = this.glyph(state, session.access === 'read');
    let trackChip = '';
    if (track && !trackOpen) {
      const peers = track.peers;
      glyphs =
        `<span class="session-glyphs">` +
        this.glyph(state, false, `Builder: ${STATE_LABEL[state]}`) +
        peers
          .slice(0, MAX_PEER_GLYPHS)
          .map((p) => this.glyph(this.stateOf(p), true, `${p.name} (read-only): ${STATE_LABEL[this.stateOf(p)]}`, p.id))
          .join('') +
        (peers.length > MAX_PEER_GLYPHS ? `<span class="session-glyph-more">+${peers.length - MAX_PEER_GLYPHS}</span>` : '') +
        `</span>`;
    }
    if (track) {
      const n = track.peers.length;
      trackChip = `<span class="session-track-chip" title="Builder and ${n} read-only peer${n === 1 ? '' : 's'}">${n === 1 ? 'pair' : `1+${n}`}</span>`;
    }

    const context = opts.context ? `<span class="session-context">${escapeHtml(opts.context)}</span>` : '';
    const chip = opts.chip ? `<span class="session-category-chip">${escapeHtml(opts.chip)}</span>` : '';
    const warning = session.accountWarning
      ? `<span class="session-account-warning" title="${escapeAttr(session.accountWarning)}">⚠</span>`
      : '';
    const tally = children.length > 0 && !this.expanded.has(session.id) ? this.kidsTally(children) : '';

    // Whether a row can be revived (stale ones, and exited ones with a conversation) is the
    // server's call: `revivable` comes from the same rule reviveSession() enforces.
    const escapedId = escapeAttr(session.id);
    const copyHtml = session.claudeName
      ? `<button class="session-copy-btn" data-copy="@${escapeAttr(session.claudeName)}" title="Copy @${escapeAttr(session.claudeName)}: the name other agents message this session by" aria-label="Copy the name agents use for ${escapeAttr(session.name)}">${ICON.at}</button>`
      : '';
    const reviveHtml = session.revivable
      ? `<button class="session-revive-btn" title="${session.claudeSessionId ? 'Resume conversation' : 'Restart shell'}" data-session-id="${escapedId}">${ICON.play}</button>`
      : '';
    const deleteHtml = `<button class="session-delete-btn" title="Delete session" data-session-id="${escapedId}">${ICON.trash}</button>`;

    li.innerHTML = `
      <div class="session-line">
        ${lead}
        ${glyphs}
        <span class="session-name">${escapeHtml(session.name)}</span>
        ${context}${warning}${chip}${trackChip}${tally}
        ${this.accountDot(session)}
        <span class="session-actions">${copyHtml}${reviveHtml}${deleteHtml}</span>
      </div>
      ${isActive ? this.detailLine(session, isChild) : ''}
    `;

    if (draggable) this.attachDragHandlers(li, session);

    li.addEventListener('click', (e) => {
      const target = e.target as HTMLElement;
      if (target.closest('.session-actions')) return;
      if (target.closest('.session-group-toggle')) return;
      const peer = target.closest<HTMLElement>('[data-peer-id]');
      const opened = peer ? this.host.sessions.get(peer.dataset.peerId ?? '') : session;
      if (opened) this.open(opened);
    });
    li.querySelector('[data-peer-id]')?.closest<HTMLElement>('.session-glyphs')?.addEventListener('keydown', (e: KeyboardEvent) => {
      const peer = (e.target as HTMLElement).closest<HTMLElement>('[data-peer-id]');
      if (!peer || (e.key !== 'Enter' && e.key !== ' ')) return;
      e.preventDefault();
      e.stopPropagation();
      const s = this.host.sessions.get(peer.dataset.peerId ?? '');
      if (s) this.open(s);
    });

    // Fold arrow: its own target, so tapping it never opens the row and tapping the row
    // never folds it.
    li.querySelector('.session-group-toggle')?.addEventListener('click', (e) => {
      e.stopPropagation();
      e.preventDefault();
      this.toggleExpanded(track ? trackKey : session.id);
    });
    li.querySelector('.session-copy-btn')?.addEventListener('click', (e) => {
      e.stopPropagation();
      const btn = e.currentTarget as HTMLElement;
      void this.copyAddress(btn, li, btn.dataset.copy ?? '');
    });
    li.querySelector('.session-revive-btn')?.addEventListener('click', (e) => {
      e.stopPropagation();
      this.host.reviveSession(session.id);
    });
    li.querySelector('.session-delete-btn')?.addEventListener('click', (e) => {
      e.stopPropagation();
      this.host.deleteSession(session.id);
    });

    container.appendChild(li);
    return li;
  }

  /** Open a session; a started one also unfolds its parent (and track) so it shows in the tree. */
  private open(session: SessionInfo): void {
    if (!session.attachable) return;
    if (this.nested.has(session.id) && session.spawnedBy) {
      const before = this.expanded.size;
      this.expanded.add(session.spawnedBy);
      if (session.access === 'read') {
        const siblings = this.childrenOf.get(session.spawnedBy) ?? [];
        const group = trackGroups(siblings).find((g) => g.peers.some((p) => p.id === session.id));
        if (group) this.expanded.add(TRACK_PREFIX + group.lead.id);
      }
      if (this.expanded.size !== before) this.saveExpanded();
    }
    this.host.attachToSession(session.id);
    document.getElementById('sidebar')?.classList.remove('open');
    document.getElementById('sidebar-overlay')?.classList.remove('open');
    document.getElementById('mobile-menu-btn')?.classList.remove('hidden');
  }

  /**
   * Copy a session's `@name`. The id is not printed on the row, so the feedback names it:
   * the icon turns into a check, the row's edge goes green, and a toast says what was
   * copied. A copy that failed says so and selects the text instead, never "Copied".
   */
  private async copyAddress(btn: HTMLElement, li: HTMLElement, text: string): Promise<void> {
    if (!text) return;
    const ok = await copyText(text);
    this.showToast(text, ok);
    if (!ok) return;
    btn.innerHTML = ICON.check;
    btn.classList.add('copied');
    li.classList.add('just-copied');
    setTimeout(() => {
      btn.innerHTML = ICON.at;
      btn.classList.remove('copied');
      li.classList.remove('just-copied');
    }, COPY_FEEDBACK_MS);
  }

  private showToast(text: string, ok: boolean): void {
    const toast = document.getElementById('session-toast');
    if (!toast) return;
    toast.classList.toggle('failed', !ok);
    toast.innerHTML = ok
      ? `${ICON.check}<span>Copied</span><span class="session-toast-text">${escapeHtml(text)}</span>`
      : `<span>Couldn't copy. Select it:</span><input class="session-toast-input" readonly value="${escapeAttr(text)}" aria-label="Session address">`;
    toast.hidden = false;
    // Restart the transition when a second copy lands while the toast is still up.
    toast.classList.remove('show');
    void toast.offsetWidth;
    toast.classList.add('show');
    if (!ok) (toast.querySelector('input') as HTMLInputElement | null)?.select();
    if (this.toastTimer) clearTimeout(this.toastTimer);
    this.toastTimer = setTimeout(
      () => {
        toast.classList.remove('show');
        toast.hidden = true;
      },
      ok ? COPY_FEEDBACK_MS : COPY_FEEDBACK_MS * 3
    );
  }

  private attachDragHandlers(li: HTMLElement, session: SessionInfo): void {
    // Drag handling
    li.addEventListener('dragstart', (e) => {
      this.draggedSessionId = session.id;
      li.classList.add('dragging');
      e.dataTransfer?.setData('text/plain', session.id);
    });

    li.addEventListener('dragend', () => {
      this.draggedSessionId = null;
      li.classList.remove('dragging');
      if (this.dropIndicatorEl) {
        this.dropIndicatorEl.classList.remove('drop-before', 'drop-after');
        this.dropIndicatorEl = null;
      }
      document.querySelectorAll('.drop-target').forEach(el => el.classList.remove('drop-target'));
    });

    // Allow drops on session items for reordering within same category or moving between categories
    li.addEventListener('dragover', (e) => {
      e.preventDefault();
      if (!this.draggedSessionId || this.draggedSessionId === session.id) return;

      const draggedSession = this.host.sessions.get(this.draggedSessionId);
      if (!draggedSession) return;

      const categorySection = li.closest('.category-section') as HTMLElement | null;
      const categoryIdAttr = categorySection?.dataset.categoryId;
      const targetCategoryId = categoryIdAttr === '' ? null : categoryIdAttr ?? null;

      // Same category: show insertion indicator
      if (draggedSession.categoryId === targetCategoryId) {
        // Clear previous indicator if it's a different element
        if (this.dropIndicatorEl && this.dropIndicatorEl !== li) {
          this.dropIndicatorEl.classList.remove('drop-before', 'drop-after');
        }
        this.dropIndicatorEl = li;

        const rect = li.getBoundingClientRect();
        const midY = rect.top + rect.height / 2;
        li.classList.remove('drop-before', 'drop-after');
        if (e.clientY < midY) {
          li.classList.add('drop-before');
        } else {
          li.classList.add('drop-after');
        }
      } else {
        // Different category: highlight the target category's session list
        const sessionList = categorySection?.querySelector('.category-sessions');
        sessionList?.classList.add('drop-target');
      }
    });

    li.addEventListener('dragleave', () => {
      li.classList.remove('drop-before', 'drop-after');
    });

    li.addEventListener('drop', (e) => {
      e.preventDefault();
      e.stopPropagation();

      const categorySection = li.closest('.category-section') as HTMLElement | null;
      const categoryIdAttr = categorySection?.dataset.categoryId;
      const targetCategoryId = categoryIdAttr === '' ? null : categoryIdAttr ?? null;

      if (this.draggedSessionId) {
        const draggedSession = this.host.sessions.get(this.draggedSessionId);
        if (!draggedSession) return;

        if (draggedSession.categoryId === targetCategoryId) {
          // Same category: reorder
          const rect = li.getBoundingClientRect();
          const midY = rect.top + rect.height / 2;
          const insertBefore = e.clientY < midY;
          this.reorderSessionInCategory(this.draggedSessionId, session.id, targetCategoryId, insertBefore);
        } else {
          // Different category: move
          this.host.moveSession(this.draggedSessionId, targetCategoryId);
        }
      }

      if (this.dropIndicatorEl) {
        this.dropIndicatorEl.classList.remove('drop-before', 'drop-after');
        this.dropIndicatorEl = null;
      }
      document.querySelectorAll('.drop-target').forEach(el => el.classList.remove('drop-target'));
    });
  }

  private setupDropZone(element: HTMLElement, categoryId: string | null): void {
    element.addEventListener('dragover', (e) => {
      e.preventDefault();
      element.classList.add('drop-target');
    });

    element.addEventListener('dragleave', (e) => {
      if (!element.contains(e.relatedTarget as Node)) {
        element.classList.remove('drop-target');
      }
    });

    element.addEventListener('drop', (e) => {
      e.preventDefault();
      element.classList.remove('drop-target');

      if (this.draggedSessionId) {
        const session = this.host.sessions.get(this.draggedSessionId);
        if (session && session.categoryId !== categoryId) {
          this.host.moveSession(this.draggedSessionId, categoryId);
        }
      }
    });
  }

  private reorderSessionInCategory(draggedId: string, targetId: string, categoryId: string | null, insertBefore: boolean): void {
    // Get all sessions in this category, sorted by current sortOrder. Nested children
    // render under their parent wherever their own categoryId points, so they take no
    // part in reordering a category's rows.
    const sessionsInCategory = Array.from(this.host.sessions.values())
      .filter(s => s.categoryId === categoryId && !this.nested.has(s.id))
      .sort((a, b) => a.sortOrder - b.sortOrder);

    // Remove dragged session from the list
    const filtered = sessionsInCategory.filter(s => s.id !== draggedId);

    // Find insertion index
    const targetIndex = filtered.findIndex(s => s.id === targetId);
    if (targetIndex === -1) return;

    const insertIndex = insertBefore ? targetIndex : targetIndex + 1;

    // Insert at new position
    const draggedSession = this.host.sessions.get(draggedId);
    if (!draggedSession) return;
    filtered.splice(insertIndex, 0, draggedSession);

    // Assign new sort orders
    const updates: { id: string; sortOrder: number }[] = filtered.map((s, i) => ({
      id: s.id,
      sortOrder: i,
    }));

    // Optimistically update local state
    for (const u of updates) {
      const session = this.host.sessions.get(u.id);
      if (session) session.sortOrder = u.sortOrder;
    }
    this.render();

    // Send to server
    this.host.reorderSessions(updates);
  }
}
