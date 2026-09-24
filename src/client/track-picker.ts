import { escapeHtml, escapeAttr } from './html-utils.js';

/**
 * The Track picker in the New Session dialog.
 *
 * A session for a track runs in that track's worktree, so its work can later
 * be landed or deleted as a unit (docs/track-branches.md). "No track" is the
 * default: planning and unrelated sessions see no change, and the picker only
 * appears when the working directory is a board project that can branch.
 *
 * The one rule that matters: a list is only ever used for the directory it
 * was loaded for. Loading takes up to a second, and a list left showing while
 * the next one loads belongs to the previous directory — Create in that
 * window would open a session in another project's track.
 */

export interface PickedTrack {
  track: string;
  worktreePath: string;
}

export class TrackPicker {
  /** The board project the shown list belongs to, or null when hidden. */
  private project: string | null = null;
  /** The directory field's value that list was loaded for. */
  private loadedFor: string | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly root: Document = document) {}

  private get group(): HTMLElement | null {
    return this.root.getElementById('session-track-group');
  }
  private get select(): HTMLSelectElement | null {
    return this.root.getElementById('session-track-select') as HTMLSelectElement | null;
  }
  private get newName(): HTMLInputElement | null {
    return this.root.getElementById('session-track-new') as HTMLInputElement | null;
  }
  private get note(): HTMLElement | null {
    return this.root.getElementById('session-track-note');
  }
  private get cwdInput(): HTMLInputElement | null {
    return this.root.getElementById('session-cwd-input') as HTMLInputElement | null;
  }

  /** The directory field changed: hide the old list now, load the new one shortly. */
  schedule(delayMs = 250): void {
    this.hide();
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.refresh(), delayMs);
  }

  /** Load the list for whatever the directory field holds now. */
  async refresh(): Promise<void> {
    const group = this.group;
    const select = this.select;
    const input = this.cwdInput;
    if (!group || !select || !input) return;
    const cwd = input.value.trim();
    if (cwd !== this.loadedFor) this.hide();
    if (!cwd) return;

    try {
      const res = await fetch(`/api/projects/tracks?cwd=${encodeURIComponent(cwd)}`);
      // Not a board project (404) or no branching possible: no picker.
      if (!res.ok) return this.hide();
      const data = (await res.json()) as {
        cwd: string;
        canBranch: boolean;
        tracks: { name: string; branch: { name: string } | null }[];
      };
      if (input.value.trim() !== cwd) return; // typed on since this was asked
      if (!data.canBranch) return this.hide();

      select.innerHTML = [
        '<option value="">No track (planning or unrelated work)</option>',
        ...data.tracks.map(
          (t) =>
            `<option value="${escapeAttr(t.name)}">${escapeHtml(t.name)}${t.branch ? ' ⎇' : ''}</option>`
        ),
        '<option value="__new__">New track…</option>',
      ].join('');
      this.project = data.cwd;
      this.loadedFor = cwd;
      group.classList.remove('hidden');
      this.sync();
    } catch {
      this.hide();
    }
  }

  /** Show the name field for "New track…" and say where the session will run. */
  sync(): void {
    const select = this.select;
    const newName = this.newName;
    const note = this.note;
    if (!select || !newName || !note) return;
    const value = select.value;
    newName.classList.toggle('hidden', value !== '__new__');
    note.classList.remove('error');
    note.textContent = value
      ? 'Opens in the track’s own worktree, creating its branch on first use.'
      : 'Opens in the directory above.';
    if (value === '__new__') newName.focus();
  }

  hide(): void {
    this.group?.classList.add('hidden');
    this.project = null;
    this.loadedFor = null;
  }

  showError(message: string): void {
    const note = this.note;
    if (!note) return;
    note.textContent = message;
    note.classList.add('error');
  }

  /**
   * The track picked for the directory currently in the field, or null for "No
   * track" — including when the shown list was loaded for another directory.
   * `unnamed` is "New track…" with no name typed.
   */
  chosen(): string | null | 'unnamed' {
    if (!this.project) return null;
    if ((this.cwdInput?.value.trim() ?? '') !== this.loadedFor) return null;
    const value = this.select?.value ?? '';
    if (value === '__new__') return this.newName?.value.trim() || 'unnamed';
    return value || null;
  }

  /**
   * Resolve the pick into a worktree, creating the track's branch on first
   * use. null: no track, open in the typed directory. false: an error is
   * shown in the dialog and the session must not be created.
   */
  async resolve(): Promise<PickedTrack | null | false> {
    const track = this.chosen();
    if (track === null) return null;
    if (track === 'unnamed') {
      this.showError('Name the new track, or pick "No track".');
      return false;
    }
    try {
      const res = await fetch('/api/projects/track/branch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cwd: this.project, track }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        branch?: { worktreePath: string };
        error?: string;
      };
      if (!res.ok || !data.branch) {
        this.showError(data.error || `Could not branch the track (${res.status})`);
        return false;
      }
      return { track, worktreePath: data.branch.worktreePath };
    } catch (error) {
      this.showError(error instanceof Error ? error.message : 'Could not branch the track');
      return false;
    }
  }
}
