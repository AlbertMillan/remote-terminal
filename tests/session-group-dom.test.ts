// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  SessionListView,
  peersAfterBuilders,
  trackGroups,
  needsYou,
  matchesFilter,
  rowState,
  KEEP_STOPPED_IN_PLACE_KEY,
  isFilterShortcut,
  openMobileSidebar,
  closeMobileSidebar,
  type SessionListViewHost,
} from '../src/client/session-list-view.js';
import type { SessionInfo, CategoryInfo } from '../src/client/session-types.js';

/**
 * The sidebar session list (project/sidebar-redesign.md): one-line rows, sessions a main
 * session started folded under it (docs/session-orchestration.md), a builder and its
 * read-only peers as one track row, a "Needs you" strip, a "Stopped" drawer, a filter,
 * and `@` copy of a session's agent address.
 */

function info(id: string, overrides: Partial<SessionInfo> = {}): SessionInfo {
  return {
    id,
    name: id,
    shell: 'pwsh',
    cwd: 'C:\\p',
    createdAt: '2026-10-01T10:00:00.000Z',
    lastAccessedAt: '2026-10-01T10:00:00.000Z',
    status: 'active',
    cols: 80,
    rows: 24,
    attachable: true,
    categoryId: null,
    sortOrder: 0,
    isFork: false,
    claudeSessionId: null,
    spawnedBy: null,
    permissionMode: null,
    ...overrides,
  };
}

let host: SessionListViewHost;
let sessions: Map<string, SessionInfo>;
let categories: Map<string, CategoryInfo>;
let notifications: SessionListViewHost['sessionNotifications'];
let currentId: string | null;

const EXPANDED_KEY = 'claude-remote.expandedSessionGroups';

function view(): SessionListView {
  const v = new SessionListView(host);
  v.render();
  return v;
}

function rowIds(scope: ParentNode = document): string[] {
  return [...scope.querySelectorAll<HTMLElement>('.session-item')].map((li) => li.dataset.sessionId as string);
}

/** A row in the category tree (not the strip, drawer or matches). */
function rowOf(id: string): HTMLElement {
  const rows = [...document.querySelectorAll<HTMLElement>(`.session-item[data-session-id="${id}"]`)];
  return (rows.find((r) => !r.closest('.attention-section, .stopped-section, .matches-section')) ?? rows[0]) as HTMLElement;
}

function section(id: string): HTMLElement {
  return document.querySelector(`.category-section[data-category-id="${id}"]`) as HTMLElement;
}

function toggle(id: string): void {
  (rowOf(id).querySelector('.session-group-toggle') as HTMLElement).click();
}

function waiting(id: string, timestamp = '2026-10-01T11:00:00.000Z'): void {
  notifications.set(id, { type: 'needs-input', timestamp });
}

beforeEach(() => {
  localStorage.clear();
  document.body.innerHTML =
    '<input id="session-filter"><ul id="session-list"></ul><div id="session-toast" hidden></div>';
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));
  sessions = new Map();
  categories = new Map([['cat', { id: 'cat', name: 'Work', sortOrder: 0, collapsed: false }]]);
  notifications = new Map();
  currentId = null;
  host = {
    sessions,
    categories,
    sessionNotifications: notifications,
    getCurrentSessionId: () => currentId,
    attachToSession: vi.fn(),
    reviveSession: vi.fn(),
    deleteSession: vi.fn(),
    moveSession: vi.fn(),
    toggleCategory: vi.fn(),
    deleteCategory: vi.fn(),
    showCategoryModal: vi.fn(),
    reorderSessions: vi.fn(),
  };
  sessions.set('main', info('main', { categoryId: 'cat', sortOrder: 1 }));
  sessions.set('other', info('other', { sortOrder: 0 }));
  // Children uncategorized, out of creation order in sortOrder: they still render
  // under their parent, in its category, oldest first.
  sessions.set('b', info('b', { spawnedBy: 'main', createdAt: '2026-10-01T10:02:00.000Z', sortOrder: 0 }));
  sessions.set('a', info('a', { spawnedBy: 'main', createdAt: '2026-10-01T10:01:00.000Z', sortOrder: 5, permissionMode: 'acceptEdits' }));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('nesting', () => {
  it('folds started sessions under their parent by default, with a tally', () => {
    view();
    expect(rowIds()).toEqual(['main', 'other']);
    expect(rowOf('main').querySelector('.session-kids-count')?.textContent).toBe('2');
    expect(rowOf('main').querySelectorAll('.tally-dot')).toHaveLength(2);
  });

  it("unfolds children right under their parent, in the parent's category, in creation order", () => {
    view();
    toggle('main');
    expect(rowIds()).toEqual(['main', 'a', 'b', 'other']);
    expect(rowIds(section('cat'))).toEqual(['main', 'a', 'b']);
    expect(rowOf('a').classList.contains('session-child')).toBe(true);
    expect(rowOf('main').classList.contains('session-parent')).toBe(true);
    // Unfolded, the parent drops its tally: the rows say it.
    expect(rowOf('main').querySelector('.session-kids')).toBeNull();
  });

  it('children are not draggable and have no drag handle', () => {
    view();
    toggle('main');
    expect(rowOf('a').draggable).toBe(false);
    expect(rowOf('a').querySelector('.session-drag-handle')).toBeNull();
    expect(rowOf('main').draggable).toBe(true);
    expect(rowOf('other').querySelector('.session-drag-handle')).not.toBeNull();
  });

  it('renders a child whose parent was deleted as top-level, in its own category', () => {
    sessions.delete('main');
    view();
    expect(rowIds().sort()).toEqual(['a', 'b', 'other']);
    expect(rowOf('a').classList.contains('session-child')).toBe(false);
  });

  it('keeps a stopped parent in place while its started sessions still run', () => {
    sessions.set('main', info('main', { categoryId: 'cat', status: 'terminated', attachable: false }));
    view();
    expect(rowIds(section('cat'))).toEqual(['main']);
    expect(document.querySelector('.stopped-section')).toBeNull();
  });
});

describe('row state and the detail line', () => {
  it('maps notifications and liveness to one glyph state; a stopped row is stopped', () => {
    const live = info('x');
    expect(rowState(live, undefined)).toBe('live');
    expect(rowState(live, { type: 'needs-input', timestamp: '' })).toBe('input');
    expect(rowState(live, { type: 'completed', timestamp: '' })).toBe('done');
    expect(rowState(info('y', { attachable: false }), { type: 'needs-input', timestamp: '' })).toBe('stopped');
  });

  it('shows the detail line only on the selected row', () => {
    currentId = 'other';
    view();
    expect(rowOf('other').querySelector('.session-detail')).not.toBeNull();
    expect(rowOf('main').querySelector('.session-detail')).toBeNull();
    expect(rowOf('other').classList.contains('active')).toBe(true);
  });

  it("puts a child's permission mode in its detail line, only when not auto", () => {
    sessions.set('b', { ...sessions.get('b')!, permissionMode: 'auto' });
    localStorage.setItem(EXPANDED_KEY, JSON.stringify(['main']));
    currentId = 'a';
    view();
    expect(rowOf('a').querySelector('.session-detail .session-mode-chip')?.textContent).toBe('acceptEdits');
    currentId = 'b';
    view();
    expect(rowOf('b').querySelector('.session-mode-chip')).toBeNull();
  });

  it('reads a row stored as default as manual', () => {
    sessions.set('a', { ...sessions.get('a')!, permissionMode: 'default' });
    localStorage.setItem(EXPANDED_KEY, JSON.stringify(['main']));
    currentId = 'a';
    view();
    expect(rowOf('a').querySelector('.session-mode-chip')?.textContent).toBe('manual');
  });

  it('shows an account warning on the row itself, not only in the detail line', () => {
    sessions.set('other', { ...sessions.get('other')!, accountWarning: 'login changed' });
    view();
    expect(rowOf('other').querySelector('.session-account-warning')?.getAttribute('title')).toBe('login changed');
  });

  it('shows account dots only when sessions run under more than one account', () => {
    sessions.set('other', { ...sessions.get('other')!, account: 'work' });
    sessions.set('main', { ...sessions.get('main')!, account: 'work' });
    view();
    expect(rowOf('other').querySelector('.session-account-dot')).toBeNull();
    sessions.set('main', { ...sessions.get('main')!, account: 'personal' });
    view();
    expect(rowOf('other').querySelector('.session-account-dot')?.getAttribute('title')).toContain('work');
  });
});

describe('fold, open and stored state', () => {
  it("summarises the children's notifications on the folded parent, most urgent first", () => {
    waiting('a');
    notifications.set('b', { type: 'completed', timestamp: '2026-10-01T11:00:00.000Z' });
    view();
    const tally = rowOf('main').querySelector('.session-kids') as HTMLElement;
    expect(tally.getAttribute('title')).toBe('1 needs input · 1 done · 2 started');
    const dots = [...tally.querySelectorAll('.tally-dot')].map((d) => d.className);
    expect(dots).toEqual(['tally-dot state-input', 'tally-dot state-done']);
  });

  it('unfolds with the arrow without opening the parent, and remembers it', () => {
    view();
    toggle('main');
    expect(host.attachToSession).not.toHaveBeenCalled();
    expect(JSON.parse(localStorage.getItem(EXPANDED_KEY) as string)).toEqual(['main']);

    // A fresh view in the same browser starts unfolded.
    document.body.innerHTML = '<input id="session-filter"><ul id="session-list"></ul>';
    view();
    expect(rowIds()).toEqual(['main', 'a', 'b', 'other']);
  });

  it('drops the old collapsed-groups key, whose meaning was the opposite', () => {
    localStorage.setItem('claude-remote.collapsedSessionGroups', JSON.stringify(['main']));
    view();
    expect(localStorage.getItem('claude-remote.collapsedSessionGroups')).toBeNull();
    expect(rowIds()).toEqual(['main', 'other']);
  });

  it('tapping the parent row opens it and does not unfold the group', () => {
    view();
    (rowOf('main').querySelector('.session-name') as HTMLElement).click();
    expect(host.attachToSession).toHaveBeenCalledWith('main');
    expect(rowIds()).toEqual(['main', 'other']);
  });

  it('tapping a child opens the child', () => {
    view();
    toggle('main');
    (rowOf('a').querySelector('.session-name') as HTMLElement).click();
    expect(host.attachToSession).toHaveBeenCalledWith('a');
  });

  it('forgets expanded ids of deleted sessions the next time a group is toggled', () => {
    localStorage.setItem(EXPANDED_KEY, JSON.stringify(['gone-parent', 'track:gone-builder']));
    view();
    toggle('main');
    expect(JSON.parse(localStorage.getItem(EXPANDED_KEY) as string)).toEqual(['main']);
  });
});

describe('counts and reordering', () => {
  it("counts a category's nested children with its rows", () => {
    view();
    expect(section('cat').querySelector('.category-count')?.textContent).toBe('3');
    expect(document.querySelector('.category-section.uncategorized .category-count')?.textContent).toBe('1');
  });

  it("tallies what waits in a category, children included", () => {
    waiting('a');
    view();
    expect(section('cat').querySelector('.category-tally')?.textContent).toBe('1 waiting');
    expect(document.querySelector('.uncategorized .category-tally')).toBeNull();
  });

  it('leaves nested children out of a reorder, though they share the category', () => {
    sessions.set('x', info('x', { sortOrder: 1 }));
    const v = view();
    (v as unknown as { reorderSessionInCategory: (d: string, t: string, c: string | null, b: boolean) => void })
      .reorderSessionInCategory('other', 'x', null, false);
    const updates = (host.reorderSessions as ReturnType<typeof vi.fn>).mock.calls[0][0] as { id: string }[];
    expect(updates.map((u) => u.id)).toEqual(['x', 'other']);
  });

  it('marks an empty category but still renders it, as a drop target', () => {
    categories.set('empty', { id: 'empty', name: 'Ideas', sortOrder: 1, collapsed: false });
    view();
    expect(section('empty').classList.contains('empty')).toBe(true);
    expect(section('empty').querySelector('.category-count')?.textContent).toBe('0');
  });
});

describe('"Needs you" strip', () => {
  it('lists waiting sessions, children included, with the parent as context', () => {
    waiting('a');
    view();
    const strip = document.querySelector('.attention-section') as HTMLElement;
    expect(rowIds(strip)).toEqual(['a']);
    expect(strip.querySelector('.session-context')?.textContent).toBe('main');
    expect((strip.querySelector('.session-item') as HTMLElement).draggable).toBe(false);
  });

  it('is absent when nothing waits', () => {
    view();
    expect(document.querySelector('.attention-section')).toBeNull();
  });

  it('opening a waiting child from the strip unfolds its parent', () => {
    waiting('b');
    view();
    (document.querySelector('.attention-section .session-name') as HTMLElement).click();
    expect(host.attachToSession).toHaveBeenCalledWith('b');
    expect(JSON.parse(localStorage.getItem(EXPANDED_KEY) as string)).toEqual(['main']);
  });

  it('orders longest-waiting first and skips stopped sessions', () => {
    waiting('a', '2026-10-01T11:05:00.000Z');
    waiting('b', '2026-10-01T11:01:00.000Z');
    waiting('other');
    sessions.set('other', { ...sessions.get('other')!, attachable: false });
    expect(needsYou(sessions, notifications).map((s) => s.id)).toEqual(['b', 'a']);
  });
});

describe('"Stopped" drawer', () => {
  beforeEach(() => {
    sessions.set('dead', info('dead', { categoryId: 'cat', attachable: false, revivable: true, sortOrder: 2 }));
  });

  it('moves stopped rows out of their category into a folded drawer', () => {
    view();
    expect(rowIds(section('cat'))).not.toContain('dead');
    const drawer = document.querySelector('.stopped-section') as HTMLElement;
    expect(drawer.querySelector('.category-count')?.textContent).toBe('1');
    expect(rowIds(drawer)).toEqual([]);
  });

  it('opens on click, names the category, offers revive, and remembers being open', () => {
    view();
    (document.querySelector('.stopped-header') as HTMLElement).click();
    const drawer = document.querySelector('.stopped-section') as HTMLElement;
    expect(rowIds(drawer)).toEqual(['dead']);
    expect(drawer.querySelector('.session-category-chip')?.textContent).toBe('Work');
    (drawer.querySelector('.session-revive-btn') as HTMLElement).click();
    expect(host.reviveSession).toHaveBeenCalledWith('dead');
    expect(localStorage.getItem('claude-remote.stoppedDrawerOpen')).toBe('true');
  });

  it('leaves stopped rows in place when the setting says so', () => {
    localStorage.setItem(KEEP_STOPPED_IN_PLACE_KEY, 'true');
    view();
    expect(rowIds(section('cat'))).toContain('dead');
    expect(document.querySelector('.stopped-section')).toBeNull();
  });
});

describe('read-only peers (project/builder-critic-pairs.md)', () => {
  const WT = 'C:\\wt\\split';
  const OTHER_WT = 'C:\\wt\\other';
  const at = (m: number) => `2026-10-01T10:${String(10 + m).padStart(2, '0')}:00.000Z`;

  function builderWithPeers(n: number): void {
    sessions.set('b1', info('b1', { spawnedBy: 'main', cwd: WT, createdAt: at(0) }));
    sessions.set('b2', info('b2', { spawnedBy: 'main', cwd: OTHER_WT, createdAt: at(1) }));
    for (let i = 1; i <= n; i++) {
      sessions.set(`p${i}`, info(`p${i}`, { spawnedBy: 'main', cwd: WT, access: 'read', createdAt: at(1 + i) }));
    }
    localStorage.setItem(EXPANDED_KEY, JSON.stringify(['main']));
  }

  it('renders a builder and its peer as one track row', () => {
    builderWithPeers(1);
    view();
    expect(rowIds()).toEqual(['main', 'a', 'b', 'b1', 'b2', 'other']);
    const track = rowOf('b1');
    expect(track.classList.contains('session-track')).toBe(true);
    expect(track.querySelector('.session-track-chip')?.textContent).toBe('pair');
    expect(track.querySelectorAll('.session-glyph.ro')).toHaveLength(1);
  });

  it('shows up to three peer squares, then +n, and a 1+n chip', () => {
    builderWithPeers(4);
    view();
    const track = rowOf('b1');
    expect(track.querySelectorAll('[data-peer-id]')).toHaveLength(3);
    expect(track.querySelector('.session-glyph-more')?.textContent).toBe('+1');
    expect(track.querySelector('.session-track-chip')?.textContent).toBe('1+4');
  });

  it("a peer's square opens that peer; the rest of the row opens the builder", () => {
    builderWithPeers(2);
    view();
    (rowOf('b1').querySelector('[data-peer-id="p2"]') as HTMLElement).click();
    expect(host.attachToSession).toHaveBeenLastCalledWith('p2');
    (rowOf('b1').querySelector('.session-name') as HTMLElement).click();
    expect(host.attachToSession).toHaveBeenLastCalledWith('b1');
  });

  it("unfolding a track lists its peers by name under the builder", () => {
    builderWithPeers(2);
    view();
    toggle('b1');
    expect(rowIds()).toEqual(['main', 'a', 'b', 'b1', 'p1', 'p2', 'b2', 'other']);
    expect(rowOf('p1').classList.contains('session-track-member')).toBe(true);
    expect(rowOf('b1').querySelector('[data-peer-id]')).toBeNull();
    expect(JSON.parse(localStorage.getItem(EXPANDED_KEY) as string)).toEqual(['main', 'track:b1']);
  });

  it("counts a track once, at its most urgent member, in the parent's tally", () => {
    builderWithPeers(2);
    waiting('p2');
    localStorage.clear();
    view();
    const dots = [...rowOf('main').querySelectorAll('.tally-dot')].map((d) => d.className);
    // a, b, the b1 track, b2: four tracks, the waiting one first.
    expect(dots).toHaveLength(4);
    expect(dots[0]).toBe('tally-dot state-input');
  });

  it('groups any number of peers with their builder, and leaves an orphan peer alone', () => {
    const list = [
      info('orphan', { access: 'read', cwd: OTHER_WT, createdAt: at(0) }),
      info('builder', { cwd: WT, createdAt: at(1) }),
      info('x', { cwd: OTHER_WT, createdAt: at(2) }),
      info('peer2', { access: 'read', cwd: WT, createdAt: at(4) }),
      info('peer1', { access: 'read', cwd: WT, createdAt: at(3) }),
    ];
    expect(trackGroups(list).map((g) => [g.lead.id, g.peers.map((p) => p.id)])).toEqual([
      ['orphan', []],
      ['builder', ['peer1', 'peer2']],
      ['x', []],
    ]);
    expect(peersAfterBuilders(list).map((s) => s.id)).toEqual(['orphan', 'builder', 'peer1', 'peer2', 'x']);
  });

  it('puts a peer after the newest builder in its worktree started before it', () => {
    const list = [
      info('old', { cwd: WT, status: 'terminated', createdAt: at(0) }),
      info('new', { cwd: WT, createdAt: at(1) }),
      info('peer', { access: 'read', cwd: WT, createdAt: at(2) }),
    ];
    expect(peersAfterBuilders(list).map((s) => s.id)).toEqual(['old', 'new', 'peer']);
  });
});

describe('filter', () => {
  it('matches name, @name, account, category, parent, read-only and stopped, every word', () => {
    const s = info('x', { name: 'Save system', claudeName: 'claude-remote-31', account: 'work', access: 'read', attachable: false });
    const ctx = { parentName: 'gladiatory', categoryName: 'Coding' };
    for (const q of ['save', '@claude-remote', 'work', 'coding', 'gladiatory', 'read-only', 'stopped', 'save WORK']) {
      expect(matchesFilter(s, q, ctx)).toBe(true);
    }
    expect(matchesFilter(s, 'save personal', ctx)).toBe(false);
    expect(matchesFilter(info('y'), 'stopped')).toBe(false);
  });

  it('flattens the tree into matching rows with their context, and Escape clears it', () => {
    view();
    const input = document.getElementById('session-filter') as HTMLInputElement;
    input.value = 'b';
    input.dispatchEvent(new Event('input'));
    const matches = document.querySelector('.matches-section') as HTMLElement;
    // The folded child "b" is found, with its parent as context.
    expect(rowIds(matches)).toEqual(['b']);
    expect(rowOf('b').querySelector('.session-context')?.textContent).toBe('main');
    // A parent's name finds what it started.
    input.value = 'main';
    input.dispatchEvent(new Event('input'));
    expect(rowIds(document.querySelector('.matches-section') as HTMLElement)).toEqual(['main', 'a', 'b']);

    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(input.value).toBe('');
    expect(document.querySelector('.matches-section')).toBeNull();
  });

  it('says so when nothing matches', () => {
    view();
    const input = document.getElementById('session-filter') as HTMLInputElement;
    input.value = 'zzz';
    input.dispatchEvent(new Event('input'));
    expect(document.querySelector('.session-filter-empty')?.textContent).toBe('No session matches "zzz".');
  });
});

describe('@ copy', () => {
  it('has a copy action only on rows with a running Claude', () => {
    sessions.set('other', { ...sessions.get('other')!, claudeName: 'claude-remote-31' });
    view();
    expect(rowOf('other').querySelector('.session-copy-btn')).not.toBeNull();
    expect(rowOf('main').querySelector('.session-copy-btn')).toBeNull();
    // The address is not printed on the row.
    expect(rowOf('other').textContent).not.toContain('claude-remote-31');
  });

  it('copies @name and says which, without opening the session', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    sessions.set('other', { ...sessions.get('other')!, claudeName: 'claude-remote-31' });
    view();
    const btn = rowOf('other').querySelector('.session-copy-btn') as HTMLElement;
    btn.click();
    // The copy re-renders the row, so look the button up again.
    await vi.waitFor(() =>
      expect(rowOf('other').querySelector('.session-copy-btn')?.classList.contains('copied')).toBe(true)
    );
    expect(writeText).toHaveBeenCalledWith('@claude-remote-31');
    expect(host.attachToSession).not.toHaveBeenCalled();
    expect(rowOf('other').classList.contains('just-copied')).toBe(true);
    const toast = document.getElementById('session-toast') as HTMLElement;
    expect(toast.hidden).toBe(false);
    expect(toast.textContent).toContain('Copied');
    expect(toast.querySelector('.session-toast-text')?.textContent).toBe('@claude-remote-31');
  });

  it('never says Copied when the copy failed, and offers the text to select', async () => {
    vi.stubGlobal('navigator', { clipboard: { writeText: vi.fn().mockRejectedValue(new Error('insecure')) } });
    const execCommand = vi.fn().mockReturnValue(false);
    (document as unknown as { execCommand: typeof execCommand }).execCommand = execCommand;
    sessions.set('other', { ...sessions.get('other')!, claudeName: 'claude-remote-31' });
    view();
    const btn = rowOf('other').querySelector('.session-copy-btn') as HTMLElement;
    btn.click();
    const toast = document.getElementById('session-toast') as HTMLElement;
    await vi.waitFor(() => expect(toast.hidden).toBe(false));
    expect(toast.classList.contains('failed')).toBe(true);
    expect(toast.textContent).not.toContain('Copied');
    expect((toast.querySelector('input') as HTMLInputElement).value).toBe('@claude-remote-31');
    expect(btn.classList.contains('copied')).toBe(false);
  });
});

describe('copy feedback and focus', () => {
  it('keeps the check and the green edge through a re-render, then drops them', async () => {
    vi.stubGlobal('navigator', { clipboard: { writeText: vi.fn().mockResolvedValue(undefined) } });
    sessions.set('other', { ...sessions.get('other')!, claudeName: 'claude-remote-31' });
    const v = view();
    (rowOf('other').querySelector('.session-copy-btn') as HTMLElement).click();
    await vi.waitFor(() => expect(rowOf('other').classList.contains('just-copied')).toBe(true));

    // A notification or a name broadcast rebuilds every row.
    v.render();
    expect(rowOf('other').classList.contains('just-copied')).toBe(true);
    expect(rowOf('other').querySelector('.session-copy-btn')?.classList.contains('copied')).toBe(true);

    await vi.waitFor(() => expect(rowOf('other').classList.contains('just-copied')).toBe(false), { timeout: 2500 });
    expect(rowOf('other').querySelector('.session-copy-btn')?.classList.contains('copied')).toBe(false);
  });

  it('gives focus back after the selection fallback', async () => {
    vi.stubGlobal('navigator', {});
    (document as unknown as { execCommand: () => boolean }).execCommand = vi.fn().mockReturnValue(true);
    sessions.set('other', { ...sessions.get('other')!, claudeName: 'claude-remote-31' });
    document.body.insertAdjacentHTML('beforeend', '<textarea id="term"></textarea>');
    view();
    const term = document.getElementById('term') as HTMLTextAreaElement;
    term.focus();
    (rowOf('other').querySelector('.session-copy-btn') as HTMLElement).click();
    await vi.waitFor(() => expect(document.getElementById('session-toast')?.hidden).toBe(false));
    expect(document.activeElement).toBe(term);
    expect(document.getElementById('session-toast')?.textContent).toContain('Copied');
    // Let the feedback timer run out here: it re-renders this view, which would
    // otherwise draw this test's sessions over the next test's list.
    await vi.waitFor(() => expect(rowOf('other').classList.contains('just-copied')).toBe(false), { timeout: 2500 });
  });
});

describe('keyboard order (Ctrl+Q / Ctrl+E)', () => {
  it('follows what the tree shows: no folded children, strip copies, drawer or folded category', () => {
    sessions.set('dead', info('dead', { categoryId: 'cat', attachable: false, sortOrder: 3 }));
    categories.set('shut', { id: 'shut', name: 'Shut', sortOrder: 1, collapsed: true });
    sessions.set('hidden', info('hidden', { categoryId: 'shut' }));
    waiting('a');
    const v = view();
    expect(v.visibleOrder()).toEqual(['main', 'other']);
    toggle('main');
    expect(v.visibleOrder()).toEqual(['main', 'a', 'b', 'other']);
  });

  it('walks the matches while a filter is on', () => {
    const v = view();
    const input = document.getElementById('session-filter') as HTMLInputElement;
    input.value = 'b';
    input.dispatchEvent(new Event('input'));
    expect(v.visibleOrder()).toEqual(['b']);
  });
});

describe('Alt+K and the phone sidebar', () => {
  it('recognises Alt+K only', () => {
    const key = (init: KeyboardEventInit) => new KeyboardEvent('keydown', init);
    expect(isFilterShortcut(key({ key: 'k', altKey: true }))).toBe(true);
    expect(isFilterShortcut(key({ key: 'K', altKey: true }))).toBe(true);
    expect(isFilterShortcut(key({ key: 'k', altKey: true, ctrlKey: true }))).toBe(false);
    expect(isFilterShortcut(key({ key: 'k' }))).toBe(false);
  });

  it('hides the menu button while the overlay is open, and brings it back on close', () => {
    document.body.insertAdjacentHTML(
      'beforeend',
      '<button id="mobile-menu-btn"></button><aside id="sidebar"></aside><div id="sidebar-overlay"></div>'
    );
    openMobileSidebar();
    expect(document.getElementById('sidebar')?.classList.contains('open')).toBe(true);
    expect(document.getElementById('mobile-menu-btn')?.classList.contains('hidden')).toBe(true);
    closeMobileSidebar();
    expect(document.getElementById('sidebar-overlay')?.classList.contains('open')).toBe(false);
    expect(document.getElementById('mobile-menu-btn')?.classList.contains('hidden')).toBe(false);
  });
});

describe('account colours', () => {
  it('re-reads the account order on refresh, so the dots follow a config change', async () => {
    sessions.set('other', { ...sessions.get('other')!, account: 'work' });
    sessions.set('main', { ...sessions.get('main')!, account: 'personal' });
    const order = (names: string[]) => ({ ok: true, json: async () => ({ accounts: names.map((name) => ({ name })) }) });
    const fetchMock = vi.fn().mockResolvedValueOnce(order(['work', 'personal'])).mockResolvedValueOnce(order(['personal', 'work']));
    vi.stubGlobal('fetch', fetchMock);
    const v = view();
    await vi.waitFor(() => expect(rowOf('other').querySelector('.session-account-dot')?.classList.contains('acct-c0')).toBe(true));
    await v.refreshAccountOrder();
    expect(rowOf('other').querySelector('.session-account-dot')?.classList.contains('acct-c1')).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
