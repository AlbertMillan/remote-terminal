import { html, joinHtml, raw, setHtml, type SafeHtml } from './html-utils.js';
import type { SessionInfo, CategoryInfo } from './session-types.js';
import { SessionDrag } from './session-list-drag.js';
import {
  STATE_LABEL,
  STATE_RANK,
  groupStartedSessions,
  matchesFilter,
  needsYou,
  rowState,
  trackGroups,
  worstState,
  type RowState,
  type TrackGroup,
} from './session-list-model.js';

// The model's helpers stay importable from the view, which its tests and callers know.
export { groupStartedSessions, matchesFilter, needsYou, peersAfterBuilders, rowState, trackGroups, worstState } from './session-list-model.js';
export type { RowState, TrackGroup } from './session-list-model.js';

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
  stopSession(sessionId: string): void;
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
  // The fallback has to focus a textarea to select it; give focus back afterwards, or the
  // terminal stops taking keystrokes (this is the normal path over plain HTTP).
  const previous = document.activeElement as HTMLElement | null;
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
    previous?.focus?.();
    return ok;
  } catch {
    previous?.focus?.();
    return false;
  }
}

/** Alt+K, the sidebar filter shortcut; `terminal.ts` and the document handler share it. */
export function isFilterShortcut(e: KeyboardEvent): boolean {
  return e.altKey && !e.ctrlKey && !e.shiftKey && !e.metaKey && (e.key === 'k' || e.key === 'K');
}

/**
 * Show the sidebar as the phone overlay. The menu button hides while it is open, as the
 * button's own handler does: left visible, its next tap would close the sidebar and hide
 * itself, leaving nothing to reopen it.
 */
export function openMobileSidebar(): void {
  document.getElementById('sidebar')?.classList.add('open');
  document.getElementById('sidebar-overlay')?.classList.add('open');
  document.getElementById('mobile-menu-btn')?.classList.add('hidden');
}

export function closeMobileSidebar(): void {
  document.getElementById('sidebar')?.classList.remove('open');
  document.getElementById('sidebar-overlay')?.classList.remove('open');
  document.getElementById('mobile-menu-btn')?.classList.remove('hidden');
}

/**
 * Where keyboard focus sits in the list: a row (by session and section) and maybe one of
 * its controls, or a section header's button. Found again by comparing data attributes,
 * so no id is ever spliced into a selector.
 */
type FocusKey =
  | { kind: 'row'; sessionId: string; section: string; control: string | null; peerId: string | null }
  | { kind: 'category'; categoryId: string; control: string }
  | { kind: 'stopped' };

const ROW_CONTROLS = ['session-copy-btn', 'session-stop-btn', 'session-revive-btn', 'session-delete-btn', 'session-group-toggle'];
const HEADER_CONTROLS = ['category-toggle', 'category-rename-btn', 'category-delete-btn'];
const SECTION_SELECTOR = '.attention-section, .stopped-section, .matches-section';

function sectionOf(el: HTMLElement): string {
  const s = el.closest(SECTION_SELECTOR);
  if (!s) return 'tree';
  return s.classList.contains('attention-section') ? 'attention' : s.classList.contains('stopped-section') ? 'stopped' : 'matches';
}

function focusKey(listEl: HTMLElement): FocusKey | null {
  const active = document.activeElement as HTMLElement | null;
  if (!active || !listEl.contains(active)) return null;
  if (active.classList.contains('stopped-header')) return { kind: 'stopped' };
  if (active.closest('.category-header')) {
    const categoryId = active.closest<HTMLElement>('.category-section')?.dataset.categoryId;
    const control = HEADER_CONTROLS.find((c) => active.classList.contains(c));
    return categoryId && control ? { kind: 'category', categoryId, control } : null;
  }
  const li = active.closest<HTMLElement>('.session-item');
  if (!li?.dataset.sessionId) return null;
  const control = active === li ? null : (ROW_CONTROLS.find((c) => active.classList.contains(c)) ?? null);
  return { kind: 'row', sessionId: li.dataset.sessionId, section: sectionOf(li), control, peerId: active.dataset.peerId ?? null };
}

function restoreFocus(listEl: HTMLElement, key: FocusKey): void {
  let target: HTMLElement | null | undefined = null;
  if (key.kind === 'stopped') {
    target = listEl.querySelector<HTMLElement>('.stopped-header');
  } else if (key.kind === 'category') {
    const section = [...listEl.querySelectorAll<HTMLElement>('.category-section')].find((el) => el.dataset.categoryId === key.categoryId);
    target = section?.querySelector<HTMLElement>(`.category-header .${key.control}`);
  } else {
    const rows = [...listEl.querySelectorAll<HTMLElement>('.session-item')].filter((li) => li.dataset.sessionId === key.sessionId);
    const li = rows.find((r) => sectionOf(r) === key.section) ?? rows[0];
    if (!li) return;
    target =
      (key.peerId ? [...li.querySelectorAll<HTMLElement>('[data-peer-id]')].find((el) => el.dataset.peerId === key.peerId) : null) ||
      (key.control ? li.querySelector<HTMLElement>(`.${key.control}`) : null) ||
      li;
  }
  target?.focus({ preventScroll: true });
}

const ICON = {
  chevron: raw(
    '<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"></polyline></svg>'
  ),
  handle: raw(
    '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="9" cy="5" r="1"/><circle cx="9" cy="12" r="1"/><circle cx="9" cy="19" r="1"/><circle cx="15" cy="5" r="1"/><circle cx="15" cy="12" r="1"/><circle cx="15" cy="19" r="1"/></svg>'
  ),
  at: raw(
    '<svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="4"></circle><path d="M16 8v5a3 3 0 0 0 6 0v-1a10 10 0 1 0-4 8"></path></svg>'
  ),
  check: raw(
    '<svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="4 12 10 18 20 6"></polyline></svg>'
  ),
  stop: raw(
    '<svg xmlns="http://www.w3.org/2000/svg" width="11" height="11" viewBox="0 0 24 24" fill="currentColor"><rect x="5" y="5" width="14" height="14" rx="2"></rect></svg>'
  ),
  play: raw(
    '<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="5 3 19 12 5 21 5 3"></polygon></svg>'
  ),
  trash: raw(
    '<svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg>'
  ),
  pen: raw(
    '<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/></svg>'
  ),
  x: raw(
    '<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>'
  ),
};

interface RowOptions {
  /** Nested under a parent (or a track): indented, never dragged. */
  child?: boolean;
  /** The sessions it started; a folded parent shows them as a tally. */
  children?: SessionInfo[];
  /** `children` as tracks, computed once by the caller. */
  groups?: TrackGroup[];
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
  /** Row drag-and-drop (session-list-drag.ts). */
  private readonly drag: SessionDrag;
  private childrenOf = new Map<string, SessionInfo[]>();
  private nested = new Set<string>();
  private expanded = loadExpanded();
  private stoppedOpen = readFlag(STOPPED_OPEN_KEY);
  private filter = '';
  private wired = false;
  /** Account names in config order (GET /api/accounts), for the dot colours; null until loaded. */
  private accountOrder: string[] | null = null;
  private toastTimer: ReturnType<typeof setTimeout> | null = null;
  /** Sessions span 2+ accounts, so rows show account dots; computed once per render. */
  private multiAccount = false;
  /**
   * The row whose `@name` was just copied. Kept here, not only on its DOM node, because
   * any render in the next moments (a notification, a name broadcast) rebuilds every row.
   */
  private copied: { id: string; until: number } | null = null;
  private copiedTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly host: SessionListViewHost) {
    this.drag = new SessionDrag({
      sessions: host.sessions,
      moveSession: (sessionId, categoryId) => host.moveSession(sessionId, categoryId),
      reorder: (draggedId, targetId, categoryId, before) => this.reorderSessionInCategory(draggedId, targetId, categoryId, before),
    });
  }

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
    void this.refreshAccountOrder();
  }

  /** Account order for the dot colours: at first render and on every reconnect (accounts may change). */
  async refreshAccountOrder(): Promise<void> {
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

  /**
   * Openable sessions in the order the tree shows them, for Ctrl+Q / Ctrl+E: unfolded
   * children and peers included; folded ones, folded categories, the "Needs you" strip
   * (duplicates) and the Stopped drawer left out. With a filter, the matches.
   */
  visibleOrder(): string[] {
    const listEl = document.getElementById('session-list');
    if (!listEl) return [];
    const ids: string[] = [];
    for (const li of listEl.querySelectorAll<HTMLElement>('.session-item:not(.not-attachable)')) {
      if (li.closest('.attention-section, .stopped-section, .category-section.collapsed')) continue;
      const id = li.dataset.sessionId;
      if (id && !ids.includes(id)) ids.push(id);
    }
    return ids;
  }

  private stateOf(session: SessionInfo): RowState {
    return rowState(session, this.host.sessionNotifications.get(session.id));
  }

  render(): void {
    const listEl = document.getElementById('session-list');
    if (!listEl) return;
    this.wireOnce();

    // Rows are focusable (Tab reaches them and their actions), but render() replaces every
    // row; without this a notification arriving mid-Tab would drop focus to the page.
    const refocus = focusKey(listEl);
    try {
      this.renderInto(listEl);
    } finally {
      if (refocus) restoreFocus(listEl, refocus);
    }
  }

  private renderInto(listEl: HTMLElement): void {
    listEl.innerHTML = '';

    // Started sessions are rendered by their parent's row, so only top-level ones
    // take part in the category grouping below.
    const { childrenOf, nested } = groupStartedSessions(this.host.sessions);
    this.childrenOf = childrenOf;
    this.nested = nested;
    this.multiAccount = new Set([...this.host.sessions.values()].map((s) => s.account).filter(Boolean)).size > 1;
    if (this.copied && this.copied.until <= Date.now()) this.copied = null;

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
    setHtml(section, html`<div class="category-header attention-header"><span class="category-name">Needs you</span><span class="category-count">${waiting.length}</span></div>`);
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
    setHtml(header, html`<span class="category-toggle">${ICON.chevron}</span><span class="category-name">Stopped</span><span class="category-count">${this.rowCount(stopped)}</span>`);
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
    setHtml(section, html`<div class="category-header"><span class="category-name">Matches</span><span class="category-count">${hits.length}</span></div>`);
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
  private categoryTally(sessions: SessionInfo[]): SafeHtml {
    let waiting = 0;
    let done = 0;
    for (const s of sessions) {
      for (const member of [s, ...(this.childrenOf.get(s.id) ?? [])]) {
        const state = this.stateOf(member);
        if (state === 'input') waiting++;
        else if (state === 'done') done++;
      }
    }
    const parts: SafeHtml[] = [];
    if (waiting > 0) parts.push(html`<span class="tally-input">${waiting} waiting</span>`);
    if (done > 0) parts.push(html`<span class="tally-done">${done} done</span>`);
    return parts.length ? html`<span class="category-tally">${joinHtml(parts, ' · ')}</span>` : html``;
  }

  private renderCategory(container: HTMLElement, category: CategoryInfo, sessions: SessionInfo[]): void {
    const section = document.createElement('div');
    section.className = 'category-section';
    if (category.collapsed) section.classList.add('collapsed');
    if (sessions.length === 0) section.classList.add('empty');
    section.dataset.categoryId = category.id;

    const header = document.createElement('div');
    header.className = 'category-header';
    setHtml(
      header,
      html`
      <button class="category-toggle" title="${category.collapsed ? 'Expand' : 'Collapse'}" aria-expanded="${category.collapsed ? 'false' : 'true'}">${ICON.chevron}</button>
      <span class="category-name">${category.name}</span>
      <span class="category-count">${this.rowCount(sessions)}</span>
      ${this.categoryTally(sessions)}
      <div class="category-actions">
        <button class="category-rename-btn" title="Rename">${ICON.pen}</button>
        <button class="category-delete-btn" title="Delete">${ICON.x}</button>
      </div>
    `
    );

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
    this.drag.attachHeader(header, category.id);

    section.appendChild(header);

    const sessionList = document.createElement('ul');
    sessionList.className = 'category-sessions';
    this.drag.attachDropZone(sessionList, category.id);
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
    setHtml(
      header,
      html`
      <span class="category-name">Uncategorized</span>
      <span class="category-count">${this.rowCount(sessions)}</span>
      ${this.categoryTally(sessions)}
    `
    );
    this.drag.attachHeader(header, null);
    section.appendChild(header);

    const sessionList = document.createElement('ul');
    sessionList.className = 'category-sessions';
    this.drag.attachDropZone(sessionList, null);
    for (const session of sessions) this.renderSessionGroup(sessionList, session);
    section.appendChild(sessionList);
    container.appendChild(section);
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
    const groups = children.length > 0 ? trackGroups(children) : [];
    this.renderSessionItem(container, session, { ...opts, children, groups });
    if (children.length === 0 || !this.expanded.has(session.id)) return;
    for (const group of groups) {
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

  private glyph(state: RowState, readOnly: boolean, title?: string, peerId?: string): SafeHtml {
    const label = title ?? (readOnly ? `${STATE_LABEL[state]} · read-only` : STATE_LABEL[state]);
    return html`<span class="session-glyph state-${state}${readOnly ? ' ro' : ''}"${peerId && html` data-peer-id="${peerId}" role="button" tabindex="0"`} title="${label}"></span>`;
  }

  /** A folded parent's children: one dot per track at its worst state, then the count. */
  private kidsTally(children: SessionInfo[], tracks: TrackGroup[]): SafeHtml {
    const groups = tracks.map((g) => worstState([g.lead, ...g.peers].map((s) => this.stateOf(s))));
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
    const dots = groups.slice(0, MAX_TALLY_DOTS).map((st) => html`<i class="tally-dot state-${st}"></i>`);
    return html`<span class="session-kids" title="${parts.join(' · ')}" aria-label="${parts.join(' · ')}">${dots}<span class="session-kids-count">${children.length}</span></span>`;
  }

  private accountDot(session: SessionInfo): SafeHtml {
    if (!session.account || !this.multiAccount) return html``;
    const index = this.accountOrder?.indexOf(session.account) ?? -1;
    const colour = index >= 0 ? ` acct-c${index % ACCOUNT_COLOURS}` : '';
    return html`<span class="session-account-dot${colour}" title="Runs under the ${session.account} Claude account"></span>`;
  }

  /** The selected row's second line: what used to sit on every row. */
  private detailLine(session: SessionInfo, isChild: boolean): SafeHtml {
    const bits: SafeHtml[] = [];
    if (session.account) bits.push(html`<span>${session.account}</span>`);
    const parts = session.cwd.split(/[\\/]+/).filter(Boolean);
    const shortCwd = parts.slice(-2).join('/') || session.cwd;
    bits.push(html`<span class="session-detail-cwd" title="${session.cwd}">${shortCwd}</span>`);
    // Shown unless `auto`, the default: a `manual` child waits for the user.
    // Rows started before `manual` existed are stored as `default`.
    const mode = session.permissionMode === 'default' ? 'manual' : session.permissionMode;
    if (isChild && mode && mode !== 'auto') {
      bits.push(html`<span class="session-mode-chip" title="Started in ${mode} permission mode">${mode}</span>`);
    }
    // A read-only peer beside its track's builder (project/builder-critic-pairs.md).
    if (session.access === 'read') {
      bits.push(html`<span class="session-access-chip" title="A read-only peer: it cannot edit its track’s worktree">read-only</span>`);
    }
    const parent = isChild && session.spawnedBy ? this.host.sessions.get(session.spawnedBy) : undefined;
    if (parent) bits.push(html`<span>started by ${parent.name}</span>`);
    if (session.status === 'terminated') bits.push(html`<span>exited</span>`);
    else if (!session.attachable) bits.push(html`<span>stopped</span>`);
    if (session.accountWarning) bits.push(html`<span class="session-detail-warning">⚠ ${session.accountWarning}</span>`);
    return html`<div class="session-detail">${bits}</div>`;
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
    // A Tab stop: focusing a row shows its actions, which come next in Tab order; Enter opens.
    li.tabIndex = 0;
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

    let lead = html`<span class="session-lead"></span>`;
    if (children.length > 0) {
      const open = this.expanded.has(session.id);
      lead = html`<button class="session-group-toggle${open ? '' : ' collapsed'}" aria-expanded="${String(open)}" title="${open ? 'Hide' : 'Show'} started sessions">${ICON.chevron}</button>`;
    } else if (track) {
      lead = html`<button class="session-group-toggle session-track-toggle${trackOpen ? '' : ' collapsed'}" aria-expanded="${String(trackOpen)}" title="${trackOpen ? 'Hide' : 'Show'} this track's read-only peers">${ICON.chevron}</button>`;
    } else if (draggable) {
      lead = html`<span class="session-lead session-drag-handle">${ICON.handle}</span>`;
    }

    let glyphs = this.glyph(state, session.access === 'read');
    let trackChip = html``;
    if (track && !trackOpen) {
      const peers = track.peers;
      const peerGlyphs = peers
        .slice(0, MAX_PEER_GLYPHS)
        .map((p) => this.glyph(this.stateOf(p), true, `${p.name} (read-only): ${STATE_LABEL[this.stateOf(p)]}`, p.id));
      glyphs = html`<span class="session-glyphs">${this.glyph(state, false, `Builder: ${STATE_LABEL[state]}`)}${peerGlyphs}${peers.length > MAX_PEER_GLYPHS && html`<span class="session-glyph-more">+${peers.length - MAX_PEER_GLYPHS}</span>`}</span>`;
    }
    if (track) {
      const n = track.peers.length;
      trackChip = html`<span class="session-track-chip" title="Builder and ${n} read-only peer${n === 1 ? '' : 's'}">${n === 1 ? 'pair' : `1+${n}`}</span>`;
    }

    const context = opts.context ? html`<span class="session-context">${opts.context}</span>` : html``;
    const chip = opts.chip ? html`<span class="session-category-chip">${opts.chip}</span>` : html``;
    const warning = session.accountWarning
      ? html`<span class="session-account-warning" title="${session.accountWarning}">⚠</span>`
      : html``;
    const tally =
      children.length > 0 && !this.expanded.has(session.id)
        ? this.kidsTally(children, opts.groups ?? trackGroups(children))
        : html``;
    // Copy feedback comes from state, so a render inside its 1.6 s keeps it.
    const justCopied = this.copied?.id === session.id;
    if (justCopied) li.classList.add('just-copied');

    // Whether a row can be revived (stale ones, and exited ones with a conversation) is the
    // server's call: `revivable` comes from the same rule reviveSession() enforces.
    const copyHtml = session.claudeName
      ? html`<button class="session-copy-btn${justCopied ? ' copied' : ''}" data-copy="@${session.claudeName}" title="Copy @${session.claudeName}: the name other agents message this session by" aria-label="Copy the name agents use for ${session.name}">${justCopied ? ICON.check : ICON.at}</button>`
      : html``;
    const reviveHtml = session.revivable
      ? html`<button class="session-revive-btn" title="${session.claudeSessionId ? 'Resume conversation' : 'Restart shell'}" data-session-id="${session.id}">${ICON.play}</button>`
      : html``;
    // Stop parks a live session to resume later, in the slot Play takes once it is stopped.
    // Not for a fork (it could not come back) or a shell that already exited.
    // project/stop-sessions.md
    const stoppable = session.attachable && session.status !== 'terminated' && !session.isFork;
    const started = (this.childrenOf.get(session.id) ?? []).filter(
      (c) => c.attachable && c.status !== 'terminated' && !c.isFork
    ).length;
    const stopTitle =
      started > 0 ? `Stop session and its ${started} started session${started === 1 ? '' : 's'}` : 'Stop session (resume later)';
    const stopHtml = stoppable
      ? html`<button class="session-stop-btn" title="${stopTitle}" aria-label="${`${stopTitle}: ${session.name}`}" data-session-id="${session.id}">${ICON.stop}</button>`
      : html``;
    const deleteHtml = html`<button class="session-delete-btn" title="Delete session" data-session-id="${session.id}">${ICON.trash}</button>`;

    setHtml(
      li,
      html`
      <div class="session-line">
        ${lead}
        ${glyphs}
        <span class="session-name">${session.name}</span>
        ${context}${warning}${chip}${trackChip}${tally}
        ${this.accountDot(session)}
        <span class="session-actions">${copyHtml}${stopHtml}${reviveHtml}${deleteHtml}</span>
      </div>
      ${isActive && this.detailLine(session, isChild)}
    `
    );

    if (draggable) this.drag.attachRow(li, session);

    li.addEventListener('keydown', (e) => {
      if (e.target !== li || e.key !== 'Enter') return;
      e.preventDefault();
      this.open(session);
    });

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
      void this.copyAddress(session.id, btn.dataset.copy ?? '');
    });
    li.querySelector('.session-stop-btn')?.addEventListener('click', (e) => {
      e.stopPropagation();
      this.host.stopSession(session.id);
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
    closeMobileSidebar();
  }

  /**
   * Copy a session's `@name`. The id is not printed on the row, so the feedback names it:
   * the icon turns into a check, the row's edge goes green, and a toast says what was
   * copied. A copy that failed says so and selects the text instead, never "Copied".
   */
  private async copyAddress(sessionId: string, text: string): Promise<void> {
    if (!text) return;
    const ok = await copyText(text);
    this.showToast(text, ok);
    if (!ok) return;
    this.copied = { id: sessionId, until: Date.now() + COPY_FEEDBACK_MS };
    this.render();
    if (this.copiedTimer) clearTimeout(this.copiedTimer);
    this.copiedTimer = setTimeout(() => {
      this.copied = null;
      this.render();
    }, COPY_FEEDBACK_MS);
  }

  private showToast(text: string, ok: boolean): void {
    const toast = document.getElementById('session-toast');
    if (!toast) return;
    toast.classList.toggle('failed', !ok);
    setHtml(
      toast,
      ok
        ? html`${ICON.check}<span>Copied</span><span class="session-toast-text">${text}</span>`
        : html`<span>Couldn't copy. Select it:</span><input class="session-toast-input" readonly value="${text}" aria-label="Session address">`
    );
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
