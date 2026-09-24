import { escapeHtml, escapeAttr } from './html-utils.js';

/**
 * Branch now: move a track's uncommitted work off main into a new track branch.
 *
 * The file list is the server's GUESS from the track's sessions, so every file
 * starts ticked but the list must be read and confirmed: untick anything that
 * isn't this track's. Commits already on main are not moved (that would rewrite
 * main); Delete track offers them, unticked.
 */

export interface GuessedFile {
  path: string;
  status: string;
}

export function renderBranchNowBody(files: GuessedFile[], commits: number): string {
  const rows = files
    .map(
      (f) => `
      <label class="td-check">
        <input type="checkbox" class="bn-file" value="${escapeAttr(f.path)}" checked>
        <span><code>${escapeHtml(f.path)}</code> <span class="td-muted">(${escapeHtml(f.status)})</span></span>
      </label>`
    )
    .join('');
  const commitNote =
    commits > 0
      ? `<p class="td-note">${commits === 1 ? '1 commit' : `${commits} commits`} on main also look like this
         track’s. They stay where they are — Delete track offers them, unticked.</p>`
      : '';
  return `
    <p class="td-note">Guessed from the files this track’s sessions wrote in the main checkout.
      Untick anything that isn’t this track’s. The ticked files move into a new track worktree
      and are restored on main.</p>
    <section class="td-section"><h4>Move</h4>${rows}</section>
    ${commitNote}
    <p class="td-error"></p>`;
}

/** Resolves with the server's summary once moved, or null if backed out. */
export function openBranchNowDialog(
  cwd: string,
  track: string,
  files: GuessedFile[],
  commits: number
): Promise<string | null> {
  const modal = document.createElement('div');
  modal.className = 'modal td-modal bn-modal';
  modal.innerHTML = `
    <div class="modal-content td-content" role="dialog" aria-modal="true" aria-labelledby="bn-title">
      <h3 id="bn-title">Move “${escapeHtml(track)}” off main?</h3>
      <div class="td-body">${renderBranchNowBody(files, commits)}</div>
      <div class="modal-actions">
        <button class="btn-secondary bn-cancel">Cancel</button>
        <button class="btn-primary bn-confirm">Move to a track branch</button>
      </div>
    </div>`;
  document.body.appendChild(modal);

  const confirmBtn = modal.querySelector('.bn-confirm') as HTMLButtonElement;
  const errorEl = modal.querySelector('.td-error') as HTMLElement;
  const ticked = (): string[] =>
    [...modal.querySelectorAll<HTMLInputElement>('input.bn-file:checked')].map((i) => i.value);
  modal.addEventListener('change', () => {
    confirmBtn.disabled = ticked().length === 0;
  });

  return new Promise((resolve) => {
    const close = (result: string | null): void => {
      modal.remove();
      document.removeEventListener('keydown', onKey);
      resolve(result);
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') close(null);
    };
    document.addEventListener('keydown', onKey);
    modal.querySelector('.bn-cancel')?.addEventListener('click', () => close(null));

    confirmBtn.addEventListener('click', async () => {
      confirmBtn.disabled = true;
      try {
        const res = await fetch('/api/projects/track/branch-now', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ cwd, track, files: ticked() }),
        });
        const data = (await res.json().catch(() => ({}))) as {
          moved?: string[];
          branch?: { branch: string };
          error?: string;
        };
        if (!res.ok || !data.moved) {
          errorEl.textContent = data.error || `Could not move the files (${res.status})`;
          confirmBtn.disabled = false;
          return;
        }
        close(
          `Moved ${data.moved.length === 1 ? '1 file' : `${data.moved.length} files`} to ${data.branch?.branch ?? 'the track branch'}.`
        );
      } catch (error) {
        errorEl.textContent = error instanceof Error ? error.message : 'Could not move the files';
        confirmBtn.disabled = false;
      }
    });
  });
}
