import { html, joinHtml, type SafeHtml } from './html-utils.js';
import { failureMessage, requestJson } from './api.js';
import { openDialog } from './dialog.js';

/**
 * The Delete track confirm dialog.
 *
 * It shows the server's plan (`GET /api/projects/track/delete-plan`) before
 * anything happens, lets the user untick merges to revert and specs to delete,
 * and sends the plan's token back so a delete never acts on a plan that has
 * gone stale. Never a bare confirm(): the point is to show what goes.
 */

export interface TrackDeletePlan {
  token: string;
  track: string;
  inDoc: boolean;
  /** Feature lines in main's section; an in-progress track's own go with its branch. */
  mainLines?: number;
  features: { id: string; title: string; status: string }[];
  /** The track's live factory units, cancelled before anything is reverted. */
  cancel: { featureId: string; unitId: string; title: string; status: string }[];
  branch: { name: string; worktreePath: string; uncommittedFiles: number; sessionsToClose: number } | null;
  currentBranch: string | null;
  merges: { sha: string; subject: string; via: 'track' | 'job' | 'trailer' | 'message'; baseBranch: string }[];
  unresolved: { title: string; reason: string }[];
  specs: {
    path: string;
    state: string;
    defaultDelete: boolean;
    offered: boolean;
    note: string;
    referencedBy: string[];
  }[];
  sessionLogGroup: boolean;
  mainDirty: string[];
  /** A guess from the track's sessions: always offered unticked. */
  guessedFiles: { path: string; status: string }[];
  guessedCommits: { sha: string; subject: string }[];
  unattributed: { dirtyFiles: number } | null;
}

const VIA_LABEL: Record<TrackDeletePlan['merges'][number]['via'], string> = {
  track: 'track land',
  job: 'old job merge',
  trailer: 'found by its recorded feature or job id',
  message: 'found by its merge message',
};

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** The dialog body for a plan. Pure, so it can be tested without a server. */
export function renderTrackDeletePlan(plan: TrackDeletePlan): SafeHtml {
  const removed: SafeHtml[] = [];
  if (plan.inDoc) {
    removed.push(
      html`${plural(plan.mainLines ?? plan.features.length, 'feature line')} and the <code>## Track:</code> heading from PROJECT.md`
    );
  }
  if (plan.cancel.length > 0) {
    removed.push(
      html`Cancel ${plural(plan.cancel.length, 'factory unit')}: ${joinHtml(
        plan.cancel.map((u) => u.title),
        ', '
      )}`
    );
  }
  if (plan.branch) {
    const lost =
      plan.branch.uncommittedFiles > 0
        ? html` — <strong>${plural(plan.branch.uncommittedFiles, 'uncommitted file')} lost</strong>`
        : '';
    const closes =
      plan.branch.sessionsToClose > 0
        ? `; closes ${plural(plan.branch.sessionsToClose, 'open session')}`
        : '';
    const lines =
      plan.features.length > (plan.mainLines ?? plan.features.length)
        ? ', with the track’s plan (its feature lines and specs live on the branch)'
        : '';
    removed.push(html`Branch <code>${plan.branch.name}</code> and its worktree${lines}${lost}${closes}`);
  }
  if (plan.sessionLogGroup) removed.push(html`Its phase group in SESSION-LOG.md`);

  const merges = plan.merges.length
    ? html`<section class="td-section">
        <h4>Revert on ${plan.currentBranch ?? 'the current branch'}</h4>
        ${plan.merges.map(
          (m) => html`
          <label class="td-check">
            <input type="checkbox" class="td-revert" value="${m.sha}" checked>
            <span><code>${m.sha.slice(0, 8)}</code> ${m.subject}
              <span class="td-muted">(${VIA_LABEL[m.via]})</span></span>
          </label>`
        )}
      </section>`
    : '';

  const unresolved = plan.unresolved.length
    ? html`<section class="td-section">
        <h4>Revert by hand</h4>
        <ul>${plan.unresolved.map((u) => html`<li>${u.title} — <span class="td-muted">${u.reason}</span></li>`)}</ul>
      </section>`
    : '';

  const specs = plan.specs.length
    ? html`<section class="td-section">
        <h4>Specs</h4>
        ${plan.specs.map(
          (s) => html`
          <label class="td-check${s.offered ? '' : ' disabled'}">
            <input type="checkbox" class="td-spec" value="${s.path}"
                   ${s.defaultDelete ? 'checked' : ''} ${s.offered ? '' : 'disabled'}>
            <span>Delete <code>${s.path}</code>
              <span class="td-muted">— ${s.note}</span></span>
          </label>`
        )}
      </section>`
    : '';

  const guessed =
    plan.guessedFiles.length || plan.guessedCommits.length
      ? html`<section class="td-section">
        <h4>Guessed from this track’s sessions — unticked</h4>
        <p class="td-note">These look like this track’s work on main, going by what its sessions
          wrote. Tick only what you recognise.</p>
        ${plan.guessedFiles.map(
          (f) => html`
          <label class="td-check">
            <input type="checkbox" class="td-restore" value="${f.path}">
            <span>Discard uncommitted <code>${f.path}</code>
              <span class="td-muted">(${f.status})</span></span>
          </label>`
        )}
        ${plan.guessedCommits.map(
          (c) => html`
          <label class="td-check">
            <input type="checkbox" class="td-revert-guess" value="${c.sha}">
            <span>Revert <code>${c.sha.slice(0, 8)}</code> ${c.subject}</span>
          </label>`
        )}
      </section>`
      : '';

  const unattributed = plan.unattributed
    ? html`<p class="td-note">This track never had a branch, so ${
        plan.guessedFiles.length || plan.guessedCommits.length
          ? 'apart from the guesses above, code written for it on main'
          : 'code written for it on main'
      } can’t be told apart from other work, and this delete doesn’t touch it.${
          plan.unattributed.dirtyFiles > 0
            ? ` ${plural(plan.unattributed.dirtyFiles, 'file has', 'files have')} uncommitted changes on main.`
            : ''
        }</p>`
    : '';

  return html`
    <section class="td-section">
      <h4>Removed</h4>
      <ul>${removed.length ? removed.map((r) => html`<li>${r}</li>`) : html`<li>Nothing but the record of it</li>`}</ul>
    </section>
    ${merges}${unresolved}${specs}${guessed}${unattributed}
    <p class="td-commit"></p>
    <p class="td-error"></p>`;
}

/**
 * What the ticked boxes mean, and whether Delete may be pressed. Reverting
 * needs a clean main checkout, so ticking a revert with uncommitted files there
 * disables the button and says why, rather than letting the server refuse.
 */
export function describeChoice(
  plan: TrackDeletePlan,
  revertCount: number,
  restoring: string[] = []
): { commit: string; error: string | null } {
  // Ticked guessed files are discarded as part of the delete, so they don't block.
  const blocking = plan.mainDirty.filter((p) => !restoring.includes(p.replace(/\\/g, '/')));
  if (revertCount > 0 && blocking.length > 0) {
    return {
      commit: '',
      error: `Reverting needs a clean checkout. Commit or stash these first: ${blocking.join(', ')}`,
    };
  }
  return {
    commit:
      revertCount > 0
        ? `One commit, “Delete track: ${plan.track}”, holds the ${plural(revertCount, 'revert')} and the file changes. It is not pushed.`
        : 'The file changes are left uncommitted.',
    error: null,
  };
}

/**
 * Fetch the plan, show it, and delete on confirm. Resolves with the server's
 * summary once deleted, or null if the user backed out or it failed to load.
 */
export async function openTrackDeleteDialog(
  cwd: string,
  track: string,
  flash: (message: string) => void,
  /** Called once the plan has loaded (or failed to): the caller's loading state ends here. */
  onPlanned: () => void = () => {}
): Promise<string | null> {
  const planned = await requestJson<{ plan?: TrackDeletePlan }>(
    `/api/projects/track/delete-plan?cwd=${encodeURIComponent(cwd)}&track=${encodeURIComponent(track)}`
  );
  onPlanned();
  const plan = planned.data.plan;
  if (!planned.ok || !plan) {
    flash(failureMessage(planned, 'Could not plan the delete'));
    return null;
  }

  const { modal, close, closed } = openDialog<string | null>(
    'td-modal',
    html`
    <div class="modal-content td-content" role="dialog" aria-modal="true" aria-labelledby="td-title">
      <h3 id="td-title">Delete track “${track}”?</h3>
      <div class="td-body">${renderTrackDeletePlan(plan)}</div>
      <div class="modal-actions">
        <button class="btn-secondary td-cancel" data-cancel>Cancel</button>
        <button class="btn-danger td-confirm">Delete track</button>
      </div>
    </div>`,
    null
  );

  const confirmBtn = modal.querySelector('.td-confirm') as HTMLButtonElement;
  const errorEl = modal.querySelector('.td-error') as HTMLElement;
  const ticked = (cls: string): string[] =>
    [...modal.querySelectorAll<HTMLInputElement>(`input.${cls}:checked`)].map((i) => i.value);
  const refresh = (): void => {
    const { commit, error } = describeChoice(
      plan,
      ticked('td-revert').length + ticked('td-revert-guess').length,
      ticked('td-restore')
    );
    (modal.querySelector('.td-commit') as HTMLElement).textContent = commit;
    errorEl.textContent = error ?? '';
    confirmBtn.disabled = error !== null;
  };
  refresh();
  modal.addEventListener('change', refresh);

  confirmBtn.addEventListener('click', async () => {
    confirmBtn.disabled = true;
    confirmBtn.textContent = 'Deleting…';
    const result = await requestJson<{ detail?: string; conflicts?: string[] }>('/api/projects/track', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        cwd,
        track,
        token: plan.token,
        revert: ticked('td-revert'),
        deleteSpecs: ticked('td-spec'),
        restoreFiles: ticked('td-restore'),
        revertGuessed: ticked('td-revert-guess'),
      }),
    });
    if (!result.ok) {
      const conflicts = result.data.conflicts;
      const files = conflicts?.length ? ` Conflicting: ${conflicts.join(', ')}.` : '';
      errorEl.textContent = `${failureMessage(result, 'Delete failed')}${files}`;
      confirmBtn.textContent = 'Delete track';
      // A stale plan can't be retried as-is; the user reopens it.
      confirmBtn.disabled = result.status === 409;
      return;
    }
    close(result.data.detail || `Deleted “${track}”.`);
  });
  return closed;
}
