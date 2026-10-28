import { escapeHtml, escapeAttr } from './html-utils.js';
import { TrackPicker } from './track-picker.js';

export interface NewSessionModalHost {
  createSession(name?: string, cwd?: string, notice?: string, account?: string): void;
}

/** GET /api/accounts: the accounts a session can run under (docs/accounts.md). */
export interface AccountsResponse {
  defaultAccount: string;
  accounts: { name: string; ready: boolean }[];
}

/**
 * The Account picker's options. The first, empty value lets the server pick: the
 * project's default account, else the configured one. An account whose folder
 * holds the wrong login is marked, and still pickable: picking it is refused with
 * Log in / Clean up.
 */
export function accountOptionsHtml(data: AccountsResponse | null): string {
  const def = data?.defaultAccount ?? 'personal';
  const options = [`<option value="">Default (project's, else ${escapeHtml(def)})</option>`];
  for (const a of data?.accounts ?? []) {
    const note = a.ready ? '' : ' — not logged in as expected';
    options.push(`<option value="${escapeAttr(a.name)}">${escapeHtml(a.name)}${note}</option>`);
  }
  return options.join('');
}

/** GET /api/accounts/resolve: what the empty option means for a folder. */
export interface ResolvedAccount {
  account: string;
  source: 'project' | 'default';
}

/** The empty option's label, naming the account it resolves to for the chosen folder. */
export function defaultAccountLabel(resolved: ResolvedAccount): string {
  return `Default (${resolved.account}${resolved.source === 'project' ? ', from project' : ''})`;
}

/**
 * The "New Session" modal: name/cwd fields, recent-path suggestions, and the
 * Track picker (track-picker.ts).
 */
export class NewSessionModal {
  // New-session "recent paths" dropdown state
  private recentPaths: string[] = [];
  private cwdSuggestionIndex = -1;
  /** A Create is resolving its track (possibly installing); further ones are ignored. */
  private creating = false;
  /** The New Session dialog's Track picker (track-picker.ts). */
  readonly trackPicker = new TrackPicker();
  private defaultAccountTimer: number | null = null;
  /** Bumped per lookup, so a slow answer for an older folder never overwrites a newer one. */
  private defaultAccountSeq = 0;

  constructor(private readonly host: NewSessionModalHost) {}

  show(prefillCwd?: string): void {
    const modal = document.getElementById('new-session-modal');
    if (modal) {
      modal.classList.remove('hidden');
      (document.getElementById('session-name-input') as HTMLInputElement).value = '';
      (document.getElementById('session-cwd-input') as HTMLInputElement).value = prefillCwd ?? '';
      this.hideCwdSuggestions();
      void this.loadRecentPaths();
      void this.loadAccounts();
      void this.trackPicker.refresh();
      document.getElementById('session-name-input')?.focus();
    }
  }

  hide(): void {
    document.getElementById('new-session-modal')?.classList.add('hidden');
    this.hideCwdSuggestions();
  }

  private async loadAccounts(): Promise<void> {
    const select = document.getElementById('session-account-select') as HTMLSelectElement | null;
    if (!select) return;
    let data: AccountsResponse | null = null;
    try {
      const res = await fetch('/api/accounts');
      if (res.ok) data = (await res.json()) as AccountsResponse;
    } catch {
      // The server's default still applies: the picker offers only that.
    }
    select.innerHTML = accountOptionsHtml(data);
    select.value = '';
    void this.refreshDefaultAccount();
  }

  /** Re-label the Default option once typing in the folder field pauses. */
  scheduleDefaultAccount(): void {
    if (this.defaultAccountTimer !== null) window.clearTimeout(this.defaultAccountTimer);
    this.defaultAccountTimer = window.setTimeout(() => {
      this.defaultAccountTimer = null;
      void this.refreshDefaultAccount();
    }, 300);
  }

  /**
   * Name what Default resolves to for the folder in the field: its project's
   * account, else the configured one. On failure the generic label stays.
   */
  private async refreshDefaultAccount(): Promise<void> {
    const seq = ++this.defaultAccountSeq;
    const cwd = (document.getElementById('session-cwd-input') as HTMLInputElement | null)?.value.trim() ?? '';
    let resolved: ResolvedAccount | null = null;
    try {
      const res = await fetch(`/api/accounts/resolve?cwd=${encodeURIComponent(cwd)}`);
      if (res.ok) resolved = (await res.json()) as ResolvedAccount;
    } catch {
      // Keep the label accountOptionsHtml gave it.
    }
    if (seq !== this.defaultAccountSeq || !resolved) return;
    const option = (document.getElementById('session-account-select') as HTMLSelectElement | null)?.options[0];
    if (option && option.value === '') option.textContent = defaultAccountLabel(resolved);
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
    void this.refreshDefaultAccount();
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
    // Resolving a track can wait on a dependency install for tens of seconds;
    // a second Create meanwhile would open a second session.
    if (this.creating) return;
    const nameInput = document.getElementById('session-name-input') as HTMLInputElement;
    const cwdInput = document.getElementById('session-cwd-input') as HTMLInputElement;

    let name = nameInput.value.trim() || undefined;
    let cwd = cwdInput.value.trim() || undefined;
    const account = (document.getElementById('session-account-select') as HTMLSelectElement | null)?.value || undefined;

    // Disabled as well as guarded, so the wait doesn't look like a dead button.
    const confirm = document.getElementById('new-session-confirm') as HTMLButtonElement | null;
    this.creating = true;
    if (confirm) confirm.disabled = true;
    let picked;
    try {
      picked = await this.trackPicker.resolve();
    } finally {
      this.creating = false;
      if (confirm) confirm.disabled = false;
    }
    if (picked === false) return; // the picker is showing why
    if (picked) {
      cwd = picked.worktreePath;
      name = name ?? picked.track;
    }

    this.host.createSession(name, cwd, picked?.notice, account);
    this.hide();
  }
}
