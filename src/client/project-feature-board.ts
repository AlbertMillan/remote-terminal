import { escapeHtml, escapeAttr } from './html-utils.js';
import type { GuessedFile } from './track-branch-now-dialog.js';
import type {
  Feature,
  FeatureStatus,
  QaDoc,
  WorkspaceProject,
  WorkspaceTrack,
} from './project-workspace.js';

/**
 * Pure rendering for a project's feature board: the QA card, the collapse-all
 * control, a track's heading and its feature rows, the orphan-branch list and
 * the add-feature form. Everything here is a function of its arguments —
 * `ProjectWorkspace` owns the state (collapsed tracks, in-flight specs, the
 * guessed unbranched work) and passes it in on every render.
 */

/** Per track: uncommitted files on main its sessions wrote, and commits they made. A guess. */
export type UnbranchedWork = Record<string, { files: GuessedFile[]; commits: number }>;

const STATUS_ICON: Record<FeatureStatus, string> = {
  pending: '○',
  in_progress: '◐',
  done: '✓',
  blocked: '!',
};

const STATUS_LABEL: Record<FeatureStatus, string> = {
  pending: 'Pending',
  in_progress: 'In progress',
  done: 'Done',
  blocked: 'Blocked',
};

/**
 * The project's QA contract. Shown even when absent, because "this project
 * has no definition of verified" is the single most useful thing the card can
 * tell you — a pipeline that skips QA silently is how unverified work reaches
 * a merge gate looking finished.
 */
export function renderQaCard(
  project: WorkspaceProject,
  doc: QaDoc | null | undefined,
  busy: boolean
): string {
  const cwd = escapeAttr(project.cwd);

  if (doc === undefined) return '';

  if (!doc || !doc.exists) {
    const verify = project.verify.length;
    return `
      <div class="pw-qa">
        <div class="pw-qa-head">
          <span class="pw-qa-title">QA</span>
          <span class="pw-qa-none">no QA doc</span>
        </div>
        <p class="pw-hint">
          ${
            verify > 0
              ? `Jobs will run the ${verify} verify command${verify === 1 ? '' : 's'} from PROJECT.md, but nothing else is checked.`
              : 'Nothing is automatically verified for this project. Jobs will reach the merge gate with QA skipped.'
          }
        </p>
        <button class="btn-secondary pw-qa-gen" data-cwd="${cwd}" ${busy ? 'disabled' : ''}>
          ${busy ? 'Drafting…' : 'Draft QA doc'}
        </button>
      </div>`;
  }

  const commands = doc.commands.length
    ? `<ul class="pw-qa-cmds">${doc.commands
        .map((c) => `<li><code>${escapeHtml(c)}</code></li>`)
        .join('')}</ul>`
    : '<p class="pw-hint">No commands declared.</p>';

  return `
    <div class="pw-qa">
      <div class="pw-qa-head">
        <span class="pw-qa-title">QA</span>
        <span class="pw-qa-driver ${doc.driver}">${escapeHtml(doc.driver)}</span>
        <code class="pw-qa-path">project/QA.md</code>
      </div>
      ${
        doc.driver === 'manual'
          ? '<p class="pw-qa-warn">Declared manual — automated QA is skipped and you verify before merging.</p>'
          : ''
      }
      ${commands}
    </div>`;
}

export function renderCollapseAll(project: WorkspaceProject, collapsedTracks: Set<string>): string {
  if (project.tracks.length < 2) return '';
  const allCollapsed = project.tracks.every((t) => isCollapsed(project.cwd, t.name, collapsedTracks));
  return `
    <button class="pw-collapse-all" data-cwd="${escapeAttr(project.cwd)}"
            title="${allCollapsed ? 'Expand' : 'Collapse'} every track">
      ${allCollapsed ? 'Expand all' : 'Collapse all'}
    </button>`;
}

export function renderProgress(project: WorkspaceProject): string {
  const { done, total, in_progress: active, blocked } = project.counts;
  const pct = total > 0 ? Math.round((done / total) * 100) : 0;
  const bits: string[] = [`${done}/${total} done`];
  if (active > 0) bits.push(`${active} in progress`);
  if (blocked > 0) bits.push(`${blocked} blocked`);
  return `
    <div class="pw-progress" title="${escapeAttr(bits.join(' · '))}">
      <div class="pw-progress-bar"><span style="width:${pct}%"></span></div>
      <span class="pw-progress-text">${escapeHtml(bits.join(' · '))}</span>
    </div>`;
}

export function renderNoIndex(
  project: WorkspaceProject,
  failure: string | undefined,
  busy: boolean
): string {
  const label = busy ? 'Generating…' : failure ? 'Retry' : 'Generate project index';
  return `
    <div class="pw-features">
      <div class="pw-empty-state">
        <p>This project has no <code>PROJECT.md</code> yet.</p>
        <p class="pw-hint">
          Generating one reads the project's existing plan and design docs and converts
          them into a feature list this board can edit directly. It runs once.
        </p>
        ${failure ? `<p class="pw-error">${escapeHtml(failure)}</p>` : ''}
        <button class="btn-primary pw-migrate" data-cwd="${escapeAttr(project.cwd)}" ${
          busy ? 'disabled' : ''
        }>${escapeHtml(label)}</button>
      </div>
    </div>`;
}

export function trackKey(cwd: string, track: string): string {
  return JSON.stringify([cwd, track]);
}

function isCollapsed(cwd: string, track: string, collapsedTracks: Set<string>): boolean {
  return collapsedTracks.has(trackKey(cwd, track));
}

export function renderTrack(
  project: WorkspaceProject,
  track: WorkspaceTrack,
  collapsedTracks: Set<string>,
  planning: Set<string>,
  unbranched: Map<string, UnbranchedWork | 'loading'>,
  specs: Map<string, string | null>
): string {
  const rows = track.features
    .map((f) => renderFeatureRow(project, track, f, specs))
    .join('');
  const done = track.features.filter((f) => f.status === 'done').length;
  const collapsed = isCollapsed(project.cwd, track.name, collapsedTracks);
  return `
    <div class="phase-group pw-track${collapsed ? ' collapsed' : ''}">
      <div class="phase-group-head pw-track-head" role="button" tabindex="0"
           aria-expanded="${collapsed ? 'false' : 'true'}"
           data-cwd="${escapeAttr(project.cwd)}" data-track="${escapeAttr(track.name)}">
        <span class="phase-chevron" aria-hidden="true">▾</span>
        <span class="phase-group-name">${escapeHtml(track.name)}</span>
        <span class="phase-progress">${done}/${track.features.length}</span>
        ${renderTrackActions(project, track, planning, unbranched)}
      </div>
      <ul class="phase-list">${rows}</ul>
    </div>`;
}

/**
 * Branch badge and the track's implementation actions, inside its heading.
 *
 * Open session is where a track's implementation starts: it creates the
 * track's branch on first use, so the session's work can later be landed or
 * deleted as a unit. Land appears only once there is a branch to land.
 */
export function renderTrackActions(
  project: WorkspaceProject,
  track: WorkspaceTrack,
  planning: Set<string>,
  unbranched: Map<string, UnbranchedWork | 'loading'>
): string {
  const cwd = escapeAttr(project.cwd);
  const name = escapeAttr(track.name);
  const loading = planning.has(`${project.cwd}|${track.name}`);
  const del = `<button class="pw-track-delete" data-cwd="${cwd}" data-track="${name}"
                       title="Delete this track: its lines, specs, jobs, branch and landed code"
                       ${loading ? 'disabled aria-busy="true"' : ''}>${loading ? 'Loading…' : 'Delete'}</button>`;
  if (!project.vcs.canDispatch) return `<span class="pw-track-actions">${del}</span>`;
  const badge = track.branch
    ? `<span class="pw-branch" title="${escapeAttr(track.branch.worktreePath)}">⎇ ${escapeHtml(
        track.branch.name
      )}</span>`
    : '';
  const work = track.branch ? undefined : unbranchedFor(unbranched, project.cwd, track.name);
  // Uncommitted files only — the one thing Branch now can move. Guessed
  // commits alone would badge every track with pre-branch history.
  const onMain = work?.files.length
    ? `<button class="pw-track-branchnow" data-cwd="${cwd}" data-track="${name}"
               title="This track's sessions changed files on main. Move them into a track branch so the work stays deletable.">⚠ ${
                 work.files.length
               } file${work.files.length === 1 ? '' : 's'} on main</button>`
    : '';
  const land = track.branch
    ? `<button class="pw-track-land" data-cwd="${cwd}" data-track="${name}"
               title="Merge this track into ${escapeAttr(track.branch.baseBranch)} and retire its worktree">Land</button>`
    : '';
  return `
    <span class="pw-track-actions">
      ${badge}
      ${onMain}
      <button class="pw-track-session" data-cwd="${cwd}" data-track="${name}"
              title="${track.branch ? 'Open a session in this track’s worktree' : 'Create this track’s branch and open a session in it'}">Open session</button>
      ${land}
      ${del}
    </span>`;
}

export function unbranchedFor(
  unbranched: Map<string, UnbranchedWork | 'loading'>,
  cwd: string,
  track: string
): UnbranchedWork[string] | undefined {
  const work = unbranched.get(cwd);
  return work && work !== 'loading' ? work[track] : undefined;
}

/**
 * Track branches whose heading is gone from PROJECT.md — renamed or removed
 * by hand. Listed so they can be deleted instead of silently left behind.
 */
export function renderOrphanBranches(project: WorkspaceProject): string {
  if (!project.orphanBranches?.length) return '';
  const cwd = escapeAttr(project.cwd);
  const rows = project.orphanBranches
    .map(
      (b) => `
      <li class="phase-item pw-orphan">
        <span class="phase-title">${escapeHtml(b.trackName)}</span>
        <span class="pw-branch" title="${escapeAttr(b.worktreePath)}">⎇ ${escapeHtml(b.branch)}</span>
        <button class="pw-track-delete" data-cwd="${cwd}" data-track="${escapeAttr(b.trackName)}"
                title="Delete this branch, its worktree and anything it landed">Delete</button>
      </li>`
    )
    .join('');
  return `
    <div class="phase-group pw-track pw-orphans">
      <div class="phase-group-head"><span class="phase-group-name">Branches with no matching track</span></div>
      <ul class="phase-list">${rows}</ul>
    </div>`;
}

export function renderFeatureRow(
  project: WorkspaceProject,
  track: WorkspaceTrack,
  f: Feature,
  specs: Map<string, string | null>
): string {
  const cwd = escapeAttr(project.cwd);
  const id = escapeAttr(f.id);
  return `
    <li class="phase-item pw-feature" data-feature="${id}">
      <button class="pw-status ${f.status}" data-cwd="${cwd}" data-id="${id}"
              title="${escapeAttr(STATUS_LABEL[f.status])} — click to change"
              aria-label="${escapeAttr(STATUS_LABEL[f.status])}">${STATUS_ICON[f.status]}</button>
      ${
        f.priority !== null
          ? `<span class="pw-priority p${f.priority}" title="Priority">P${f.priority}</span>`
          : ''
      }
      <span class="phase-title pw-title" data-cwd="${cwd}" data-id="${id}"
            title="Click to rename">${escapeHtml(f.title)}</span>
      ${
        f.spec
          ? `<button class="pw-spec" data-cwd="${cwd}" data-id="${id}"
                     title="${escapeAttr(f.spec)}">spec</button>`
          : ''
      }
      ${
        project.vcs.canDispatch
          ? `<button class="pw-dispatch" data-cwd="${cwd}" data-id="${id}"
                     data-title="${escapeAttr(f.title)}"
                     title="Dispatch this feature to the pipeline">▸</button>`
          : `<span class="pw-dispatch disabled" title="${escapeAttr(
              project.vcs.note || 'Dispatch unavailable'
            )}">▸</span>`
      }
      ${
        // A branched track's code sits on its branch: removing one line would
        // suggest that code went too. Delete the track instead.
        track.branch
          ? ''
          : `<button class="pw-delete" data-cwd="${cwd}" data-id="${id}"
              title="Remove this feature" aria-label="Remove">×</button>`
      }
      ${renderSpec(project, f, specs)}
    </li>`;
}

/**
 * A feature's spec, once its chip has been clicked.
 *
 * Shown as text rather than rendered markdown, exactly as the job board
 * shows a document: the client has no markdown renderer and this is not the
 * place to gain one.
 */
export function renderSpec(
  project: WorkspaceProject,
  f: Feature,
  specs: Map<string, string | null>
): string {
  const spec = specs.get(specKey(project.cwd, f.id));
  if (spec === undefined) return '';
  return spec
    ? `<pre class="pw-spec-body">${escapeHtml(spec)}</pre>`
    : `<div class="pw-hint pw-spec-body">Could not read ${escapeHtml(f.spec || 'the spec')}.</div>`;
}

export function specKey(cwd: string, featureId: string): string {
  return `${cwd}|${featureId}`;
}

export function renderAddRow(project: WorkspaceProject): string {
  const tracks = project.tracks.map((t) => t.name);
  const options = tracks
    .map((t) => `<option value="${escapeAttr(t)}">${escapeHtml(t)}</option>`)
    .join('');
  return `
    <form class="pw-add" data-cwd="${escapeAttr(project.cwd)}">
      <input type="text" class="pw-add-title" placeholder="Add a feature…" maxlength="200"
             aria-label="New feature title" />
      <select class="pw-add-priority" aria-label="Priority">
        <option value="">—</option>
        <option value="1">P1</option>
        <option value="2">P2</option>
        <option value="3">P3</option>
      </select>
      ${
        tracks.length > 1
          ? `<select class="pw-add-track" aria-label="Track">${options}</select>`
          : ''
      }
      <button type="submit" class="btn-secondary">Add</button>
    </form>`;
}
