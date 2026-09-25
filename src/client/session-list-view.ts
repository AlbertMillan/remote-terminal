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

/** The sidebar session list: categories, drag/drop reordering, and session rows. */
export class SessionListView {
  private draggedSessionId: string | null = null;
  private dropIndicatorEl: HTMLElement | null = null;

  constructor(private readonly host: SessionListViewHost) {}

  render(): void {
    const listEl = document.getElementById('session-list');
    if (!listEl) return;

    listEl.innerHTML = '';

    // Sort sessions by sortOrder (ascending)
    const sortedSessions = Array.from(this.host.sessions.values()).sort(
      (a, b) => a.sortOrder - b.sortOrder
    );

    // Sort categories by sortOrder
    const sortedCategories = Array.from(this.host.categories.values()).sort(
      (a, b) => a.sortOrder - b.sortOrder
    );

    // Group sessions by category
    const uncategorizedSessions = sortedSessions.filter(s => !s.categoryId);
    const sessionsByCategory = new Map<string, SessionInfo[]>();
    for (const cat of sortedCategories) {
      sessionsByCategory.set(cat.id, []);
    }
    for (const session of sortedSessions) {
      if (session.categoryId && sessionsByCategory.has(session.categoryId)) {
        sessionsByCategory.get(session.categoryId)!.push(session);
      }
    }

    // Add "Add Category" button at top
    const addCategoryBtn = document.createElement('button');
    addCategoryBtn.className = 'add-category-btn';
    addCategoryBtn.innerHTML = `
      <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <line x1="12" y1="5" x2="12" y2="19"></line>
        <line x1="5" y1="12" x2="19" y2="12"></line>
      </svg>
      Add Category
    `;
    addCategoryBtn.addEventListener('click', () => this.host.showCategoryModal('create'));
    listEl.appendChild(addCategoryBtn);

    // Render categories with their sessions
    for (const category of sortedCategories) {
      const sessions = sessionsByCategory.get(category.id) || [];
      this.renderCategory(listEl, category, sessions);
    }

    // Render uncategorized sessions at the bottom
    if (uncategorizedSessions.length > 0 || sortedCategories.length > 0) {
      this.renderUncategorizedSection(listEl, uncategorizedSessions);
    } else {
      // No categories, just render sessions directly
      for (const session of sortedSessions) {
        this.renderSessionItem(listEl, session);
      }
    }
  }

  private renderCategory(container: HTMLElement, category: CategoryInfo, sessions: SessionInfo[]): void {
    const section = document.createElement('div');
    section.className = 'category-section';
    if (category.collapsed) section.classList.add('collapsed');
    section.dataset.categoryId = category.id;

    const header = document.createElement('div');
    header.className = 'category-header';
    header.innerHTML = `
      <button class="category-toggle" title="${category.collapsed ? 'Expand' : 'Collapse'}">
        <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <polyline points="6 9 12 15 18 9"></polyline>
        </svg>
      </button>
      <span class="category-name">${escapeHtml(category.name)}</span>
      <span class="category-count">(${sessions.length})</span>
      <div class="category-actions">
        <button class="category-rename-btn" title="Rename">
          <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/>
          </svg>
        </button>
        <button class="category-delete-btn" title="Delete">
          <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <line x1="18" y1="6" x2="6" y2="18"></line>
            <line x1="6" y1="6" x2="18" y2="18"></line>
          </svg>
        </button>
      </div>
    `;

    // Category toggle
    header.querySelector('.category-toggle')?.addEventListener('click', (e) => {
      e.stopPropagation();
      this.host.toggleCategory(category.id, !category.collapsed);
    });

    // Category rename
    header.querySelector('.category-rename-btn')?.addEventListener('click', (e) => {
      e.stopPropagation();
      this.host.showCategoryModal('rename', category);
    });

    // Category delete
    header.querySelector('.category-delete-btn')?.addEventListener('click', (e) => {
      e.stopPropagation();
      if (confirm(`Delete category "${category.name}"? Sessions will become uncategorized.`)) {
        this.host.deleteCategory(category.id);
      }
    });

    // Allow dropping on category header (for empty categories)
    header.addEventListener('dragover', (e) => {
      e.preventDefault();
      header.classList.add('drop-target');
    });

    header.addEventListener('dragleave', (e) => {
      if (!header.contains(e.relatedTarget as Node)) {
        header.classList.remove('drop-target');
      }
    });

    header.addEventListener('drop', (e) => {
      e.preventDefault();
      e.stopPropagation();
      header.classList.remove('drop-target');

      if (this.draggedSessionId) {
        const session = this.host.sessions.get(this.draggedSessionId);
        if (session && session.categoryId !== category.id) {
          this.host.moveSession(this.draggedSessionId, category.id);
        }
      }
    });

    section.appendChild(header);

    const sessionList = document.createElement('ul');
    sessionList.className = 'category-sessions';

    // Drop zone handling
    this.setupDropZone(sessionList, category.id);

    for (const session of sessions) {
      this.renderSessionItem(sessionList, session);
    }

    section.appendChild(sessionList);
    container.appendChild(section);
  }

  private renderUncategorizedSection(container: HTMLElement, sessions: SessionInfo[]): void {
    const section = document.createElement('div');
    section.className = 'category-section uncategorized';
    section.dataset.categoryId = '';

    const header = document.createElement('div');
    header.className = 'category-header';
    header.innerHTML = `
      <span class="category-name">Uncategorized</span>
      <span class="category-count">(${sessions.length})</span>
    `;

    // Allow dropping on uncategorized header
    header.addEventListener('dragover', (e) => {
      e.preventDefault();
      header.classList.add('drop-target');
    });

    header.addEventListener('dragleave', (e) => {
      if (!header.contains(e.relatedTarget as Node)) {
        header.classList.remove('drop-target');
      }
    });

    header.addEventListener('drop', (e) => {
      e.preventDefault();
      e.stopPropagation();
      header.classList.remove('drop-target');

      if (this.draggedSessionId) {
        const session = this.host.sessions.get(this.draggedSessionId);
        if (session && session.categoryId !== null) {
          this.host.moveSession(this.draggedSessionId, null);
        }
      }
    });

    section.appendChild(header);

    const sessionList = document.createElement('ul');
    sessionList.className = 'category-sessions';

    // Drop zone handling for uncategorized
    this.setupDropZone(sessionList, null);

    for (const session of sessions) {
      this.renderSessionItem(sessionList, session);
    }

    section.appendChild(sessionList);
    container.appendChild(section);
  }

  private renderSessionItem(container: HTMLElement, session: SessionInfo): void {
    const li = document.createElement('li');
    li.className = 'session-item';
    li.draggable = true;
    li.dataset.sessionId = session.id;
    if (session.id === this.host.getCurrentSessionId()) li.classList.add('active');
    if (session.status === 'terminated') li.classList.add('terminated');
    if (!session.attachable) li.classList.add('not-attachable');

    // Check for notification badge - validate notification type to prevent XSS
    const notification = this.host.sessionNotifications.get(session.id);
    const validNotificationTypes = ['needs-input', 'completed'] as const;
    const notificationType = notification && validNotificationTypes.includes(notification.type) ? notification.type : null;
    const badgeHtml = notificationType
      ? `<span class="notification-badge ${notificationType}" title="${notificationType === 'needs-input' ? 'Waiting for input' : 'Task completed'}"></span>`
      : '';

    // Escape values for safe HTML attribute insertion
    const escapedSessionId = escapeAttr(session.id);
    const escapedStatus = escapeHtml(session.status);

    // A stale row is a session whose PTY died with the server -- it outlived its process and
    // can be brought back. Forks cannot: their transcript is unlinked at boot, so there would
    // be nothing to resume. Both the "(stale)" label and the button derive from this one
    // expression so they can never disagree about what stale means.
    const isStale = !session.attachable && session.status !== 'terminated';
    const canRevive = isStale && !session.isFork;
    const reviveHtml = canRevive
      ? `<button class="session-revive-btn" title="${session.claudeSessionId ? 'Resume conversation' : 'Restart shell'}" data-session-id="${escapedSessionId}">
          <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <polygon points="5 3 19 12 5 21 5 3"></polygon>
          </svg>
        </button>`
      : '';

    li.innerHTML = `
      <span class="session-drag-handle">
        <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <circle cx="9" cy="5" r="1"/><circle cx="9" cy="12" r="1"/><circle cx="9" cy="19" r="1"/>
          <circle cx="15" cy="5" r="1"/><circle cx="15" cy="12" r="1"/><circle cx="15" cy="19" r="1"/>
        </svg>
      </span>
      ${badgeHtml}
      <span class="session-icon">
        <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <polyline points="4 17 10 11 4 5"></polyline>
          <line x1="12" y1="19" x2="20" y2="19"></line>
        </svg>
      </span>
      <div class="session-info">
        <div class="session-name">${escapeHtml(session.name)}</div>
        <div class="session-status">${escapedStatus}${isStale ? ' (stale)' : ''}</div>
      </div>
      ${reviveHtml}
      <button class="session-delete-btn" title="Delete session" data-session-id="${escapedSessionId}">
        <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <polyline points="3 6 5 6 21 6"></polyline>
          <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
        </svg>
      </button>
    `;

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

    // Click handler for session selection
    li.addEventListener('click', (e) => {
      if ((e.target as HTMLElement).closest('.session-delete-btn')) return;
      if ((e.target as HTMLElement).closest('.session-revive-btn')) return;
      if ((e.target as HTMLElement).closest('.session-drag-handle')) return;

      if (session.attachable) {
        this.host.attachToSession(session.id);
        document.getElementById('sidebar')?.classList.remove('open');
        document.getElementById('sidebar-overlay')?.classList.remove('open');
        document.getElementById('mobile-menu-btn')?.classList.remove('hidden');
      }
    });

    // Revive button handler (stale rows only)
    const reviveBtn = li.querySelector('.session-revive-btn');
    reviveBtn?.addEventListener('click', (e) => {
      e.stopPropagation();
      this.host.reviveSession(session.id);
    });

    // Delete button handler
    const deleteBtn = li.querySelector('.session-delete-btn');
    deleteBtn?.addEventListener('click', (e) => {
      e.stopPropagation();
      this.host.deleteSession(session.id);
    });

    container.appendChild(li);
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
    // Get all sessions in this category, sorted by current sortOrder
    const sessionsInCategory = Array.from(this.host.sessions.values())
      .filter(s => s.categoryId === categoryId)
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
