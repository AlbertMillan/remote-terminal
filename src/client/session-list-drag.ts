import type { SessionInfo } from './session-types.js';

/**
 * Dragging sidebar rows: reorder within a category (an insertion line shows where), or drop
 * on another category's list or header to move the session there.
 */
export interface SessionDragHost {
  sessions: Map<string, SessionInfo>;
  moveSession(sessionId: string, categoryId: string | null): void;
  /** Same category: put `draggedId` before or after `targetId`. */
  reorder(draggedId: string, targetId: string, categoryId: string | null, insertBefore: boolean): void;
}

export class SessionDrag {
  private draggedSessionId: string | null = null;
  private dropIndicatorEl: HTMLElement | null = null;

  constructor(private readonly host: SessionDragHost) {}

  /** A category header takes drops too, so an empty or folded category can be filled. */
  attachHeader(header: HTMLElement, categoryId: string | null): void {
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

  attachRow(li: HTMLElement, session: SessionInfo): void {
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
          this.host.reorder(this.draggedSessionId, session.id, targetCategoryId, insertBefore);
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

  attachDropZone(element: HTMLElement, categoryId: string | null): void {
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
}
