import { escapeHtml, escapeAttr } from './html-utils.js';

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
  features: { id: string; title: string; status: string }[];
  cancel: { id: string; title: string; status: string }[];
  discard: { id: string; title: string; status: string }[];
  branch: { name: string; worktreePath: string; uncommittedFiles: number; sessionsToClose: number } | null;
  currentBranch: string | null;
  merges: { sha: string; subject: string; via: 'track' | 'job' | 'message'; baseBranch: string }[];
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
  job: 'job merge',
  message: 'found by its merge message',
};

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** The dialog body for a plan. Pure, so it can be tested without a server. */
export function renderTrackDeletePlan(plan: TrackDeletePlan): string {
  const removed: string[] = [];
  if (plan.inDoc) {
    removed.push(
      `${plural(plan.features.length, 'feature line')} and the <code>## Track:</code> heading from PROJECT.md`
    );
  }
  if (plan.cancel.length > 0) {
    removed.push(
      `Cancel ${plural(plan.cancel.length, 'active job')}: ${plan.cancel.map((j) => escapeHtml(j.title)).join(', ')}`
    );
  }
  if (plan.discard.length > 0) {
    removed.push(`Discard ${plural(plan.discard.length, 'job')} and their worktrees`);
  }
  if (plan.branch) {
    const lost =
      plan.branch.uncommittedFiles > 0
        ? ` — <strong>${plural(plan.branch.uncommittedFiles, 'uncommitted file')} lost</strong>`
        : '';
    const closes =
      plan.branch.sessionsToClose > 0
        ? `; closes ${plural(plan.branch.sessionsToClose, 'open session')}`
        : '';
    removed.push(`Branch <code>${escapeHtml(plan.branch.name)}</code> and its worktree${lost}${closes}`);
  }
  if (plan.sessionLogGroup) removed.push('Its phase group in SESSION-LOG.md');

  const merges = plan.merges.length
    ? `<section class="td-section">
        <h4>Revert on ${escapeHtml(plan.currentBranch ?? 'the current branch')}</h4>
        ${plan.merges
          .map(
            (m) => `
          <label class="td-check">
            <input type="checkbox" class="td-revert" value="${escapeAttr(m.sha)}" checked>
            <span><code>${escapeHtml(m.sha.slice(0, 8))}</code> ${escapeHtml(m.subject)}
              <span class="td-muted">(${VIA_LABEL[m.via]})</span></span>
          </label>`
          )
          .join('')}
      </section>`
    : '';

  const unresolved = plan.unresolved.length
    ? `<section class="td-section">
        <h4>Revert by hand</h4>
        <ul>${plan.unresolved
          .map((u) => `<li>${escapeHtml(u.title)} — <span class="td-muted">${escapeHtml(u.reason)}</span></li>`)
          .join('')}</ul>
      </section>`
    : '';

  const specs = plan.specs.length
    ? `<section class="td-section">
        <h4>Specs</h4>
        ${plan.specs
          .map(
            (s) => `
          <label class="td-check${s.offered ? '' : ' disabled'}">
            <input type="checkbox" class="td-spec" value="${escapeAttr(s.path)}"
                   ${s.defaultDelete ? 'checked' : ''} ${s.offered ? '' : 'disabled'}>
            <span>Delete <code>${escapeHtml(s.path)}</code>
              <span class="td-muted">— ${escapeHtml(s.note)}</span></span>
          </label>`
          )
          .join('')}
      </section>`
    : '';

  const guessed =
    plan.guessedFiles.length || plan.guessedCommits.length
      ? `<section class="td-section">
        <h4>Guessed from this track’s sessions — unticked</h4>
        <p class="td-note">These look like this track’s work on main, going by what its sessions
          wrote. Tick only what you recognise.</p>
        ${plan.guessedFiles
          .map(
            (f) => `
          <label class="td-check">
            <input type="checkbox" class="td-restore" value="${escapeAttr(f.path)}">
            <span>Discard uncommitted <code>${escapeHtml(f.path)}</code>
              <span class="td-muted">(${escapeHtml(f.status)})</span></span>
          </label>`
          )
          .join('')}
        ${plan.guessedCommits
          .map(
            (c) => `
          <label class="td-check">
            <input type="checkbox" class="td-revert-guess" value="${escapeAttr(c.sha)}">
            <span>Revert <code>${escapeHtml(c.sha.slice(0, 8))}</code> ${escapeHtml(c.subject)}</span>
          </label>`
          )
          .join('')}
      </section>`
      : '';

  const unattributed = plan.unattributed
    ? `<p class="td-note">This track never had a branch, so code written for it on main can’t be
        told apart from other work, and this delete doesn’t touch it.${
          plan.unattributed.dirtyFiles > 0
            ? ` ${plural(plan.unattributed.dirtyFiles, 'file has', 'files have')} uncommitted changes on main.`
            : ''
        }</p>`
    : '';

  return `
    <section class="td-section">
      <h4>Removed</h4>
      <ul>${removed.map((r) => `<li>${r}</li>`).join('') || '<li>Nothing but the record of it</li>'}</ul>
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
  flash: (message: string) => void
): Promise<string | null> {
  let plan: TrackDeletePlan;
  try {
    const res = await fetch(
      `/api/projects/track/delete-plan?cwd=${encodeURIComponent(cwd)}&track=${encodeURIComponent(track)}`
    );
    const data = (await res.json().catch(() => ({}))) as { plan?: TrackDeletePlan; error?: string };
    if (!res.ok || !data.plan) {
      flash(data.error || `Could not plan the delete (${res.status})`);
      return null;
    }
    plan = data.plan;
  } catch (error) {
    flash(error instanceof Error ? error.message : 'Could not plan the delete');
    return null;
  }

  const modal = document.createElement('div');
  modal.className = 'modal td-modal';
  modal.innerHTML = `
    <div class="modal-content td-content" role="dialog" aria-modal="true" aria-labelledby="td-title">
      <h3 id="td-title">Delete track “${escapeHtml(track)}”?</h3>
      <div class="td-body">${renderTrackDeletePlan(plan)}</div>
      <div class="modal-actions">
        <button class="btn-secondary td-cancel">Cancel</button>
        <button class="btn-danger td-confirm">Delete track</button>
      </div>
    </div>`;
  document.body.appendChild(modal);

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
    modal.querySelector('.td-cancel')?.addEventListener('click', () => close(null));

    confirmBtn.addEventListener('click', async () => {
      confirmBtn.disabled = true;
      confirmBtn.textContent = 'Deleting…';
      try {
        const res = await fetch('/api/projects/track', {
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
        const data = (await res.json().catch(() => ({}))) as {
          detail?: string;
          error?: string;
          conflicts?: string[];
        };
        if (!res.ok) {
          const files = data.conflicts?.length ? ` Conflicting: ${data.conflicts.join(', ')}.` : '';
          errorEl.textContent = `${data.error || `Delete failed (${res.status})`}${files}`;
          confirmBtn.textContent = 'Delete track';
          // A stale plan can't be retried as-is; the user reopens it.
          confirmBtn.disabled = res.status === 409;
          return;
        }
        close(data.detail || `Deleted “${track}”.`);
      } catch (error) {
        errorEl.textContent = error instanceof Error ? error.message : 'Delete failed';
        confirmBtn.textContent = 'Delete track';
        confirmBtn.disabled = false;
      }
    });
  });
}
