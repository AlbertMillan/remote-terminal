import { html, raw, setHtml, type SafeHtml } from './html-utils.js';
import { TrackPicker } from './track-picker.js';

/** `session.create`'s folder to make first (sessions/folder-picker.ts). */
export interface CreateCwd {
  git: boolean;
  projectDoc: boolean;
}

export interface NewSessionModalHost {
  createSession(name?: string, cwd?: string, notice?: string, account?: string, createCwd?: CreateCwd): void;
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
export function accountOptionsHtml(data: AccountsResponse | null): SafeHtml {
  const def = data?.defaultAccount ?? 'personal';
  const options = [html`<option value="">Default (project's, else ${def})</option>`];
  for (const a of data?.accounts ?? []) {
    const note = a.ready ? '' : ' — not logged in as expected';
    options.push(html`<option value="${a.name}">${a.name}${note}</option>`);
  }
  return html`${options}`;
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

// --- Working Directory field: GET /api/paths/complete (sessions/folder-picker.ts) ---

export type FolderVerdict =
  | { kind: 'empty'; path: string; display: string }
  | { kind: 'exists'; path: string; display: string; project: string | null }
  | { kind: 'creatable'; path: string; display: string; existing: string; create: string[] }
  | { kind: 'refused'; reason: string };

export interface FolderItem {
  path: string;
  display: string;
  name: string;
  git: boolean;
  projectDoc: boolean;
  recent: boolean;
}

export interface FolderCompletion {
  mode: 'path' | 'search';
  items: FolderItem[];
  newFolder: { path: string; display: string } | null;
  verdict: FolderVerdict;
  home: string;
  defaultDisplay: string;
}

/** Separators as `/`, case folded: how two spellings of one path compare while typing. */
function fold(path: string): string {
  return path.replace(/\\/g, '/').toLowerCase();
}

/**
 * The grey rest of the top match after what is typed, or '' when there is none: path mode
 * only, and only when the match continues the text exactly (case and slashes aside). A full
 * path inside the home folder compares in its `~/…` form, the form matches are named in.
 */
export function ghostFor(value: string, completion: FolderCompletion | null): string {
  if (!value || !completion || completion.mode !== 'path') return '';
  const top = completion.items[0];
  const typed = tildeForm(value, completion.home);
  if (!top || !fold(top.display).startsWith(fold(typed))) return '';
  return `${top.display.slice(typed.length)}/`;
}

/** A pasted absolute path inside the home folder, as `~/…`; anything else unchanged. */
export function tildeForm(value: string, home: string): string {
  if (!home) return value;
  const h = fold(home).replace(/\/+$/, '');
  const v = fold(value);
  if (v !== h && !v.startsWith(`${h}/`)) return value;
  const rest = value.slice(home.replace(/[\\/]+$/, '').length).replace(/\\/g, '/');
  return `~${rest}`;
}

/** The last folder name in a path, for the session's default name. */
export function leafName(path: string): string {
  return path.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? '';
}

const CHECK_ICON = raw(
  '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" ' +
  'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="20 6 9 17 4 12"/></svg>'
);
const NEW_FOLDER_ICON = raw(
  '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" ' +
  'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
  '<path d="M4 20a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h5l2 3h7a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2Z"/>' +
  '<line x1="12" y1="11" x2="12" y2="17"/><line x1="9" y1="14" x2="15" y2="14"/></svg>'
);
const WARN_ICON = raw(
  '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" ' +
  'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
  '<path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/>' +
  '<line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>'
);

/** The hint under the field: what Create will do with what is typed. */
export function verdictHtml(verdict: FolderVerdict, create: CreateCwd): SafeHtml {
  switch (verdict.kind) {
    case 'empty':
      return html`<p class="cwd-hint">Empty opens in <code>${verdict.display}</code>. <kbd>Tab</kbd> fills it in; type a project name to search.</p>`;
    case 'exists':
      return html`<p class="cwd-hint cwd-hint-ok">${CHECK_ICON}<span>Existing folder${verdict.project && html` · project <strong>${verdict.project}</strong>`}</span></p>`;
    case 'creatable': {
      const n = verdict.create.length;
      const created = verdict.create.join('/');
      const base = verdict.display.slice(0, verdict.display.length - created.length);
      return html`<div class="cwd-verdict cwd-verdict-new"><div class="cwd-verdict-title">${NEW_FOLDER_ICON}<span>Creates ${n} new folder${n === 1 ? '' : 's'}</span></div><code class="cwd-verdict-path">${base}<span class="cwd-new-part">${created}</span></code><label class="cwd-option"><input type="checkbox" id="session-cwd-git"${create.git ? ' checked' : ''}>Initialize git in <code>${verdict.create[n - 1]}</code></label><label class="cwd-option"><input type="checkbox" id="session-cwd-doc"${create.projectDoc ? ' checked' : ''}>Add a starter <code>PROJECT.md</code></label></div>`;
    }
    case 'refused':
      return html`<div class="cwd-verdict cwd-verdict-refused" role="alert"><div class="cwd-verdict-title">${WARN_ICON}<span>Can't use this folder</span></div><span class="cwd-verdict-reason">${verdict.reason}</span></div>`;
  }
}

/** A dropdown row's id, for the input's `aria-activedescendant`. */
const optionId = (index: number): string => `cwd-opt-${index}`;

/** One dropdown row. `prefix` is bolded in path mode (what was typed of the name). */
function itemHtml(item: FolderItem, index: number, active: boolean, mode: 'path' | 'search', prefix: string): SafeHtml {
  const tags = html`${item.git && html`<span class="cwd-tag">git</span>`}${item.projectDoc && html`<span class="cwd-tag cwd-tag-doc">PROJECT.md</span>`}`;
  const n = mode === 'path' ? Math.min(prefix.length, item.name.length) : 0;
  const name = html`<strong>${item.name.slice(0, n)}</strong>${item.name.slice(n)}`;
  const sub = mode === 'search' ? html`<span class="cwd-item-path">&lrm;${item.display}</span>` : '';
  return html`<li class="cwd-suggestion${active ? ' active' : ''}" role="option" aria-selected="${String(active)}" id="${optionId(index)}" data-index="${index}" title="${item.path}"><span class="cwd-item-text"><span class="cwd-item-name">${name}</span>${sub}</span>${tags}</li>`;
}

/**
 * The "New Session" modal: name/cwd fields, the folder combobox (completion, project
 * search, create a missing folder) and the Track picker (track-picker.ts).
 */
export class NewSessionModal {
  /** The last answer for the folder field, and which one is current. */
  private completion: FolderCompletion | null = null;
  private folderSeq = 0;
  private folderTimer: number | null = null;
  /** Highlighted dropdown row; items first, then the "New folder" row. -1 = none. */
  private activeIndex = -1;
  private listOpen = false;
  /** The creatable box's checkboxes, kept across re-renders and keystrokes. */
  private createOptions: CreateCwd = { git: true, projectDoc: true };
  /** A Create is resolving its track (possibly installing); further ones are ignored. */
  private creating = false;
  /** The New Session dialog's Track picker (track-picker.ts). */
  readonly trackPicker = new TrackPicker();
  private defaultAccountTimer: number | null = null;
  /** Bumped per lookup, so a slow answer for an older folder never overwrites a newer one. */
  private defaultAccountSeq = 0;

  constructor(private readonly host: NewSessionModalHost) {}

  private get cwdInput(): HTMLInputElement | null {
    return document.getElementById('session-cwd-input') as HTMLInputElement | null;
  }

  show(prefillCwd?: string): void {
    const modal = document.getElementById('new-session-modal');
    if (modal) {
      modal.classList.remove('hidden');
      (document.getElementById('session-name-input') as HTMLInputElement).value = '';
      const input = this.cwdInput;
      if (input) input.value = prefillCwd ?? '';
      this.completion = null;
      this.createOptions = { git: true, projectDoc: true };
      this.hideCwdSuggestions();
      void this.refreshFolder();
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
    setHtml(select, accountOptionsHtml(data));
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
    const cwd = this.cwdInput?.value.trim() ?? '';
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

  // --- The folder field ---

  /** The field changed: a pasted home path reads as `~/…`, and the list follows shortly. */
  onCwdInput(e?: Event): void {
    const input = this.cwdInput;
    if (input && this.completion && (e as { inputType?: string } | undefined)?.inputType === 'insertFromPaste') {
      const tilde = tildeForm(input.value.trim(), this.completion.home);
      if (tilde !== input.value) input.value = tilde;
    }
    this.activeIndex = -1;
    this.listOpen = true;
    this.renderGhost();
    if (this.folderTimer !== null) window.clearTimeout(this.folderTimer);
    this.folderTimer = window.setTimeout(() => {
      this.folderTimer = null;
      void this.refreshFolder();
    }, 150);
  }

  /**
   * Ask the server about what the field holds now; an older answer never lands. `settle`
   * (Create) returns its own answer even when a newer one is on its way, since it is for
   * exactly the text Create sends; null only when the server could not answer.
   */
  private async refreshFolder(settle = false): Promise<FolderCompletion | null> {
    if (this.folderTimer !== null) {
      window.clearTimeout(this.folderTimer);
      this.folderTimer = null;
    }
    const seq = ++this.folderSeq;
    const q = this.cwdInput?.value ?? '';
    try {
      const res = await fetch(`/api/paths/complete?q=${encodeURIComponent(q)}`);
      if (!res.ok) return null;
      const data = (await res.json()) as FolderCompletion;
      if (seq !== this.folderSeq) return settle ? data : null;
      this.completion = data;
      this.renderFolder();
      return data;
    } catch {
      return null; // The field still works as plain text.
    }
  }

  private rowCount(): number {
    const c = this.completion;
    return c ? c.items.length + (c.newFolder ? 1 : 0) : 0;
  }

  /** Everything the folder answer drives: list, ghost, hint, name placeholder, button. */
  private renderFolder(): void {
    const c = this.completion;
    const input = this.cwdInput;
    if (!c || !input) return;
    input.placeholder = `${c.defaultDisplay}/`;

    const verdictEl = document.getElementById('session-cwd-verdict');
    if (verdictEl) setHtml(verdictEl, verdictHtml(c.verdict, this.createOptions));

    const nameInput = document.getElementById('session-name-input') as HTMLInputElement | null;
    const v = c.verdict;
    if (nameInput) nameInput.placeholder = v.kind === 'exists' || v.kind === 'creatable' ? leafName(v.path) : 'My Session';

    const confirm = document.getElementById('new-session-confirm') as HTMLButtonElement | null;
    if (confirm && !this.creating) {
      confirm.textContent = v.kind === 'creatable' ? 'Create folder & session' : 'Create';
      confirm.disabled = v.kind === 'refused';
    }
    this.renderList();
    this.renderGhost();
  }

  renderCwdSuggestions(): void {
    this.listOpen = true;
    this.renderList();
  }

  private renderList(): void {
    const list = document.getElementById('cwd-suggestions');
    const input = this.cwdInput;
    const c = this.completion;
    if (!list || !input) return;
    const focused = document.activeElement === input;
    if (!c || !this.listOpen || !focused || this.rowCount() === 0) {
      list.classList.add('hidden');
      list.innerHTML = '';
      input.setAttribute('aria-expanded', 'false');
      input.removeAttribute('aria-activedescendant');
      return;
    }

    const typed = input.value;
    const cut = Math.max(typed.lastIndexOf('/'), typed.lastIndexOf('\\'));
    const prefix = cut === -1 ? '' : typed.slice(cut + 1);
    const group = c.mode === 'path' ? `In ${typed.slice(0, cut + 1) || '~/'}` : typed.trim() ? 'Projects' : 'Recent';
    const rows = c.items.map((item, i) => itemHtml(item, i, i === this.activeIndex, c.mode, prefix));
    if (c.newFolder) {
      const i = c.items.length;
      rows.push(
        html`<li class="cwd-suggestion cwd-new-folder${i === this.activeIndex ? ' active' : ''}" role="option" aria-selected="${String(i === this.activeIndex)}" id="${optionId(i)}" data-index="${i}">${NEW_FOLDER_ICON}<span class="cwd-item-text"><span class="cwd-item-name">New folder <code>${c.newFolder.display}</code></span></span></li>`
      );
    }
    setHtml(
      list,
      html`${c.items.length > 0 && html`<li class="cwd-group" role="presentation">${group}</li>`}${rows}<li class="cwd-keys" role="presentation"><span><kbd>Tab</kbd> complete</span><span><kbd>↑↓</kbd> pick</span><span><kbd>Enter</kbd> create</span></li>`
    );

    list.querySelectorAll<HTMLLIElement>('.cwd-suggestion').forEach((el) => {
      // mousedown (not click) so it fires before the input's blur handler.
      el.addEventListener('mousedown', (e) => {
        e.preventDefault();
        this.pick(Number(el.dataset.index), false);
      });
    });
    list.classList.remove('hidden');
    input.setAttribute('aria-expanded', 'true');
    // Screen readers announce the highlighted row while focus stays in the field.
    if (this.activeIndex >= 0) input.setAttribute('aria-activedescendant', optionId(this.activeIndex));
    else input.removeAttribute('aria-activedescendant');
    list.querySelector('.cwd-suggestion.active')?.scrollIntoView({ block: 'nearest' });
  }

  /** The grey completion after the caret; hidden once the text no longer fits the field. */
  private renderGhost(): void {
    const input = this.cwdInput;
    const ghost = document.getElementById('session-cwd-ghost');
    if (!input || !ghost) return;
    const rest = this.activeIndex === -1 ? ghostFor(input.value, this.completion) : '';
    if (!rest || input.scrollWidth > input.clientWidth) {
      ghost.innerHTML = '';
      return;
    }
    const cs = window.getComputedStyle(input);
    ghost.style.font = cs.font;
    ghost.style.letterSpacing = cs.letterSpacing;
    ghost.style.paddingLeft = `${parseFloat(cs.paddingLeft) + parseFloat(cs.borderLeftWidth)}px`;
    setHtml(ghost, html`<span class="cwd-ghost-typed">${input.value}</span><span class="cwd-ghost-rest">${rest}</span>`);
  }

  hideCwdSuggestions(): void {
    this.listOpen = false;
    this.activeIndex = -1;
    const list = document.getElementById('cwd-suggestions');
    if (list) {
      list.classList.add('hidden');
      list.innerHTML = '';
    }
    this.cwdInput?.setAttribute('aria-expanded', 'false');
    this.cwdInput?.removeAttribute('aria-activedescendant');
  }

  /**
   * Put row `index` in the field. `descend` (Tab) adds a `/` to a folder so the next
   * answer lists what is inside it, as a shell does.
   */
  private pick(index: number, descend: boolean): void {
    const c = this.completion;
    const input = this.cwdInput;
    if (!c || !input) return;
    const item = c.items[index];
    if (item) input.value = descend ? `${item.display}/` : item.display;
    else if (c.newFolder && index === c.items.length) input.value = c.newFolder.display;
    else return;
    this.afterPick(input, descend);
  }

  private afterPick(input: HTMLInputElement, keepOpen: boolean): void {
    this.activeIndex = -1;
    if (keepOpen) this.listOpen = true;
    else this.hideCwdSuggestions();
    input.focus();
    input.setSelectionRange(input.value.length, input.value.length);
    this.renderGhost();
    void this.refreshFolder();
    void this.trackPicker.refresh();
    void this.refreshDefaultAccount();
  }

  /** Tab: fill the default folder, the highlighted row, or the ghost. Otherwise Tab moves on. */
  private complete(): boolean {
    const input = this.cwdInput;
    const c = this.completion;
    if (!input || !c) return false;
    if (!input.value.trim()) {
      input.value = `${c.defaultDisplay}/`;
      this.afterPick(input, true);
      return true;
    }
    if (this.activeIndex >= 0) {
      this.pick(this.activeIndex, this.activeIndex < c.items.length);
      return true;
    }
    if (ghostFor(input.value, c) || (c.mode === 'path' && c.items.length === 1)) {
      this.pick(0, true);
      return true;
    }
    return false;
  }

  handleCwdInputKeydown(e: KeyboardEvent): void {
    const count = this.listOpen ? this.rowCount() : 0;

    if (e.key === 'Tab' && !e.shiftKey) {
      if (this.complete()) e.preventDefault();
      return;
    }

    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      if (!this.listOpen) {
        this.renderCwdSuggestions();
        e.preventDefault();
        return;
      }
      if (count === 0) return;
      e.preventDefault();
      const delta = e.key === 'ArrowDown' ? 1 : -1;
      this.activeIndex =
        this.activeIndex === -1 && delta < 0 ? count - 1 : (this.activeIndex + delta + count) % count;
      this.renderList();
      this.renderGhost();
      return;
    }

    if (e.key === 'Escape' && this.listOpen && count > 0) {
      e.preventDefault();
      e.stopPropagation();
      this.hideCwdSuggestions();
      return;
    }

    if (e.key === 'Enter') {
      e.preventDefault();
      if (this.activeIndex >= 0 && this.activeIndex < count) {
        this.pick(this.activeIndex, false);
        return;
      }
      void this.createSessionFromModal();
    }
  }

  /** The creatable box's checkboxes; delegated, as the box is re-rendered. */
  onVerdictChange(e: Event): void {
    const t = e.target as HTMLInputElement | null;
    if (t?.id === 'session-cwd-git') this.createOptions = { ...this.createOptions, git: t.checked };
    if (t?.id === 'session-cwd-doc') this.createOptions = { ...this.createOptions, projectDoc: t.checked };
  }

  async createSessionFromModal(): Promise<void> {
    // Resolving a track can wait on a dependency install for tens of seconds;
    // a second Create meanwhile would open a second session.
    if (this.creating) return;
    const nameInput = document.getElementById('session-name-input') as HTMLInputElement;
    const cwdInput = document.getElementById('session-cwd-input') as HTMLInputElement;
    const account = (document.getElementById('session-account-select') as HTMLSelectElement | null)?.value || undefined;

    // Disabled as well as guarded, so the wait doesn't look like a dead button.
    const confirm = document.getElementById('new-session-confirm') as HTMLButtonElement | null;
    this.creating = true;
    if (confirm) confirm.disabled = true;
    let picked;
    let verdict: FolderVerdict | undefined;
    try {
      // A verdict for exactly what is sent, never the last one shown, which may be a keystroke
      // behind. Unanswered: neither blocked nor created here; the server judges the launch.
      verdict = (await this.refreshFolder(true))?.verdict;
      if (verdict?.kind === 'refused') return; // the box under the field says why
      picked = await this.trackPicker.resolve();
    } finally {
      this.creating = false;
      if (confirm) confirm.disabled = verdict?.kind === 'refused';
    }
    if (picked === false) return; // the picker is showing why

    let cwd = cwdInput.value.trim() || undefined;
    // An empty name is the folder's (its placeholder said so); the server names an empty field's.
    let name = nameInput.value.trim() || (cwd ? leafName(cwd) || undefined : undefined);
    const createCwd = verdict?.kind === 'creatable' && !picked ? { ...this.createOptions } : undefined;
    if (picked) {
      cwd = picked.worktreePath;
      name = nameInput.value.trim() || picked.track;
    }

    this.host.createSession(name, cwd, picked?.notice, account, createCwd);
    this.hide();
  }
}
