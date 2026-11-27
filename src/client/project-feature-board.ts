import { html, type SafeHtml } from './html-utils.js';
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
): SafeHtml {
  const cwd = project.cwd;

  if (doc === undefined) return html``;

  if (!doc || !doc.exists) {
    const verify = project.verify.length;
    return html`
      <div class="pw-qa">
        <div class="pw-qa-head">
          <span class="pw-qa-title">QA</span>
          <span class="pw-qa-none">no QA doc</span>
        </div>
        <p class="pw-hint">
          ${
            verify > 0
              ? `The factory will run the ${verify} verify command${verify === 1 ? '' : 's'} from PROJECT.md, but nothing else is checked.`
              : 'Nothing is automatically verified for this project: the factory merges what its reviewer passes.'
          }
        </p>
        <button class="btn-secondary pw-qa-gen" data-cwd="${cwd}" ${busy ? 'disabled' : ''}>
          ${busy ? 'Drafting…' : 'Draft QA doc'}
        </button>
      </div>`;
  }

  const commands = doc.commands.length
    ? html`<ul class="pw-qa-cmds">${doc.commands.map((c) => html`<li><code>${c}</code></li>`)}</ul>`
    : html`<p class="pw-hint">No commands declared.</p>`;

  return html`
    <div class="pw-qa">
      <div class="pw-qa-head">
        <span class="pw-qa-title">QA</span>
        <span class="pw-qa-driver ${doc.driver}">${doc.driver}</span>
        <code class="pw-qa-path">project/QA.md</code>
      </div>
      ${
        doc.driver === 'manual' &&
        html`<p class="pw-qa-warn">Declared manual — automated QA is skipped and you verify before merging.</p>`
      }
      ${commands}
    </div>`;
}

export function renderCollapseAll(project: WorkspaceProject, collapsedTracks: Set<string>): SafeHtml {
  if (project.tracks.length < 2) return html``;
  const allCollapsed = project.tracks.every((t) => isCollapsed(project.cwd, t.name, collapsedTracks));
  return html`
    <button class="pw-collapse-all" data-cwd="${project.cwd}"
            title="${allCollapsed ? 'Expand' : 'Collapse'} every track">
      ${allCollapsed ? 'Expand all' : 'Collapse all'}
    </button>`;
}

export function renderProgress(project: WorkspaceProject): SafeHtml {
  const { done, total, in_progress: active, blocked } = project.counts;
  const pct = total > 0 ? Math.round((done / total) * 100) : 0;
  const bits: string[] = [`${done}/${total} done`];
  if (active > 0) bits.push(`${active} in progress`);
  if (blocked > 0) bits.push(`${blocked} blocked`);
  return html`
    <div class="pw-progress" title="${bits.join(' · ')}">
      <div class="pw-progress-bar"><span style="width:${pct}%"></span></div>
      <span class="pw-progress-text">${bits.join(' · ')}</span>
    </div>`;
}

export function renderNoIndex(
  project: WorkspaceProject,
  failure: string | undefined,
  busy: boolean
): SafeHtml {
  const label = busy ? 'Generating…' : failure ? 'Retry' : 'Generate project index';
  return html`
    <div class="pw-features">
      <div class="pw-empty-state">
        <p>This project has no <code>PROJECT.md</code> yet.</p>
        <p class="pw-hint">
          Generating one reads the project's existing plan and design docs and converts
          them into a feature list this board can edit directly. It runs once.
        </p>
        ${failure && html`<p class="pw-error">${failure}</p>`}
        <button class="btn-primary pw-migrate" data-cwd="${project.cwd}" ${
          busy ? 'disabled' : ''
        }>${label}</button>
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
): SafeHtml {
  const rows = track.features.map((f) => renderFeatureRow(project, track, f, specs));
  const done = track.features.filter((f) => f.status === 'done').length;
  const collapsed = isCollapsed(project.cwd, track.name, collapsedTracks);
  return html`
    <div class="phase-group pw-track${collapsed ? ' collapsed' : ''}">
      <div class="phase-group-head pw-track-head" role="button" tabindex="0"
           aria-expanded="${collapsed ? 'false' : 'true'}"
           data-cwd="${project.cwd}" data-track="${track.name}">
        <span class="phase-chevron" aria-hidden="true">▾</span>
        <span class="phase-group-name">${track.name}</span>
        <span class="phase-progress">${done}/${track.features.length}</span>
        ${renderTrackActions(project, track, planning, unbranched)}
      </div>
      <ul class="phase-list">${track.planMissing && renderPlanMissing(track)}${rows}</ul>
    </div>`;
}

/**
 * A branched track whose worktree has no section. Shown empty with this note,
 * never filled from main's copy, which stopped being this track's plan when
 * the branch was created.
 */
function renderPlanMissing(track: WorkspaceTrack): SafeHtml {
  // A missing folder reads as a missing section too. Say which it is, since
  // the fix differs: the branch still holds the plan, and Open session
  // re-creates the folder from it.
  if (track.worktreeMissing) {
    return html`<li class="phase-item pw-plan-missing">⚠ This track’s worktree folder is missing. Its plan is still on the branch — Open session re-creates the folder.</li>`;
  }
  const hint = track.alsoOnMain
    ? 'Main still has lines for it — Move into branch takes them over.'
    : 'Add features here, or write the section in the worktree’s PROJECT.md.';
  return html`<li class="phase-item pw-plan-missing">⚠ This track’s worktree has no <code>## Track:</code> section. ${hint}</li>`;
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
): SafeHtml {
  const cwd = project.cwd;
  const name = track.name;
  const loading = planning.has(`${project.cwd}|${track.name}`);
  const del = html`<button class="pw-track-delete" data-cwd="${cwd}" data-track="${name}"
                       title="Delete this track: its lines, specs, factory work, branch and landed code"
                       ${loading ? 'disabled aria-busy="true"' : ''}>${loading ? 'Loading…' : 'Delete'}</button>`;
  if (!project.vcs.canDispatch) return html`<span class="pw-track-actions">${del}</span>`;
  const badge = track.branch
    ? html`<span class="pw-branch" title="${track.branch.worktreePath}">⎇ ${track.branch.name}</span>`
    : '';
  const work = track.branch ? undefined : unbranchedFor(unbranched, project.cwd, track.name);
  // Uncommitted files only — the one thing Branch now can move. Guessed
  // commits alone would badge every track with pre-branch history.
  const onMain = work?.files.length
    ? html`<button class="pw-track-branchnow" data-cwd="${cwd}" data-track="${name}"
               title="This track's sessions changed files on main. Move them into a track branch so the work stays deletable.">⚠ ${
                 work.files.length
               } file${work.files.length === 1 ? '' : 's'} on main</button>`
    : '';
  // Lines written on main after the track branched: its plan lives in the
  // worktree now, so offer to move them there (Land would merge them anyway).
  const alsoOnMain =
    track.branch && track.alsoOnMain
      ? html`<button class="pw-track-moveinto" data-cwd="${cwd}" data-track="${name}"
               title="Main's PROJECT.md also has ${track.alsoOnMain} line${track.alsoOnMain === 1 ? '' : 's'} for this track. Move them into its branch, where its plan lives.">also has lines on main · Move into branch</button>`
      : '';
  const behind = track.branch ? renderBehind(project, track) : '';
  const land = track.branch
    ? html`<button class="pw-track-land" data-cwd="${cwd}" data-track="${name}"
               title="Merge this track into ${track.branch.baseBranch} and retire its worktree">Land</button>`
    : '';
  // The Inbox is loose work: the factory runs it item by item on its own.
  const send =
    name === 'Inbox'
      ? ''
      : html`<button class="pw-track-factory" data-cwd="${cwd}" data-track="${name}"
               title="Send this track's open features to the factory with your Settings → Factory defaults">▶</button>`;
  return html`
    <span class="pw-track-actions">
      ${badge}
      ${behind}
      ${alsoOnMain}
      ${onMain}
      <button class="pw-track-session" data-cwd="${cwd}" data-track="${name}"
              title="${track.branch ? 'Open a session in this track’s worktree' : 'Create this track’s branch and open a session in it'}">Open session</button>
      ${send}
      ${land}
      ${del}
    </span>`;
}

/**
 * `N behind main`, what merging it in would conflict on, and Update from
 * main. Nothing when the track is level with its base. A null conflict list
 * means the dry run couldn't be made: only the count shows, never "clean".
 */
export function renderBehind(project: WorkspaceProject, track: WorkspaceTrack): SafeHtml {
  const n = track.behind ?? 0;
  if (!track.branch || n <= 0) return html``;
  const base = track.branch.baseBranch;
  const conflicts = track.wouldConflict ?? [];
  const shown = conflicts.slice(0, 3).join(', ') + (conflicts.length > 3 ? ` +${conflicts.length - 3}` : '');
  const conflict = conflicts.length
    ? html`<span class="pw-behind pw-behind-conflict" title="${`Merging ${base} in would conflict in: ${conflicts.join(', ')}`}">would conflict: ${shown}</span>`
    : '';
  return html`<span class="pw-behind" title="${`${n} commit${n === 1 ? '' : 's'} on ${base} this track lacks`}">${n} behind ${base}</span>
      ${conflict}
      <button class="pw-track-update" data-cwd="${project.cwd}" data-track="${track.name}"
              title="Merge ${base} into this track's worktree, keeping its plan">Update from ${base}</button>`;
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
export function renderOrphanBranches(project: WorkspaceProject): SafeHtml {
  if (!project.orphanBranches?.length) return html``;
  const cwd = project.cwd;
  const rows = project.orphanBranches.map(
    (b) => html`
      <li class="phase-item pw-orphan">
        <span class="phase-title">${b.trackName}</span>
        <span class="pw-branch" title="${b.worktreePath}">⎇ ${b.branch}</span>
        <button class="pw-track-delete" data-cwd="${cwd}" data-track="${b.trackName}"
                title="Delete this branch, its worktree and anything it landed">Delete</button>
      </li>`
  );
  return html`
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
): SafeHtml {
  const cwd = project.cwd;
  const id = f.id;
  return html`
    <li class="phase-item pw-feature" data-feature="${id}">
      <button class="pw-status ${f.status}" data-cwd="${cwd}" data-id="${id}"
              title="${STATUS_LABEL[f.status]} — click to change"
              aria-label="${STATUS_LABEL[f.status]}">${STATUS_ICON[f.status]}</button>
      ${
        f.priority !== null &&
        html`<span class="pw-priority p${f.priority}" title="Priority">P${f.priority}</span>`
      }
      <span class="pw-feature-id" title="Feature id">${f.id}</span>
      <span class="phase-title pw-title" data-cwd="${cwd}" data-id="${id}"
            title="Click to rename">${f.title}</span>
      ${
        f.spec &&
        html`<button class="pw-spec" data-cwd="${cwd}" data-id="${id}"
                     title="${f.spec}">spec</button>`
      }
      ${
        // A branched track's code sits on its branch: removing one line would
        // suggest that code went too. Delete the track instead.
        !track.branch &&
        html`<button class="pw-delete" data-cwd="${cwd}" data-id="${id}"
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
): SafeHtml {
  const spec = specs.get(specKey(project.cwd, f.id));
  if (spec === undefined) return html``;
  return spec
    ? html`<pre class="pw-spec-body">${spec}</pre>`
    : html`<div class="pw-hint pw-spec-body">Could not read ${f.spec || 'the spec'}.</div>`;
}

export function specKey(cwd: string, featureId: string): string {
  return `${cwd}|${featureId}`;
}

export function renderAddRow(project: WorkspaceProject): SafeHtml {
  const tracks = project.tracks.map((t) => t.name);
  const options = tracks.map((t) => html`<option value="${t}">${t}</option>`);
  return html`
    <form class="pw-add" data-cwd="${project.cwd}">
      <input type="text" class="pw-add-title" placeholder="Add a feature…" maxlength="200"
             aria-label="New feature title" />
      <select class="pw-add-priority" aria-label="Priority">
        <option value="">—</option>
        <option value="1">P1</option>
        <option value="2">P2</option>
        <option value="3">P3</option>
      </select>
      ${tracks.length > 1 && html`<select class="pw-add-track" aria-label="Track">${options}</select>`}
      <button type="submit" class="btn-secondary">Add</button>
    </form>`;
}
