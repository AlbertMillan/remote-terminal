import { escapeHtml } from './html-utils.js';
import { SHORTCUT_GROUPS } from './shortcuts.js';

/**
 * The keyboard shortcuts modal and the welcome-screen hints — both rendered
 * from the SHORTCUT_GROUPS registry so new shortcuts appear here
 * automatically once added to shortcuts.ts.
 */
export class ShortcutsModal {
  private shortcutsRendered = false;
  private shortcutsPreviousFocus: HTMLElement | null = null;

  /** Render key tokens as <kbd> elements joined by a "+" separator. */
  private renderKeys(keys: string[], plusClass = ''): string {
    const plus = plusClass ? `<span class="${plusClass}">+</span>` : '<span>+</span>';
    return keys.map((k) => `<kbd>${escapeHtml(k)}</kbd>`).join(plus);
  }

  private renderShortcutsModal(): void {
    if (this.shortcutsRendered) return;

    const container = document.getElementById('shortcuts-list');
    if (!container) return;

    container.innerHTML = SHORTCUT_GROUPS.map(
      (group) => `
        <div class="shortcuts-group">
          <div class="shortcuts-group-title">${escapeHtml(group.title)}</div>
          ${group.shortcuts
            .map(
              (s) => `
            <div class="shortcuts-row">
              <span class="shortcuts-keys">${this.renderKeys(s.keys, 'shortcuts-plus')}</span>
              <span class="shortcuts-desc">${escapeHtml(s.label)}</span>
            </div>`
            )
            .join('')}
        </div>`
    ).join('');

    this.shortcutsRendered = true;
  }

  renderWelcomeShortcuts(): void {
    const container = document.getElementById('welcome-shortcut-group');
    if (!container) return;

    const items = SHORTCUT_GROUPS.flatMap((group) => group.shortcuts).filter((s) => s.welcome);
    container.innerHTML = items
      .map(
        (s) => `
        <div class="shortcut-item">
          ${this.renderKeys(s.keys)}
          <span class="shortcut-label">${escapeHtml(s.label)}</span>
        </div>`
      )
      .join('');
  }

  showShortcutsModal(): void {
    this.renderShortcutsModal();
    document.getElementById('shortcuts-modal')?.classList.remove('hidden');
    // Remember what had focus so we can restore it when the modal closes.
    this.shortcutsPreviousFocus = document.activeElement as HTMLElement | null;
    document.getElementById('shortcuts-close')?.focus();
  }

  hideShortcutsModal(): void {
    const modal = document.getElementById('shortcuts-modal');
    if (!modal || modal.classList.contains('hidden')) return;
    modal.classList.add('hidden');
    // Restore focus to wherever it was before the modal opened.
    this.shortcutsPreviousFocus?.focus();
    this.shortcutsPreviousFocus = null;
  }

  toggleShortcutsModal(): void {
    const modal = document.getElementById('shortcuts-modal');
    if (!modal) return;
    if (modal.classList.contains('hidden')) {
      this.showShortcutsModal();
    } else {
      this.hideShortcutsModal();
    }
  }
}
