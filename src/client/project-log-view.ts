import { escapeHtml, escapeAttr } from './html-utils.js';
import type { ProjectWorkspace } from './project-workspace.js';
import type { JobBoard } from './job-board.js';
import type { RollupView } from './rollup-view.js';
import type { ParsedLogEntry, PhaseGroup, ProjectBoardItem } from './session-types.js';

/**
 * The narrow surface ProjectLogView needs from SessionManager. `workspace`,
 * `jobBoard` and `rollup` remain SessionManager's fields — this just holds
 * references to them — while the callbacks keep "current session"/overlay
 * state single-owned by SessionManager rather than duplicated here.
 */
export interface ProjectLogViewHost {
  workspace: ProjectWorkspace;
  jobBoard: JobBoard;
  rollup: RollupView;
  /** Detach the live terminal session (if any) so the project view can take over the main area. */
  detachCurrentSession(): void;
  syncJobOverlay(): void;
  showNewSessionModal(prefillCwd?: string): void;
}

/**
 * The Projects tab: the PROJECT.md workspace board (top half, owned by
 * `ProjectWorkspace`) plus the SESSION-LOG.md history/plan-progress view
 * (bottom half, owned here).
 */
export class ProjectLogView {
  // Project-log board state
  private activeTab: 'sessions' | 'projects' = 'sessions';
  private projectBoard: ProjectBoardItem[] = [];
  private selectedProjectCwd: string | null = null;
  /** The board load in flight, so concurrent callers share one round trip. */
  private boardLoad: Promise<void> | null = null;
  // Entry targeted by the open delete-history-entry modal.
  private pendingHistoryDelete: {
    cwd: string;
    entryIndex: number;
    claudeSessionId: string | null;
    siblingCount: number; // other entries sharing the same claudeSessionId
  } | null = null;
  private backfillPollTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private failedBackfills = new Set<string>();

  constructor(private readonly host: ProjectLogViewHost) {}

  /** Whether the Projects tab (not Sessions) is the one currently showing. */
  isProjectsTabActive(): boolean {
    return this.activeTab === 'projects';
  }

  /** Whether a project is the thing currently occupying the main area. */
  hasSelection(): boolean {
    return this.selectedProjectCwd !== null;
  }

  /** A session is about to take over the main area -- the project view no longer owns it. */
  clearSelection(): void {
    this.selectedProjectCwd = null;
  }

  switchTab(tab: 'sessions' | 'projects'): void {
    this.activeTab = tab;
    const onProjects = tab === 'projects';

    document.getElementById('tab-sessions')?.classList.toggle('active', !onProjects);
    document.getElementById('tab-projects')?.classList.toggle('active', onProjects);
    document.getElementById('tab-sessions')?.setAttribute('aria-selected', String(!onProjects));
    document.getElementById('tab-projects')?.setAttribute('aria-selected', String(onProjects));

    document.getElementById('session-list')?.classList.toggle('hidden', onProjects);
    document.getElementById('project-list')?.classList.toggle('hidden', !onProjects);
    document.getElementById('new-session-btn')?.classList.toggle('hidden', onProjects);
    document.getElementById('refresh-projects-btn')?.classList.toggle('hidden', !onProjects);
    document.getElementById('overview-btn')?.classList.toggle('hidden', !onProjects);
    if (!onProjects) this.host.rollup.hide();
    this.host.syncJobOverlay();

    if (onProjects) void this.loadProjectBoard();
  }

  /** Load both halves of the board: the PROJECT.md workspace and the session logs. */
  loadProjectBoard(): Promise<void> {
    const load = Promise.all([this.host.workspace.loadBoard(), this.loadProjectLogData()]).then(
      () => undefined
    );
    this.boardLoad = load;
    void load.finally(() => {
      if (this.boardLoad === load) this.boardLoad = null;
    });
    return load;
  }

  /**
   * Wait for the board, joining a load already in flight rather than starting
   * a second one.
   *
   * Only for callers that just need the board *present* — the overlay's
   * click-through, which arrives right behind the unawaited load `switchTab`
   * kicks off. A caller that has just mutated the board must call
   * `loadProjectBoard()` instead: a fetch that began before its write cannot
   * see it.
   */
  joinProjectBoardLoad(): Promise<void> {
    return this.boardLoad ?? this.loadProjectBoard();
  }

  /**
   * Session-log data for the detail view's history section. Unlike the
   * workspace board this is best-effort: SESSION-LOG.md is a changelog, not a
   * status source, so a failure here must not blank the projects list.
   */
  private async loadProjectLogData(): Promise<void> {
    try {
      const res = await fetch('/api/project-logs');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as { projects: ProjectBoardItem[] };
      this.projectBoard = data.projects || [];
    } catch {
      this.projectBoard = [];
    }
  }

  /** The sidebar list belongs to the workspace board now; keep the selection in sync. */
  private renderProjectList(): void {
    this.host.workspace.setSelected(this.selectedProjectCwd);
    this.host.workspace.renderList();
  }

  private relativeTime(iso: string): string {
    const then = new Date(iso).getTime();
    if (Number.isNaN(then)) return '';
    const secs = Math.max(0, (Date.now() - then) / 1000);
    if (secs < 60) return 'just now';
    const mins = Math.floor(secs / 60);
    if (mins < 60) return `${mins}m ago`;
    const hours = Math.floor(mins / 60);
    if (hours < 24) return `${hours}h ago`;
    const days = Math.floor(hours / 24);
    if (days < 30) return `${days}d ago`;
    const months = Math.floor(days / 30);
    if (months < 12) return `${months}mo ago`;
    return `${Math.floor(months / 12)}y ago`;
  }

  /**
   * Open a project in the main area. The top half is the canonical PROJECT.md
   * feature board (owned by the workspace client); the bottom half is the
   * SESSION-LOG.md history, which remains a changelog view rather than a
   * status source.
   *
   * A project only needs to exist on the workspace board to be shown — it may
   * well have no session log at all, which is the common case now that the
   * board lists every project on disk rather than only those with transcripts.
   */
  showProjectLog(cwd: string): void {
    const wsProject = this.host.workspace.getProject(cwd);
    if (!wsProject) return;
    const logProject = this.projectBoard.find((p) => p.cwd === cwd);
    this.selectedProjectCwd = cwd;
    this.host.workspace.setSelected(cwd);

    // Detach any live session view so the project takes over the main area.
    this.host.detachCurrentSession();
    document.getElementById('terminal-container')?.classList.add('hidden');
    document.getElementById('terminal-header')?.classList.add('hidden');
    document.getElementById('welcome-screen')?.classList.add('hidden');
    this.host.rollup.hide();
    document.getElementById('project-log-view')?.classList.remove('hidden');
    this.host.syncJobOverlay();

    const titleEl = document.getElementById('project-log-title');
    if (titleEl) titleEl.textContent = wsProject.name;
    const pathEl = document.getElementById('project-log-path');
    if (pathEl) pathEl.textContent = wsProject.cwd;
    const badgesEl = document.getElementById('project-badges-row');
    if (badgesEl) badgesEl.innerHTML = this.host.workspace.renderHeaderBadges(wsProject);
    document.getElementById('project-flash')?.classList.add('hidden');

    // Re-sync only makes sense against an existing session log.
    const resyncBtn = document.getElementById('project-log-resync-btn');
    resyncBtn?.classList.toggle('hidden', !logProject?.hasLog);

    const featuresEl = document.getElementById('project-features');
    if (featuresEl) this.host.workspace.renderFeatures(featuresEl, cwd);
    void this.host.workspace.loadQa(cwd);
    void this.host.jobBoard.load(cwd);

    const entriesEl = document.getElementById('project-log-entries');
    if (entriesEl) {
      entriesEl.innerHTML = logProject
        ? this.renderPhaseGroups(logProject.phaseGroups) + this.renderHistorySection(logProject)
        : '';
    }
    this.renderProjectList(); // refresh active highlight
  }

  /** The SESSION-LOG.md history section of the detail view. */
  private renderHistorySection(project: ProjectBoardItem): string {
    if (!project.hasLog) {
      return `<div class="project-history-empty">
          <h3 class="project-log-subhead">Session history</h3>
          <p class="pw-hint">No session log for this project yet.</p>
          <button class="btn-secondary project-generate-btn" data-backfill-cwd="${escapeAttr(
            project.cwd
          )}">Generate session log</button>
        </div>`;
    }
    if (project.entries.length === 0) {
      return '<h3 class="project-log-subhead">Session history</h3><div class="project-empty">No entries yet.</div>';
    }
    return (
      '<h3 class="project-log-subhead">Session history</h3>' +
      project.entries
        .map((e, i) => this.renderLogEntry(e, project.cwd, i, this.countSiblingEntries(project, e)))
        .join('')
    );
  }

  private renderPhaseGroups(groups: PhaseGroup[]): string {
    if (!groups || groups.length === 0) return '';
    const icon = (s: string): string =>
      s === 'done' ? '✓' : s === 'in_progress' ? '◷' : '○';
    const sidChip = (sid: string): string => {
      if (!sid || sid === 'backfill' || sid === 'unknown') return '';
      const short = escapeHtml(sid.slice(0, 8));
      return `<button class="sid-chip" data-copy="${escapeAttr(sid)}" title="Copy session id ${escapeAttr(sid)}">${short}<span class="sid-copy">⧉</span></button>`;
    };
    const renderGroup = (g: PhaseGroup): string => {
      const done = g.items.filter((i) => i.status === 'done').length;
      const rows = g.items
        .map(
          (it) => `
        <li class="phase-item">
          <span class="phase-status ${it.status}" title="${it.status}">${icon(it.status)}</span>
          ${it.id ? `<span class="phase-id">${escapeHtml(it.id)}</span>` : ''}
          <span class="phase-title">${escapeHtml(it.title)}</span>
          <span class="phase-sessions">${it.sessionIds.map(sidChip).join('')}</span>
        </li>`
        )
        .join('');
      return `
        <div class="phase-group">
          <div class="phase-group-head" role="button" tabindex="0" aria-expanded="true">
            <span class="phase-chevron" aria-hidden="true">▾</span>
            <span class="phase-group-name">${escapeHtml(g.group)}</span>
            ${g.source ? `<span class="phase-group-src">${escapeHtml(g.source)}</span>` : ''}
            <span class="phase-progress">${done}/${g.items.length}</span>
          </div>
          <ul class="phase-list">${rows}</ul>
        </div>`;
    };
    return `<div class="phase-groups"><h3 class="project-log-subhead">Plan progress</h3>${groups
      .map(renderGroup)
      .join('')}</div>`;
  }

  /**
   * How many OTHER entries in the same log point at this entry's Claude session.
   * The generator writes one entry per session close, so a long-running
   * conversation has several entries backed by a single transcript file — which
   * the transcript can only be deleted along with.
   */
  private countSiblingEntries(project: ProjectBoardItem, entry: ParsedLogEntry): number {
    const sid = entry.meta?.claudeSessionId;
    if (!sid || sid === 'backfill' || sid === 'unknown') return 0;
    return project.entries.filter((e) => e.meta?.claudeSessionId === sid).length - 1;
  }

  private renderLogEntry(entry: ParsedLogEntry, cwd: string, index: number, siblingCount: number): string {
    const meta = entry.meta;
    const date = meta?.date ? new Date(meta.date) : null;
    const dateStr = date && !Number.isNaN(date.getTime()) ? date.toISOString().slice(0, 10) : '';
    // Strip the marker comment and the "## heading" line; render the rest as the body.
    const lines = entry.body.split('\n');
    const bodyLines = lines.filter((l) => !l.startsWith('<!--') && !l.startsWith('## '));
    // Resume/Fork controls only make sense when the entry carries a real Claude session id.
    const sid = meta?.claudeSessionId;
    const hasSid = !!sid && sid !== 'backfill' && sid !== 'unknown';
    const openButtons = hasSid
      ? `<button class="log-entry-open" data-open-session="${escapeAttr(sid as string)}" data-open-cwd="${escapeAttr(cwd)}" data-open-mode="resume" title="Resume this Claude session">Resume</button>
          <button class="log-entry-open" data-open-session="${escapeAttr(sid as string)}" data-open-cwd="${escapeAttr(cwd)}" data-open-mode="fork" title="Fork this Claude session into a new branch">Fork</button>`
      : '';
    // Delete is offered for every entry, including ones with no usable session id
    // (those are log-only removals — there's no transcript to find).
    const actions = `<span class="log-entry-actions">
          ${openButtons}
          <button class="log-entry-open log-entry-delete" data-delete-entry="${index}" data-delete-cwd="${escapeAttr(cwd)}" data-delete-session="${escapeAttr(hasSid ? (sid as string) : '')}" data-delete-siblings="${siblingCount}" title="Delete this entry and its local conversation">Delete</button>
        </span>`;
    const head = `
      <div class="log-entry-head">
        ${dateStr ? `<span class="log-entry-date">${escapeHtml(dateStr)}</span>` : ''}
        ${meta?.session ? `<span class="log-entry-session">${escapeHtml(meta.session)}</span>` : ''}
        ${meta?.branch ? `<span class="log-entry-branch">${escapeHtml(meta.branch)}</span>` : ''}
        ${actions}
      </div>`;
    return `<div class="log-entry">${head}<div class="log-entry-body">${this.renderMarkdownInline(bodyLines.join('\n'))}</div></div>`;
  }

  /** Minimal, safe markdown: escape first, then bold + inline code + paragraphs. */
  private renderMarkdownInline(md: string): string {
    const escaped = escapeHtml(md);
    return escaped
      .split(/\n{2,}/)
      .map((para) => {
        const withInline = para
          .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
          .replace(/`([^`]+)`/g, '<code>$1</code>')
          .replace(/\n/g, '<br>');
        return `<p>${withInline}</p>`;
      })
      .join('');
  }

  /**
   * Confirm removal of one session-history entry. Wording depends on what the
   * click will actually destroy: an entry whose conversation is referenced by
   * other entries can't take the transcript with it unless the user opts into
   * clearing all of them, so the checkbox appears only in that case.
   */
  showDeleteEntryModal(target: {
    cwd: string;
    entryIndex: number;
    claudeSessionId: string | null;
    siblingCount: number;
  }): void {
    if (!target.cwd || !Number.isInteger(target.entryIndex) || target.entryIndex < 0) return;
    this.pendingHistoryDelete = target;

    const { claudeSessionId: sid, siblingCount } = target;
    const shortSid = sid ? sid.slice(0, 8) : '';
    let summary: string;
    if (!sid) {
      summary =
        'Remove this entry from <code>SESSION-LOG.md</code>. It carries no Claude session id, so there is no local conversation to delete.';
    } else if (siblingCount > 0) {
      summary =
        `Remove this entry from <code>SESSION-LOG.md</code>. ${siblingCount} other ` +
        `${siblingCount === 1 ? 'entry' : 'entries'} also came from conversation <code>${escapeHtml(shortSid)}</code>, ` +
        `so its local transcript is kept unless you delete ${siblingCount === 1 ? 'both' : 'all of them'}.`;
    } else {
      summary =
        `Remove this entry from <code>SESSION-LOG.md</code> and permanently delete the local ` +
        `conversation <code>${escapeHtml(shortSid)}.jsonl</code>. It can no longer be resumed or forked. This cannot be undone.`;
    }
    const summaryEl = document.getElementById('delete-entry-summary');
    if (summaryEl) summaryEl.innerHTML = summary;

    const allRow = document.getElementById('delete-entry-all-row');
    const allBox = document.getElementById('delete-entry-all') as HTMLInputElement | null;
    const allLabel = document.getElementById('delete-entry-all-label');
    const showAll = !!sid && siblingCount > 0;
    allRow?.classList.toggle('hidden', !showAll);
    if (allBox) allBox.checked = false;
    if (allLabel && showAll) {
      allLabel.textContent = `Delete all ${siblingCount + 1} entries for this conversation, and the conversation itself`;
    }

    const errEl = document.getElementById('delete-entry-error');
    errEl?.classList.add('hidden');
    const confirmBtn = document.getElementById('delete-entry-confirm') as HTMLButtonElement | null;
    if (confirmBtn) {
      confirmBtn.disabled = false;
      confirmBtn.textContent = 'Delete';
    }
    document.getElementById('delete-entry-modal')?.classList.remove('hidden');
  }

  hideDeleteEntryModal(): void {
    document.getElementById('delete-entry-modal')?.classList.add('hidden');
    this.pendingHistoryDelete = null;
  }

  async confirmDeleteEntry(): Promise<void> {
    const target = this.pendingHistoryDelete;
    if (!target) return;
    const allRow = document.getElementById('delete-entry-all-row');
    const allBox = document.getElementById('delete-entry-all') as HTMLInputElement | null;
    const scope = allBox?.checked && allRow && !allRow.classList.contains('hidden') ? 'conversation' : 'entry';
    const confirmBtn = document.getElementById('delete-entry-confirm') as HTMLButtonElement | null;
    const errEl = document.getElementById('delete-entry-error');
    if (confirmBtn) {
      confirmBtn.disabled = true;
      confirmBtn.textContent = 'Deleting...';
    }
    try {
      const res = await fetch('/api/project-logs/entry/delete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          cwd: target.cwd,
          entryIndex: target.entryIndex,
          claudeSessionId: target.claudeSessionId,
          scope,
        }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error || `HTTP ${res.status}`);
      }
      this.hideDeleteEntryModal();
      // Refresh the board, then re-render the open project so the entry disappears.
      await this.loadProjectBoard();
      if (this.selectedProjectCwd) this.showProjectLog(this.selectedProjectCwd);
    } catch (err) {
      if (errEl) {
        errEl.textContent = err instanceof Error ? err.message : 'Delete failed';
        errEl.classList.remove('hidden');
      }
      if (confirmBtn) {
        confirmBtn.disabled = false;
        confirmBtn.textContent = 'Delete';
      }
    }
  }

  async resyncSelectedProject(): Promise<void> {
    const cwd = this.selectedProjectCwd;
    if (!cwd) return;
    const btn = document.getElementById('project-log-resync-btn') as HTMLButtonElement | null;
    const original = btn?.textContent ?? 'Re-sync plan';
    if (btn) {
      btn.disabled = true;
      btn.textContent = 'Re-syncing…';
    }
    try {
      const res = await fetch('/api/project-logs/resync', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cwd }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      await this.loadProjectBoard();
      // Re-render the detail view with the refreshed phases (still on this project).
      if (this.selectedProjectCwd === cwd) this.showProjectLog(cwd);
    } catch {
      if (btn) btn.textContent = 'Re-sync failed';
    } finally {
      if (btn) {
        btn.disabled = false;
        setTimeout(() => {
          if (btn) btn.textContent = original;
        }, 1500);
      }
    }
  }

  openSessionForSelectedProject(): void {
    if (!this.selectedProjectCwd) return;
    // Open the modal over the project view. If the user cancels, the project log
    // stays put; if they create a session, showTerminal() takes over the area.
    this.host.showNewSessionModal(this.selectedProjectCwd);
  }

  async backfillProject(cwd: string, btn: HTMLButtonElement): Promise<void> {
    this.failedBackfills.delete(cwd);
    btn.disabled = true;
    btn.textContent = 'Generating…';
    try {
      const res = await fetch('/api/project-logs/backfill', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cwds: [cwd] }),
      });
      if (!res.ok && res.status !== 202) throw new Error(`HTTP ${res.status}`);
      // Backfill is async on the server; poll the board until this project's log appears.
      this.pollBackfill(cwd, 0);
    } catch {
      btn.disabled = false;
      btn.textContent = 'Retry';
    }
  }

  private pollBackfill(cwd: string, attempt: number): void {
    // Timers are keyed by cwd so concurrent backfills each poll independently.
    const existing = this.backfillPollTimers.get(cwd);
    if (existing) clearTimeout(existing);
    if (attempt > 40) {
      // Gave up waiting — the run never produced a log. Surface a Retry affordance.
      this.backfillPollTimers.delete(cwd);
      this.failedBackfills.add(cwd);
      void this.loadProjectBoard();
      return;
    }
    const timer = setTimeout(async () => {
      await this.loadProjectBoard();
      const project = this.projectBoard.find((p) => p.cwd === cwd);
      if (this.activeTab === 'projects' && !project?.hasLog) {
        this.pollBackfill(cwd, attempt + 1);
      } else {
        this.backfillPollTimers.delete(cwd);
      }
    }, 3000);
    this.backfillPollTimers.set(cwd, timer);
  }
}
