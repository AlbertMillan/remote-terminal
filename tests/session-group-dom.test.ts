// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { SessionListView, type SessionListViewHost } from '../src/client/session-list-view.js';
import type { SessionInfo, CategoryInfo } from '../src/client/session-types.js';

/**
 * Sessions a main session started render nested under it
 * (docs/session-orchestration.md): in the parent's category, collapsible per
 * browser, with a summary on the parent that stays visible when collapsed.
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

function view(): SessionListView {
  const v = new SessionListView(host);
  v.render();
  return v;
}

function rowIds(): string[] {
  return [...document.querySelectorAll<HTMLElement>('.session-item')].map((li) => li.dataset.sessionId as string);
}

function rowOf(id: string): HTMLElement {
  return document.querySelector<HTMLElement>(`.session-item[data-session-id="${id}"]`) as HTMLElement;
}

beforeEach(() => {
  localStorage.clear();
  document.body.innerHTML = '<ul id="session-list"></ul>';
  sessions = new Map();
  categories = new Map([['cat', { id: 'cat', name: 'Work', sortOrder: 0, collapsed: false }]]);
  notifications = new Map();
  host = {
    sessions,
    categories,
    sessionNotifications: notifications,
    getCurrentSessionId: () => null,
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

describe('nesting', () => {
  it("renders children right under their parent, in the parent's category, in creation order", () => {
    view();
    expect(rowIds()).toEqual(['main', 'a', 'b', 'other']);
    const work = document.querySelector('.category-section[data-category-id="cat"]') as HTMLElement;
    expect([...work.querySelectorAll<HTMLElement>('.session-item')].map((li) => li.dataset.sessionId)).toEqual(['main', 'a', 'b']);
    expect(rowOf('a').classList.contains('session-child')).toBe(true);
    expect(rowOf('main').classList.contains('session-parent')).toBe(true);
  });

  it('children are not draggable and have no drag handle', () => {
    view();
    expect(rowOf('a').draggable).toBe(false);
    expect(rowOf('a').querySelector('.session-drag-handle')).toBeNull();
    expect(rowOf('main').draggable).toBe(true);
  });

  it("renders a child whose parent was deleted as top-level, in its own category", () => {
    sessions.delete('main');
    view();
    expect(rowIds().sort()).toEqual(['a', 'b', 'other']);
    expect(rowOf('a').classList.contains('session-child')).toBe(false);
  });

  it('keeps the group for a terminated parent that is still listed', () => {
    sessions.set('main', info('main', { categoryId: 'cat', status: 'terminated', attachable: false }));
    view();
    expect(rowIds()).toEqual(['main', 'a', 'b', 'other']);
  });

  it('shows a permission-mode chip only on a child whose mode is not auto', () => {
    sessions.set('b', { ...sessions.get('b')!, permissionMode: 'auto' });
    view();
    expect(rowOf('a').querySelector('.session-mode-chip')?.textContent).toBe('acceptEdits');
    expect(rowOf('b').querySelector('.session-mode-chip')).toBeNull();
  });

  it('shows manual, and reads a row stored as default as manual', () => {
    sessions.set('a', { ...sessions.get('a')!, permissionMode: 'manual' });
    sessions.set('b', { ...sessions.get('b')!, permissionMode: 'default' });
    view();
    expect(rowOf('a').querySelector('.session-mode-chip')?.textContent).toBe('manual');
    expect(rowOf('b').querySelector('.session-mode-chip')?.textContent).toBe('manual');
  });
});

describe('summary and collapse', () => {
  it("summarises the children's notifications on the parent's row", () => {
    notifications.set('a', { type: 'needs-input', timestamp: '2026-10-01T11:00:00.000Z' });
    notifications.set('b', { type: 'completed', timestamp: '2026-10-01T11:00:00.000Z' });
    view();
    const status = rowOf('main').querySelector('.session-summary')?.textContent ?? '';
    expect(status).toContain('1 needs input');
    expect(status).toContain('1 done');
    expect(status).toContain('2 started');
  });

  it('collapses with the arrow without opening the parent, keeps the summary, and remembers it', () => {
    notifications.set('b', { type: 'needs-input', timestamp: '2026-10-01T11:00:00.000Z' });
    view();
    (rowOf('main').querySelector('.session-group-toggle') as HTMLElement).click();

    expect(host.attachToSession).not.toHaveBeenCalled();
    expect(rowIds()).toEqual(['main', 'other']);
    expect(rowOf('main').querySelector('.session-summary')?.textContent).toContain('1 needs input');

    // A fresh view in the same browser starts collapsed.
    document.body.innerHTML = '<ul id="session-list"></ul>';
    view();
    expect(rowIds()).toEqual(['main', 'other']);
  });

  it('tapping the parent row opens it and does not collapse the group', () => {
    view();
    (rowOf('main').querySelector('.session-name') as HTMLElement).click();
    expect(host.attachToSession).toHaveBeenCalledWith('main');
    expect(rowIds()).toEqual(['main', 'a', 'b', 'other']);
  });

  it('tapping a child opens the child', () => {
    view();
    (rowOf('a').querySelector('.session-name') as HTMLElement).click();
    expect(host.attachToSession).toHaveBeenCalledWith('a');
  });
});

describe('counts, reordering and stored state', () => {
  it("counts a category's nested children with its rows", () => {
    view();
    const work = document.querySelector('.category-section[data-category-id="cat"] .category-count');
    expect(work?.textContent).toBe('(3)');
    const uncategorized = document.querySelector('.category-section.uncategorized .category-count');
    expect(uncategorized?.textContent).toBe('(1)');
  });

  it('leaves nested children out of a reorder, though they share the category', () => {
    sessions.set('x', info('x', { sortOrder: 1 }));
    const v = view();
    (v as unknown as { reorderSessionInCategory: (d: string, t: string, c: string | null, b: boolean) => void })
      .reorderSessionInCategory('other', 'x', null, false);
    const updates = (host.reorderSessions as ReturnType<typeof vi.fn>).mock.calls[0][0] as { id: string }[];
    expect(updates.map((u) => u.id)).toEqual(['x', 'other']);
  });

  it('drops collapsed ids of deleted parents the next time a group is toggled', () => {
    localStorage.setItem('claude-remote.collapsedSessionGroups', JSON.stringify(['gone-parent']));
    view();
    (rowOf('main').querySelector('.session-group-toggle') as HTMLElement).click();
    expect(JSON.parse(localStorage.getItem('claude-remote.collapsedSessionGroups') as string)).toEqual(['main']);
  });
});
