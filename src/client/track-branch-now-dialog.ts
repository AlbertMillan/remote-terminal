import { html, type SafeHtml } from './html-utils.js';
import { failureMessage, requestJson } from './api.js';
import { openDialog } from './dialog.js';
import { jsonPost } from './job-board-types.js';

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

export function renderBranchNowBody(files: GuessedFile[], commits: number): SafeHtml {
  const rows = files.map(
    (f) => html`
      <label class="td-check">
        <input type="checkbox" class="bn-file" value="${f.path}" checked>
        <span><code>${f.path}</code> <span class="td-muted">(${f.status})</span></span>
      </label>`
  );
  const commitNote =
    commits > 0
      ? html`<p class="td-note">${commits === 1 ? '1 commit' : `${commits} commits`} on main also look like this
         track’s. They stay where they are — Delete track offers them, unticked.</p>`
      : '';
  return html`
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
  const { modal, close, closed } = openDialog<string | null>(
    'td-modal bn-modal',
    html`
    <div class="modal-content td-content" role="dialog" aria-modal="true" aria-labelledby="bn-title">
      <h3 id="bn-title">Move “${track}” off main?</h3>
      <div class="td-body">${renderBranchNowBody(files, commits)}</div>
      <div class="modal-actions">
        <button class="btn-secondary bn-cancel" data-cancel>Cancel</button>
        <button class="btn-primary bn-confirm">Move to a track branch</button>
      </div>
    </div>`,
    null
  );

  const confirmBtn = modal.querySelector('.bn-confirm') as HTMLButtonElement;
  const errorEl = modal.querySelector('.td-error') as HTMLElement;
  const ticked = (): string[] =>
    [...modal.querySelectorAll<HTMLInputElement>('input.bn-file:checked')].map((i) => i.value);
  modal.addEventListener('change', () => {
    confirmBtn.disabled = ticked().length === 0;
  });

  confirmBtn.addEventListener('click', async () => {
    confirmBtn.disabled = true;
    const result = await requestJson<{ moved?: string[]; branch?: { branch: string } }>(
      '/api/projects/track/branch-now',
      jsonPost({ cwd, track, files: ticked() })
    );
    const moved = result.data.moved;
    if (!result.ok || !moved) {
      errorEl.textContent = failureMessage(result, 'Could not move the files');
      confirmBtn.disabled = false;
      return;
    }
    close(
      `Moved ${moved.length === 1 ? '1 file' : `${moved.length} files`} to ${result.data.branch?.branch ?? 'the track branch'}.`
    );
  });
  return closed;
}
