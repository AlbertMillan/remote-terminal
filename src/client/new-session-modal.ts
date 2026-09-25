import { escapeHtml, escapeAttr } from './html-utils.js';
import { TrackPicker } from './track-picker.js';

export interface NewSessionModalHost {
  createSession(name?: string, cwd?: string): void;
}

/**
 * The "New Session" modal: name/cwd fields, recent-path suggestions, and the
 * Track picker (track-picker.ts).
 */
export class NewSessionModal {
  // New-session "recent paths" dropdown state
  private recentPaths: string[] = [];
  private cwdSuggestionIndex = -1;
  /** The New Session dialog's Track picker (track-picker.ts). */
  readonly trackPicker = new TrackPicker();

  constructor(private readonly host: NewSessionModalHost) {}

  show(prefillCwd?: string): void {
    const modal = document.getElementById('new-session-modal');
    if (modal) {
      modal.classList.remove('hidden');
      (document.getElementById('session-name-input') as HTMLInputElement).value = '';
      (document.getElementById('session-cwd-input') as HTMLInputElement).value = prefillCwd ?? '';
      this.hideCwdSuggestions();
      void this.loadRecentPaths();
      void this.trackPicker.refresh();
      document.getElementById('session-name-input')?.focus();
    }
  }

  hide(): void {
    document.getElementById('new-session-modal')?.classList.add('hidden');
    this.hideCwdSuggestions();
  }

  // Recent working-directory suggestions

  private async loadRecentPaths(): Promise<void> {
    try {
      const res = await fetch('/api/recent-paths');
      if (!res.ok) return;
      const data = (await res.json()) as { paths?: string[] };
      this.recentPaths = Array.isArray(data.paths) ? data.paths : [];
    } catch {
      // Suggestions are a convenience — silently degrade to a plain text field.
      this.recentPaths = [];
    }
    // Only show the dropdown affordance when there's something to suggest.
    document
      .getElementById('cwd-toggle')
      ?.classList.toggle('hidden', this.recentPaths.length === 0);
  }

  toggleCwdSuggestions(): void {
    const list = document.getElementById('cwd-suggestions');
    const input = document.getElementById('session-cwd-input') as HTMLInputElement | null;
    if (list && !list.classList.contains('hidden')) {
      this.hideCwdSuggestions();
    } else {
      this.renderCwdSuggestions();
    }
    input?.focus();
  }

  renderCwdSuggestions(): void {
    const input = document.getElementById('session-cwd-input') as HTMLInputElement | null;
    const list = document.getElementById('cwd-suggestions');
    if (!input || !list) return;

    const query = input.value.trim().toLowerCase();
    const matches = this.recentPaths.filter((p) => p.toLowerCase().includes(query));

    if (matches.length === 0) {
      this.hideCwdSuggestions();
      return;
    }

    this.cwdSuggestionIndex = -1;
    const folderIcon =
      '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
      'stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
      '<path d="M4 20a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h5l2 3h7a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2Z"/></svg>';

    list.innerHTML = matches
      .map(
        (p) =>
          `<li class="cwd-suggestion" role="option" data-path="${escapeAttr(p)}" title="${escapeAttr(p)}">` +
          `${folderIcon}<span class="cwd-suggestion-path">&lrm;${escapeHtml(p)}</span></li>`
      )
      .join('');

    list.querySelectorAll<HTMLLIElement>('.cwd-suggestion').forEach((el) => {
      // mousedown (not click) so it fires before the input's blur handler.
      el.addEventListener('mousedown', (e) => {
        e.preventDefault();
        this.selectCwdSuggestion(el.dataset.path ?? '');
      });
    });

    list.classList.remove('hidden');
    document.getElementById('cwd-toggle')?.classList.add('open');
  }

  hideCwdSuggestions(): void {
    const list = document.getElementById('cwd-suggestions');
    if (list) {
      list.classList.add('hidden');
      list.innerHTML = '';
    }
    document.getElementById('cwd-toggle')?.classList.remove('open');
    this.cwdSuggestionIndex = -1;
  }

  private selectCwdSuggestion(path: string): void {
    const input = document.getElementById('session-cwd-input') as HTMLInputElement | null;
    if (input && path) input.value = path;
    this.hideCwdSuggestions();
    void this.trackPicker.refresh();
    input?.focus();
  }

  handleCwdInputKeydown(e: KeyboardEvent): void {
    const list = document.getElementById('cwd-suggestions');
    const items = list && !list.classList.contains('hidden')
      ? Array.from(list.querySelectorAll<HTMLLIElement>('.cwd-suggestion'))
      : [];

    if (items.length > 0 && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
      e.preventDefault();
      const delta = e.key === 'ArrowDown' ? 1 : -1;
      this.cwdSuggestionIndex =
        (this.cwdSuggestionIndex + delta + items.length) % items.length;
      items.forEach((el, i) => el.classList.toggle('active', i === this.cwdSuggestionIndex));
      items[this.cwdSuggestionIndex].scrollIntoView({ block: 'nearest' });
      return;
    }

    if (e.key === 'Escape' && items.length > 0) {
      e.preventDefault();
      this.hideCwdSuggestions();
      return;
    }

    if (e.key === 'Enter') {
      if (this.cwdSuggestionIndex >= 0 && items[this.cwdSuggestionIndex]) {
        e.preventDefault();
        this.selectCwdSuggestion(items[this.cwdSuggestionIndex].dataset.path ?? '');
        return;
      }
      void this.createSessionFromModal();
    }
  }

  async createSessionFromModal(): Promise<void> {
    const nameInput = document.getElementById('session-name-input') as HTMLInputElement;
    const cwdInput = document.getElementById('session-cwd-input') as HTMLInputElement;

    let name = nameInput.value.trim() || undefined;
    let cwd = cwdInput.value.trim() || undefined;

    const picked = await this.trackPicker.resolve();
    if (picked === false) return; // the picker is showing why
    if (picked) {
      cwd = picked.worktreePath;
      name = name ?? picked.track;
    }

    this.host.createSession(name, cwd);
    this.hide();
  }
}
