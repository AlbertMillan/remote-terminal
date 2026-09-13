import { escapeHtml, escapeAttr } from './html-utils.js';

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
  counts: FeatureCounts;
  lastActivity: string | null;
  lastModified: string | null;
  transcriptCount: number;
}

/** Cycle order when clicking a feature's status box. */
const STATUS_CYCLE: FeatureStatus[] = ['pending', 'in_progress', 'done', 'blocked'];

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

export class ProjectWorkspace {
  private board: WorkspaceProject[] = [];
  private selectedCwd: string | null = null;
  /** Projects whose migration run produced nothing, so the button offers Retry. */
  private failedMigrations = new Map<string, string>();
  private busy = new Set<string>();

  constructor(
    private readonly onSelect: (cwd: string) => void,
    private readonly onOpenSession: (cwd: string) => void
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
      container.innerHTML = this.renderNoIndex(project);
      return;
    }

    const tracks = project.tracks
      .map((track) => this.renderTrack(project, track))
      .join('');
    const empty =
      project.counts.total === 0
        ? '<div class="project-empty">No features yet — add the first one below.</div>'
        : '';

    container.innerHTML = `
      <div class="pw-features">
        <div class="pw-subhead">
          <h3 class="project-log-subhead">Features</h3>
          ${this.renderProgress(project)}
        </div>
        ${tracks}${empty}
        ${this.renderAddRow(project)}
      </div>`;
  }

  private renderProgress(project: WorkspaceProject): string {
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

  private renderNoIndex(project: WorkspaceProject): string {
    const failure = this.failedMigrations.get(project.cwd);
    const busy = this.busy.has(project.cwd);
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

  private renderTrack(project: WorkspaceProject, track: WorkspaceTrack): string {
    const rows = track.features.map((f) => this.renderFeatureRow(project, f)).join('');
    const done = track.features.filter((f) => f.status === 'done').length;
    return `
      <div class="phase-group pw-track">
        <div class="phase-group-head">
          <span class="phase-group-name">${escapeHtml(track.name)}</span>
          <span class="phase-progress">${done}/${track.features.length}</span>
        </div>
        <ul class="phase-list">${rows}</ul>
      </div>`;
  }

  private renderFeatureRow(project: WorkspaceProject, f: Feature): string {
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
            ? `<span class="pw-spec" title="${escapeAttr(f.spec)}">spec</span>`
            : ''
        }
        <button class="pw-delete" data-cwd="${cwd}" data-id="${id}"
                title="Remove this feature" aria-label="Remove">×</button>
      </li>`;
  }

  private renderAddRow(project: WorkspaceProject): string {
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

      const status = target.closest('.pw-status') as HTMLElement | null;
      if (status) {
        void this.cycleStatus(status.dataset.cwd || '', status.dataset.id || '');
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
    return badges.join('');
  }

  openSession(cwd: string): void {
    this.onOpenSession(cwd);
  }
}
