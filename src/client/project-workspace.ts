import { escapeHtml, escapeAttr } from './html-utils.js';
import { openTrackDeleteDialog } from './track-delete-dialog.js';
import { openBranchNowDialog } from './track-branch-now-dialog.js';
import { formatUsageCost, hasSpend, projectUsageTooltip, type ProjectUsage } from './job-board.js';
import {
  renderAddRow,
  renderCollapseAll,
  renderNoIndex,
  renderOrphanBranches,
  renderProgress,
  renderQaCard,
  renderTrack,
  specKey,
  trackKey,
  unbranchedFor,
  type UnbranchedWork,
} from './project-feature-board.js';
import {
  isPhaseGroupActivation,
  setPhaseGroupCollapsed,
  togglePhaseGroup,
} from './phase-group.js';

/**
 * Client for the project workspace: the canonical PROJECT.md board.
 *
 * Mirrors the server types in src/server/projects/. Every mutation echoes the
 * `revision` it last read; a 409 means the file changed underneath (a hand
 * edit, an agent pass) and the board reloads rather than clobbering it.
 */

export type FeatureStatus = 'pending' | 'in_progress' | 'done' | 'blocked';

export interface Feature {
  id: string;
  status: FeatureStatus;
  priority: number | null;
  title: string;
  spec: string | null;
}

export interface WorkspaceTrack {
  name: string;
  features: Feature[];
  /** The track's own branch while it is being implemented (docs/track-branches.md). */
  branch: { name: string; worktreePath: string; baseBranch: string } | null;
}

export interface VcsCapabilities {
  kind: 'git' | 'plastic' | 'none';
  canDispatch: boolean;
  needsInit: boolean;
  canPush: boolean;
  note: string | null;
}

export interface FeatureCounts {
  total: number;
  done: number;
  in_progress: number;
  pending: number;
  blocked: number;
}

export interface QaDoc {
  driver: 'commands' | 'playwright' | 'unity' | 'manual';
  commands: string[];
  body: string;
  exists: boolean;
}

export interface WorkspaceProject {
  cwd: string;
  name: string;
  nested: string[];
  registered: boolean;
  vcs: VcsCapabilities;
  hasDoc: boolean;
  revision: string;
  docPath: string;
  status: string | null;
  verify: string[];
  tracks: WorkspaceTrack[];
  /** Unlanded track branches whose heading is gone from PROJECT.md. */
  orphanBranches: { trackName: string; branch: string; worktreePath: string }[];
  counts: FeatureCounts;
  lastActivity: string | null;
  lastModified: string | null;
  transcriptCount: number;
  /** Everything the project spent, from the usage ledger; null before any is read. */
  usage?: ProjectUsage | null;
}

/** Cycle order when clicking a feature's status box. */
const STATUS_CYCLE: FeatureStatus[] = ['pending', 'in_progress', 'done', 'blocked'];

/** localStorage key holding the folded tracks, as an array of `trackKey()` strings. */
const COLLAPSED_TRACKS_KEY = 'pw.collapsedTracks';

function loadCollapsedTracks(): string[] {
  try {
    const raw = localStorage.getItem(COLLAPSED_TRACKS_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : [];
  } catch {
    return [];
  }
}

function saveCollapsedTracks(keys: Set<string>): void {
  try {
    localStorage.setItem(COLLAPSED_TRACKS_KEY, JSON.stringify([...keys]));
  } catch {
    /* private browsing or a full quota — folding still works for this session. */
  }
}

export class ProjectWorkspace {
  private board: WorkspaceProject[] = [];
  private selectedCwd: string | null = null;
  /** Projects whose migration run produced nothing, so the button offers Retry. */
  private failedMigrations = new Map<string, string>();
  private busy = new Set<string>();
  /** QA contract per project, loaded with the detail view. */
  private qaDocs = new Map<string, QaDoc | null>();
  private qaBusy = new Set<string>();
  /**
   * Specs the user has opened, keyed `cwd|featureId`.
   *
   * A feature's spec is a file on disk that the board only ever pointed at
   * through a tooltip. `undefined` means not fetched, `null` means fetched and
   * unreadable — the two say different things to the reader.
   */
  private specs = new Map<string, string | null>();
  /**
   * Work on main guessed per unbranched track, by project. Fetched once per
   * render of a project and dropped on reload(), so the board always renders
   * from state — the fetch re-renders when it lands.
   */
  private unbranched = new Map<string, UnbranchedWork | 'loading'>();
  /**
   * Tracks whose delete plan is loading, keyed `cwd|track`. Planning reads the
   * git history and the track's transcripts — about a second — so the button
   * says so rather than looking dead. State, not a DOM patch: every render
   * replaces the board.
   */
  private planning = new Set<string>();
  /**
   * Tracks the user has folded away, keyed by (cwd, track). Held here rather
   * than in the DOM because every mutation re-renders the whole board, and
   * persisted so a long index doesn't unfold itself on every reload.
   */
  private collapsedTracks = new Set<string>(loadCollapsedTracks());

  constructor(
    private readonly onSelect: (cwd: string) => void,
    private readonly onOpenSession: (cwd: string) => void,
    /** Send a feature to the job pipeline. */
    private readonly onDispatch: (cwd: string, featureId: string, title: string) => void,
    /** Open a terminal in a track's worktree. */
    private readonly onOpenTrackSession: (worktreePath: string, trackName: string) => void
  ) {}

  getProject(cwd: string): WorkspaceProject | undefined {
    return this.board.find((p) => p.cwd === cwd);
  }

  getBoard(): WorkspaceProject[] {
    return this.board;
  }

  setSelected(cwd: string | null): void {
    this.selectedCwd = cwd;
  }

  // --- Loading -----------------------------------------------------------

  async loadBoard(): Promise<void> {
    const listEl = document.getElementById('project-list');
    try {
      const res = await fetch('/api/projects');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as { projects: WorkspaceProject[] };
      this.board = data.projects || [];
      this.renderList();
    } catch (error) {
      if (listEl) {
        listEl.innerHTML = `<li class="project-empty">Couldn't load projects: ${escapeHtml(
          error instanceof Error ? error.message : String(error)
        )}</li>`;
      }
    }
  }

  // --- Sidebar list ------------------------------------------------------

  renderList(): void {
    const listEl = document.getElementById('project-list');
    if (!listEl) return;
    listEl.innerHTML = '';

    if (this.board.length === 0) {
      listEl.innerHTML = '<li class="project-empty">No projects found.</li>';
      return;
    }

    for (const project of this.board) {
      const li = document.createElement('li');
      li.className = 'project-item';
      if (this.selectedCwd === project.cwd) li.classList.add('active');

      const dot = document.createElement('span');
      dot.className = `project-status-dot ${this.statusClass(project)}`;
      dot.title = project.hasDoc
        ? `${project.counts.done}/${project.counts.total} done`
        : 'No project index yet';
      li.appendChild(dot);

      const body = document.createElement('div');
      body.className = 'project-item-body';

      const meta: string[] = [];
      if (project.lastActivity) meta.push(this.relativeTime(project.lastActivity));
      else if (project.lastModified) meta.push(`~${this.relativeTime(project.lastModified)}`);
      if (project.vcs.kind !== 'git') meta.push(project.vcs.kind === 'none' ? 'no repo' : 'plastic');
      if (project.nested.length > 0) meta.push(`+${project.nested.length} dirs`);
      if (!project.hasDoc) meta.push('no index');

      body.innerHTML = `
        <div class="project-item-name">${escapeHtml(project.name)}</div>
        <div class="project-item-meta">${escapeHtml(meta.join(' · '))}</div>`;
      li.appendChild(body);

      if (project.hasDoc && project.counts.total > 0) {
        const badges = document.createElement('div');
        badges.className = 'project-badges';
        const { blocked, in_progress: active, total, done } = project.counts;
        if (blocked > 0) {
          badges.innerHTML += `<span class="project-badge blockers" title="Blocked">! ${blocked}</span>`;
        }
        if (active > 0) {
          badges.innerHTML += `<span class="project-badge open" title="In progress">◐ ${active}</span>`;
        }
        badges.innerHTML += `<span class="project-badge" title="Features done">${done}/${total}</span>`;
        li.appendChild(badges);
      }

      li.addEventListener('click', () => this.onSelect(project.cwd));
      listEl.appendChild(li);
    }
  }

  /**
   * Status dot. Unlike the old board this reflects the project's own declared
   * state and its feature progress, falling back to recency only when there is
   * no index to read.
   */
  private statusClass(project: WorkspaceProject): string {
    if (!project.hasDoc) return 'nolog';
    if (project.counts.blocked > 0) return 'blocked';
    if (project.counts.in_progress > 0) return 'fresh';
    if (project.counts.total > 0 && project.counts.done === project.counts.total) return 'shipped';
    return 'recent';
  }

  private relativeTime(iso: string): string {
    const then = new Date(iso).getTime();
    if (Number.isNaN(then)) return '';
    const mins = Math.max(0, Math.round((Date.now() - then) / 60000));
    if (mins < 60) return `${mins}m ago`;
    const hours = Math.round(mins / 60);
    if (hours < 24) return `${hours}h ago`;
    const days = Math.round(hours / 24);
    return days < 30 ? `${days}d ago` : `${Math.round(days / 30)}mo ago`;
  }

  // --- Detail: features --------------------------------------------------

  /** Render the feature board for a project into `container`. */
  renderFeatures(container: HTMLElement, cwd: string): void {
    const project = this.getProject(cwd);
    if (!project) {
      container.innerHTML = '';
      return;
    }

    if (!project.hasDoc) {
      container.innerHTML = renderNoIndex(
        project,
        this.failedMigrations.get(project.cwd),
        this.busy.has(project.cwd)
      );
      return;
    }

    const tracks =
      project.tracks
        .map((track) =>
          renderTrack(project, track, this.collapsedTracks, this.planning, this.unbranched, this.specs)
        )
        .join('') + renderOrphanBranches(project);
    this.ensureUnbranched(project);
    const empty =
      project.counts.total === 0
        ? '<div class="project-empty">No features yet — add the first one below.</div>'
        : '';

    container.innerHTML = `
      <div class="pw-features">
        <div class="pw-subhead">
          <h3 class="project-log-subhead">Features</h3>
          <div class="pw-subhead-right">
            ${renderProgress(project)}
            ${renderCollapseAll(project, this.collapsedTracks)}
          </div>
        </div>
        ${tracks}${empty}
        ${renderAddRow(project)}
        ${renderQaCard(project, this.qaDocs.get(project.cwd), this.qaBusy.has(project.cwd))}
      </div>`;
  }

  /** Load a project's QA contract for the detail view. */
  async loadQa(cwd: string): Promise<void> {
    try {
      const res = await fetch(`/api/projects/qa?cwd=${encodeURIComponent(cwd)}`);
      const data = (await res.json()) as { doc: QaDoc | null };
      this.qaDocs.set(cwd, data.doc);
    } catch {
      this.qaDocs.set(cwd, null);
    }
    this.refreshDetail(cwd);
  }

  /** Draft a QA doc for the user to edit and approve. */
  async generateQa(cwd: string): Promise<void> {
    if (this.qaBusy.has(cwd)) return;
    this.qaBusy.add(cwd);
    this.refreshDetail(cwd);
    try {
      const res = await fetch('/api/projects/qa/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cwd }),
      });
      const data = (await res.json()) as {
        outcome?: string;
        detail?: string | null;
        doc?: QaDoc | null;
      };
      if (data.outcome === 'error') {
        this.flash(data.detail || 'Could not draft a QA doc.');
      } else {
        if (data.detail) this.flash(data.detail);
        this.qaDocs.set(cwd, data.doc ?? null);
      }
    } catch (error) {
      this.flash(error instanceof Error ? error.message : 'Could not draft a QA doc.');
    } finally {
      this.qaBusy.delete(cwd);
      this.refreshDetail(cwd);
    }
  }

  /**
   * Fold or unfold one track. The fold itself is a class toggle on the group —
   * re-rendering the board would rebuild every feature row and throw away the
   * focused head for a change CSS already handles. The set is updated alongside
   * so the fold survives the *next* re-render, whatever triggers it.
   */
  private toggleTrack(head: HTMLElement, cwd: string, track: string): void {
    const collapsed = togglePhaseGroup(head);
    const key = trackKey(cwd, track);
    if (collapsed) this.collapsedTracks.add(key);
    else this.collapsedTracks.delete(key);
    saveCollapsedTracks(this.collapsedTracks);
    this.syncCollapseAll(head, cwd);
  }

  /** Fold every track at once, or unfold them all if they are already folded. */
  private toggleAllTracks(button: HTMLElement, cwd: string): void {
    const heads = this.trackHeads(button, cwd);
    if (heads.length === 0) return;
    const collapse = !heads.every((h) => h.closest('.phase-group')?.classList.contains('collapsed'));
    for (const head of heads) {
      setPhaseGroupCollapsed(head, collapse);
      const key = trackKey(cwd, head.dataset.track || '');
      if (collapse) this.collapsedTracks.add(key);
      else this.collapsedTracks.delete(key);
    }
    saveCollapsedTracks(this.collapsedTracks);
    this.syncCollapseAll(button, cwd);
  }

  /**
   * The track heads of one project, found from any element inside its board.
   * Scoped to that board and matched on cwd as well as track: only one project
   * renders at a time today, but a lookup that relies on it is a trap.
   */
  private trackHeads(origin: HTMLElement, cwd: string): HTMLElement[] {
    const root = origin.closest('.pw-features') || origin.ownerDocument;
    return [...root.querySelectorAll<HTMLElement>('.pw-track-head')].filter(
      (h) => h.dataset.cwd === cwd
    );
  }

  /**
   * Keep the Collapse all / Expand all button honest after a fold. It is the
   * one thing on the board that a class toggle can't update on its own.
   */
  private syncCollapseAll(origin: HTMLElement, cwd: string): void {
    const button = origin
      .closest('.pw-features')
      ?.querySelector<HTMLElement>('.pw-collapse-all');
    if (!button) return;
    const heads = this.trackHeads(origin, cwd);
    const allCollapsed =
      heads.length > 0 &&
      heads.every((h) => h.closest('.phase-group')?.classList.contains('collapsed'));
    button.textContent = allCollapsed ? 'Expand all' : 'Collapse all';
    button.title = `${allCollapsed ? 'Expand' : 'Collapse'} every track`;
  }

  /**
   * Open or close a feature's spec.
   *
   * Served by /api/projects/detail, which already resolves a named feature's
   * spec through the registry guard — it had simply never had a caller.
   */
  async toggleSpec(cwd: string, featureId: string): Promise<void> {
    const key = specKey(cwd, featureId);
    if (this.specs.has(key)) {
      this.specs.delete(key);
      this.refreshDetail(cwd);
      return;
    }
    try {
      const res = await fetch(
        `/api/projects/detail?cwd=${encodeURIComponent(cwd)}&feature=${encodeURIComponent(featureId)}`
      );
      const data = (await res.json()) as { spec: string | null };
      this.specs.set(key, data.spec);
    } catch {
      this.specs.set(key, null);
    }
    this.refreshDetail(cwd);
  }

  // --- Mutations ---------------------------------------------------------

  /**
   * Send a mutation, then reload the board so the next edit carries a fresh
   * revision. A 409 means someone else wrote the file first; the reload shows
   * their version rather than forcing ours over it.
   */
  private async mutate(
    path: string,
    method: 'POST' | 'PATCH' | 'DELETE',
    body: Record<string, unknown>
  ): Promise<boolean> {
    try {
      const res = await fetch(path, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (res.status === 409) {
        await this.reload();
        this.flash('PROJECT.md changed on disk — reloaded. Try again.');
        return false;
      }
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        this.flash(data.error || `Request failed (${res.status})`);
        return false;
      }
      await this.reload();
      return true;
    } catch (error) {
      this.flash(error instanceof Error ? error.message : 'Request failed');
      return false;
    }
  }

  async addFeature(cwd: string, title: string, priority: string, track?: string): Promise<boolean> {
    const project = this.getProject(cwd);
    if (!project || !title.trim()) return false;
    return this.mutate('/api/projects/feature', 'POST', {
      cwd,
      revision: project.revision,
      title: title.trim(),
      ...(priority ? { priority: Number(priority) } : {}),
      ...(track ? { track } : {}),
    });
  }

  async cycleStatus(cwd: string, id: string): Promise<boolean> {
    const project = this.getProject(cwd);
    const feature = project?.tracks.flatMap((t) => t.features).find((f) => f.id === id);
    if (!project || !feature) return false;
    const next = STATUS_CYCLE[(STATUS_CYCLE.indexOf(feature.status) + 1) % STATUS_CYCLE.length];
    return this.mutate('/api/projects/feature', 'PATCH', {
      cwd,
      revision: project.revision,
      id,
      status: next,
    });
  }

  async renameFeature(cwd: string, id: string, title: string): Promise<boolean> {
    const project = this.getProject(cwd);
    if (!project || !title.trim()) return false;
    return this.mutate('/api/projects/feature', 'PATCH', {
      cwd,
      revision: project.revision,
      id,
      title: title.trim(),
    });
  }

  /** Ensure the track's branch exists, then open a terminal in its worktree. */
  async openTrackSession(cwd: string, track: string): Promise<void> {
    const data = await this.trackRequest<{ branch: { worktreePath: string } }>(
      '/api/projects/track/branch',
      { cwd, track }
    );
    if (!data) return;
    this.onOpenTrackSession(data.branch.worktreePath, track);
    await this.reload();
  }

  /** Fetch the guessed work on main once for this project, then re-render. */
  private ensureUnbranched(project: WorkspaceProject): void {
    if (!project.vcs.canDispatch || this.unbranched.has(project.cwd)) return;
    this.unbranched.set(project.cwd, 'loading');
    void fetch(`/api/projects/unbranched-work?cwd=${encodeURIComponent(project.cwd)}`)
      .then(async (res) => (res.ok ? ((await res.json()) as { tracks: UnbranchedWork }).tracks : {}))
      .catch(() => ({}))
      .then((tracks) => {
        this.unbranched.set(project.cwd, tracks);
        if (Object.keys(tracks).length > 0) this.refreshDetail(project.cwd);
      });
  }

  /** Confirm the guessed files, then move them into a new track branch. */
  async branchNow(cwd: string, track: string): Promise<void> {
    const work = unbranchedFor(this.unbranched, cwd, track);
    if (!work || work.files.length === 0) {
      this.flash('Nothing uncommitted to move — only commits, which Delete track offers.');
      return;
    }
    const detail = await openBranchNowDialog(cwd, track, work.files, work.commits);
    if (detail === null) return;
    await this.reload();
    this.flash(detail);
  }

  /** Show the delete plan; on confirm the dialog deletes, and the board reloads. */
  async deleteTrack(cwd: string, track: string): Promise<void> {
    const key = `${cwd}|${track}`;
    if (this.planning.has(key)) return;
    this.planning.add(key);
    this.refreshDetail(cwd);
    const detail = await openTrackDeleteDialog(
      cwd,
      track,
      (m) => this.flash(m),
      () => {
        this.planning.delete(key);
        this.refreshDetail(cwd);
      }
    );
    if (detail === null) return;
    await this.reload();
    this.flash(detail);
  }

  async landTrack(cwd: string, track: string): Promise<void> {
    // The server builds the project after merging, so the reply can take a while.
    this.flash(`Landing "${track}" and rebuilding…`);
    const data = await this.trackRequest<{ detail: string }>('/api/projects/track/land', {
      cwd,
      track,
    });
    await this.reload();
    if (data) this.flash(data.detail);
  }

  /**
   * POST to a track endpoint. Unlike mutate(), a 409 here is a refusal with its
   * own reason (a live job, a dirty worktree), not a stale PROJECT.md.
   */
  private async trackRequest<T>(path: string, body: Record<string, unknown>): Promise<T | null> {
    try {
      const res = await fetch(path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = (await res.json().catch(() => ({}))) as T & { error?: string };
      if (!res.ok) {
        this.flash(data.error || `Request failed (${res.status})`);
        return null;
      }
      return data;
    } catch (error) {
      this.flash(error instanceof Error ? error.message : 'Request failed');
      return null;
    }
  }

  async deleteFeature(cwd: string, id: string): Promise<boolean> {
    const project = this.getProject(cwd);
    if (!project) return false;
    return this.mutate('/api/projects/feature', 'DELETE', { cwd, revision: project.revision, id });
  }

  /** Run the one-time conversion of a project's plan docs into PROJECT.md. */
  async migrate(cwd: string): Promise<void> {
    if (this.busy.has(cwd)) return;
    this.busy.add(cwd);
    this.failedMigrations.delete(cwd);
    this.refreshDetail(cwd);
    try {
      const res = await fetch('/api/projects/migrate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cwd }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        outcome?: string;
        detail?: string | null;
        error?: string;
      };
      if (!res.ok || data.outcome === 'error') {
        this.failedMigrations.set(cwd, data.detail || data.error || 'Generation failed');
      } else if (data.detail) {
        this.flash(data.detail);
      }
    } catch (error) {
      this.failedMigrations.set(cwd, error instanceof Error ? error.message : 'Generation failed');
    } finally {
      this.busy.delete(cwd);
      await this.reload();
    }
  }

  private refreshDetail(cwd: string): void {
    if (this.selectedCwd !== cwd) return;
    const container = document.getElementById('project-features');
    if (container) this.renderFeatures(container, cwd);
  }

  /**
   * Reload the board AND re-render the open project. Every mutation must go
   * through this: reloading only the sidebar leaves the detail pane showing
   * pre-edit state with a stale revision, so the next edit would 409 against a
   * change the user just made themselves.
   */
  private async reload(): Promise<void> {
    if (this.selectedCwd) this.unbranched.delete(this.selectedCwd);
    await this.loadBoard();
    if (this.selectedCwd) this.refreshDetail(this.selectedCwd);
  }

  /** Transient message in the detail header. */
  private flash(message: string): void {
    const el = document.getElementById('project-flash');
    if (!el) return;
    el.textContent = message;
    el.classList.remove('hidden');
    window.setTimeout(() => el.classList.add('hidden'), 6000);
  }

  // --- Event wiring ------------------------------------------------------

  /**
   * One delegated listener per container rather than per-row handlers, so a
   * re-render never leaks listeners.
   */
  attach(container: HTMLElement): void {
    container.addEventListener('click', (event) => {
      const target = event.target as HTMLElement;

      const collapseAll = target.closest('.pw-collapse-all') as HTMLElement | null;
      if (collapseAll) {
        this.toggleAllTracks(collapseAll, collapseAll.dataset.cwd || '');
        return;
      }

      // Checked before the heading itself: these buttons sit inside it.
      const trackSession = target.closest('.pw-track-session') as HTMLElement | null;
      if (trackSession) {
        void this.openTrackSession(trackSession.dataset.cwd || '', trackSession.dataset.track || '');
        return;
      }

      const branchNowBtn = target.closest('.pw-track-branchnow') as HTMLElement | null;
      if (branchNowBtn) {
        void this.branchNow(branchNowBtn.dataset.cwd || '', branchNowBtn.dataset.track || '');
        return;
      }

      const trackDelete = target.closest('.pw-track-delete') as HTMLElement | null;
      if (trackDelete) {
        void this.deleteTrack(trackDelete.dataset.cwd || '', trackDelete.dataset.track || '');
        return;
      }

      const trackLand = target.closest('.pw-track-land') as HTMLElement | null;
      if (trackLand) {
        const track = trackLand.dataset.track || '';
        if (confirm(`Land "${track}"? Its branch is merged, its worktree removed, and the project rebuilt.`)) {
          void this.landTrack(trackLand.dataset.cwd || '', track);
        }
        return;
      }

      const trackHead = target.closest('.pw-track-head') as HTMLElement | null;
      if (trackHead) {
        this.toggleTrack(trackHead, trackHead.dataset.cwd || '', trackHead.dataset.track || '');
        return;
      }

      const status = target.closest('.pw-status') as HTMLElement | null;
      if (status) {
        void this.cycleStatus(status.dataset.cwd || '', status.dataset.id || '');
        return;
      }

      const spec = target.closest('.pw-spec') as HTMLElement | null;
      if (spec) {
        void this.toggleSpec(spec.dataset.cwd || '', spec.dataset.id || '');
        return;
      }

      const del = target.closest('.pw-delete') as HTMLElement | null;
      if (del) {
        const row = del.closest('.pw-feature');
        const title = row?.querySelector('.pw-title')?.textContent || 'this feature';
        if (confirm(`Remove "${title}" from PROJECT.md?`)) {
          void this.deleteFeature(del.dataset.cwd || '', del.dataset.id || '');
        }
        return;
      }

      const dispatch = target.closest('.pw-dispatch') as HTMLElement | null;
      if (dispatch && dispatch.tagName === 'BUTTON') {
        this.onDispatch(
          dispatch.dataset.cwd || '',
          dispatch.dataset.id || '',
          dispatch.dataset.title || ''
        );
        return;
      }

      const qaGen = target.closest('.pw-qa-gen') as HTMLElement | null;
      if (qaGen) {
        void this.generateQa(qaGen.dataset.cwd || '');
        return;
      }

      const migrate = target.closest('.pw-migrate') as HTMLElement | null;
      if (migrate) {
        void this.migrate(migrate.dataset.cwd || '');
        return;
      }

      const title = target.closest('.pw-title') as HTMLElement | null;
      if (title) {
        const current = title.textContent || '';
        const next = prompt('Rename feature', current);
        if (next !== null && next.trim() && next !== current) {
          void this.renameFeature(title.dataset.cwd || '', title.dataset.id || '', next);
        }
      }
    });

    container.addEventListener('keydown', (event) => {
      if (!isPhaseGroupActivation(event.key)) return;
      // A focused action button inside the heading handles its own activation.
      if ((event.target as HTMLElement).closest('button')) return;
      const head = (event.target as HTMLElement).closest('.pw-track-head') as HTMLElement | null;
      if (!head) return;
      event.preventDefault();
      this.toggleTrack(head, head.dataset.cwd || '', head.dataset.track || '');
    });

    container.addEventListener('submit', (event) => {
      const form = (event.target as HTMLElement).closest('.pw-add') as HTMLFormElement | null;
      if (!form) return;
      event.preventDefault();
      const titleEl = form.querySelector('.pw-add-title') as HTMLInputElement | null;
      const priorityEl = form.querySelector('.pw-add-priority') as HTMLSelectElement | null;
      const trackEl = form.querySelector('.pw-add-track') as HTMLSelectElement | null;
      const title = titleEl?.value || '';
      if (!title.trim()) return;
      void this.addFeature(
        form.dataset.cwd || '',
        title,
        priorityEl?.value || '',
        trackEl?.value || undefined
      ).then((ok) => {
        if (ok && titleEl) titleEl.value = '';
      });
    });
  }

  /** Header badges describing the project's VCS tier and dispatch eligibility. */
  renderHeaderBadges(project: WorkspaceProject): string {
    const badges: string[] = [];
    if (project.status) {
      badges.push(`<span class="pw-badge status">${escapeHtml(project.status)}</span>`);
    }
    badges.push(
      `<span class="pw-badge vcs ${project.vcs.kind}" title="${escapeAttr(
        project.vcs.note || 'Git repository'
      )}">${escapeHtml(project.vcs.kind)}</span>`
    );
    if (project.vcs.note) {
      badges.push(`<span class="pw-badge warn" title="${escapeAttr(project.vcs.note)}">!</span>`);
    }
    if (project.nested.length > 0) {
      badges.push(
        `<span class="pw-badge" title="${escapeAttr(
          project.nested.join('\n')
        )}">+${project.nested.length} dirs</span>`
      );
    }
    if (project.usage && hasSpend(project.usage.total)) {
      badges.push(
        `<span class="jb-usage project" title="${escapeAttr(projectUsageTooltip(project.usage))}">${escapeHtml(
          formatUsageCost(project.usage.total)
        )}</span>`
      );
    }
    return badges.join('');
  }

  openSession(cwd: string): void {
    this.onOpenSession(cwd);
  }
}
