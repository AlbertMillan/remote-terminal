import { isFilterShortcut } from './session-list-view.js';

/**
 * The page-wide keys outside the terminal (the shortcuts modal lists them from
 * shortcuts.ts's SHORTCUT_GROUPS; inside the terminal, terminal.ts handles its own).
 */
export interface GlobalShortcutActions {
  /** Escape: every modal closes. */
  closeModals(): void;
  toggleShortcutsModal(): void;
  showNewSessionModal(): void;
  focusSessionFilter(): void;
  navigateToSession(direction: 'prev' | 'next'): void;
  toggleSidebar(): void;
}

/** True while a field (a modal input, xterm's helper textarea) has the keyboard. */
function typingInField(): boolean {
  const tag = (document.activeElement?.tagName ?? '').toLowerCase();
  return tag === 'input' || tag === 'textarea';
}

export function bindGlobalShortcuts(actions: GlobalShortcutActions): void {
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') actions.closeModals();
    // Show keyboard shortcuts: ?
    // Skip when a field is focused, or when another modal is already open (avoid stacking).
    if (e.key === '?' && !e.ctrlKey && !e.altKey && !e.metaKey) {
      const otherModalOpen = !!document.querySelector('.modal:not(.hidden):not(#shortcuts-modal)');
      if (!typingInField() && !otherModalOpen) {
        e.preventDefault();
        actions.toggleShortcutsModal();
      }
    }
    // New session: Alt+N
    if (e.altKey && !e.ctrlKey && !e.shiftKey && !e.metaKey && (e.key === 'n' || e.key === 'N')) {
      if (!typingInField()) {
        e.preventDefault();
        actions.showNewSessionModal();
      }
    }
    // Filter sessions: Alt+K. Not while typing in a field (a modal, the filter itself);
    // inside the terminal, terminal.ts handles it, since xterm's textarea is focused there.
    if (isFilterShortcut(e) && !typingInField()) {
      e.preventDefault();
      actions.focusSessionFilter();
    }
    // Session navigation: Ctrl+Q = prev, Ctrl+E = next; Ctrl+B folds the sidebar.
    if (e.ctrlKey && !e.altKey && !e.shiftKey && !e.metaKey && !typingInField()) {
      if (e.key === 'q' || e.key === 'Q') {
        e.preventDefault();
        actions.navigateToSession('prev');
      } else if (e.key === 'e' || e.key === 'E') {
        e.preventDefault();
        actions.navigateToSession('next');
      } else if (e.key === 'b' || e.key === 'B') {
        e.preventDefault();
        actions.toggleSidebar();
      }
    }
  });
}

/** A click on a modal's backdrop (not its dialog) closes it. */
export function closeOnBackdrop(modalId: string, hide: () => void): void {
  document.getElementById(modalId)?.addEventListener('click', (e) => {
    if (e.target === e.currentTarget) hide();
  });
}
