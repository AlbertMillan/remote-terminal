import { escapeHtml, escapeAttr } from './html-utils.js';

/**
 * Client for the job pipeline: dispatching a feature, watching its stages, and
 * acting at the gates.
 *
 * Mirrors src/server/jobs/types.ts. Jobs are polled rather than pushed while a
 * job is live; a parked job changes only when the user acts on it, so polling
 * stops as soon as nothing is running.
 */

export type StageName =
  | 'design'
  | 'implement'
  | 'integrate'
  | 'review'
  | 'fix'
  | 'qa'
  | 'merge'
  | 'rebuild';

export type JobStatus = 'queued' | 'running' | 'parked' | 'done' | 'failed' | 'cancelled';
export type StageStatus = 'pending' | 'running' | 'passed' | 'skipped' | 'failed';
export type ParkReason = 'gate' | 'question';

export interface JobStage {
  name: StageName;
  status: StageStatus;
  detail: string | null;
  startedAt: string | null;
  finishedAt: string | null;
}

export interface Job {
  id: string;
  projectCwd: string;
  featureId: string | null;
  title: string;
  status: JobStatus;
  stage: StageName | null;
  gate: string | null;
  approvedGate: string | null;
  parkReason: ParkReason | null;
  detail: string | null;
  worktreePath: string | null;
  branch: string | null;
  claudeSessionId: string | null;
  createdAt: string;
  updatedAt: string;
  stages: JobStage[];
}

const STAGE_ICON: Record<StageStatus, string> = {
  pending: '·',
  running: '◐',
  passed: '✓',
  skipped: '−',
  failed: '✕',
};

export interface DiffStat {
  files: number;
  insertions: number;
  deletions: number;
}

/** How often to re-poll while any job is still moving. */
const POLL_MS = 4000;

export class JobBoard {
  private jobs: Job[] = [];
  private cwd: string | null = null;
  private pollTimer: number | null = null;
  /** Spec text keyed by job id, fetched lazily when a gate is opened. */
  private specs = new Map<string, string>();
  /** Diff text keyed by job id, fetched lazily at the merge gate. */
  private diffs = new Map<string, { diff: string; stat: DiffStat | null; truncated: boolean }>();
  private expanded = new Set<string>();

  constructor(private readonly onTakeOver: (claudeSessionId: string, cwd: string) => void) {}

  /** Jobs currently shown, for callers that need counts. */
  getJobs(): Job[] {
    return this.jobs;
  }

  jobsForFeature(featureId: string): Job[] {
    return this.jobs.filter((j) => j.featureId === featureId);
  }

  // --- Loading -----------------------------------------------------------

  async load(cwd: string): Promise<void> {
    this.cwd = cwd;
    try {
      const res = await fetch(`/api/jobs?cwd=${encodeURIComponent(cwd)}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as { jobs: Job[] };
      this.jobs = data.jobs || [];
    } catch {
      this.jobs = [];
    }
    this.render();
    this.schedulePoll();
  }

  /**
   * Keep polling only while something can still change on its own. A parked job
   * waits on the user, so there is nothing to poll for.
   */
  private schedulePoll(): void {
    this.stopPolling();
    const moving = this.jobs.some((j) => j.status === 'running' || j.status === 'queued');
    if (!moving || !this.cwd) return;
    this.pollTimer = window.setTimeout(() => {
      if (this.cwd) void this.load(this.cwd);
    }, POLL_MS);
  }

  stopPolling(): void {
    if (this.pollTimer !== null) {
      window.clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }
  }

  // --- Rendering ---------------------------------------------------------

  render(): void {
    const container = document.getElementById('project-jobs');
    if (!container) return;
    if (this.jobs.length === 0) {
      container.innerHTML = '';
      return;
    }
    container.innerHTML = `
      <div class="jb-section">
        <h3 class="project-log-subhead">Jobs</h3>
        ${this.jobs.map((job) => this.renderJob(job)).join('')}
      </div>`;
  }

  private renderJob(job: Job): string {
    const open = this.expanded.has(job.id);
    return `
      <div class="jb-job ${job.status}" data-job="${escapeAttr(job.id)}">
        <div class="jb-head" data-toggle="${escapeAttr(job.id)}">
          <span class="jb-state ${job.status}">${this.stateLabel(job)}</span>
          <span class="jb-title">${escapeHtml(job.title)}</span>
          ${job.branch ? `<code class="jb-branch">${escapeHtml(job.branch)}</code>` : ''}
          <span class="jb-chevron">${open ? '▾' : '▸'}</span>
        </div>
        ${this.renderPipeline(job)}
        ${open ? this.renderBody(job) : ''}
        ${this.renderActions(job)}
      </div>`;
  }

  private stateLabel(job: Job): string {
    if (job.status === 'running') return `running · ${job.stage ?? ''}`;
    if (job.status === 'parked') {
      return job.parkReason === 'question' ? 'needs a decision' : `waiting · ${job.stage ?? ''}`;
    }
    return job.status;
  }

  private renderPipeline(job: Job): string {
    return `
      <div class="jb-pipeline">
        ${job.stages
          .map(
            (s) => `<span class="jb-stage ${s.status}" title="${escapeAttr(
              `${s.name}: ${s.status}${s.detail ? ` — ${s.detail}` : ''}`
            )}">${STAGE_ICON[s.status]} ${escapeHtml(s.name)}</span>`
          )
          .join('')}
      </div>`;
  }

  private renderBody(job: Job): string {
    const spec = this.specs.get(job.id);
    const parts: string[] = [];

    if (job.parkReason === 'question' && job.detail) {
      parts.push(`
        <div class="jb-question">
          <div class="jb-question-label">This run stopped rather than guess:</div>
          <div class="jb-question-text">${escapeHtml(job.detail)}</div>
          <form class="jb-answer" data-job="${escapeAttr(job.id)}">
            <input type="text" class="jb-answer-input" placeholder="Your decision…"
                   aria-label="Answer" maxlength="500" />
            <button type="submit" class="btn-secondary">Answer &amp; continue</button>
          </form>
        </div>`);
    } else if (job.detail) {
      parts.push(`<div class="jb-detail">${escapeHtml(job.detail)}</div>`);
    }

    if (spec !== undefined) {
      parts.push(
        spec
          ? `<pre class="jb-spec">${escapeHtml(spec)}</pre>`
          : '<div class="pw-hint">No spec written yet.</div>'
      );
    }

    const diff = this.diffs.get(job.id);
    if (diff !== undefined) {
      const stat = diff.stat
        ? `${diff.stat.files} files +${diff.stat.insertions}/-${diff.stat.deletions}`
        : '';
      parts.push(
        diff.diff
          ? `<div class="jb-diff-head">${escapeHtml(stat)}${
              diff.truncated ? ' · truncated' : ''
            }</div><pre class="jb-diff">${this.highlightDiff(diff.diff)}</pre>`
          : '<div class="pw-hint">No changes on this branch yet.</div>'
      );
    }
    return parts.join('');
  }

  /** Escape first, then colour by diff prefix — never the other way round. */
  private highlightDiff(diff: string): string {
    return escapeHtml(diff)
      .split('\n')
      .map((line) => {
        if (line.startsWith('+++') || line.startsWith('---')) return `<span class="d-meta">${line}</span>`;
        if (line.startsWith('@@')) return `<span class="d-hunk">${line}</span>`;
        if (line.startsWith('diff --git')) return `<span class="d-file">${line}</span>`;
        if (line.startsWith('+')) return `<span class="d-add">${line}</span>`;
        if (line.startsWith('-')) return `<span class="d-del">${line}</span>`;
        return line;
      })
      .join('\n');
  }

  private renderActions(job: Job): string {
    const id = escapeAttr(job.id);
    const buttons: string[] = [];

    if (job.status === 'parked' && job.parkReason === 'gate') {
      // Spell out what approving the merge gate actually sets in motion.
      const label = job.gate === 'merge' ? 'Approve &amp; merge' : 'Approve';
      buttons.push(`<button class="btn-primary jb-approve" data-job="${id}">${label}</button>`);
    }
    if (job.stages.some((s) => s.name === 'design' && s.status === 'passed')) {
      const shown = this.specs.has(job.id);
      buttons.push(
        `<button class="btn-secondary jb-spec-btn" data-job="${id}">${
          shown ? 'Hide spec' : 'View spec'
        }</button>`
      );
    }
    if (job.stages.some((s) => s.name === 'implement' && s.status === 'passed')) {
      buttons.push(
        `<button class="btn-secondary jb-diff-btn" data-job="${id}">${
          this.diffs.has(job.id) ? 'Hide diff' : 'View diff'
        }</button>`
      );
    }
    // Taking over resumes the run's own conversation in a real terminal, which
    // is the escape hatch whenever the pipeline can't finish something itself.
    if (job.claudeSessionId && job.worktreePath) {
      buttons.push(
        `<button class="btn-secondary jb-takeover" data-job="${id}"
                 title="Continue this run's conversation in a terminal">Take over</button>`
      );
    }
    if (job.status === 'queued' || job.status === 'running' || job.status === 'parked') {
      buttons.push(`<button class="btn-secondary jb-cancel" data-job="${id}">Cancel</button>`);
    }
    return buttons.length ? `<div class="jb-actions">${buttons.join('')}</div>` : '';
  }

  // --- Actions -----------------------------------------------------------

  async dispatch(cwd: string, featureId: string | null, title: string): Promise<boolean> {
    try {
      const res = await fetch('/api/jobs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cwd, featureId, title }),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        this.flash(data.error || `Could not dispatch (${res.status})`);
        return false;
      }
      await this.load(cwd);
      return true;
    } catch (error) {
      this.flash(error instanceof Error ? error.message : 'Could not dispatch');
      return false;
    }
  }

  private async act(jobId: string, action: string, body?: Record<string, unknown>): Promise<void> {
    try {
      const res = await fetch(`/api/jobs/${encodeURIComponent(jobId)}/${action}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: body ? JSON.stringify(body) : undefined,
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        this.flash(data.error || `Request failed (${res.status})`);
        return;
      }
      if (this.cwd) await this.load(this.cwd);
    } catch (error) {
      this.flash(error instanceof Error ? error.message : 'Request failed');
    }
  }

  private async toggleSpec(jobId: string): Promise<void> {
    if (this.specs.has(jobId)) {
      this.specs.delete(jobId);
      this.render();
      return;
    }
    this.expanded.add(jobId);
    try {
      const res = await fetch(`/api/jobs/${encodeURIComponent(jobId)}/spec`);
      const data = (await res.json()) as { spec: string | null };
      this.specs.set(jobId, data.spec || '');
    } catch {
      this.specs.set(jobId, '');
    }
    this.render();
  }

  private async toggleDiff(jobId: string): Promise<void> {
    if (this.diffs.has(jobId)) {
      this.diffs.delete(jobId);
      this.render();
      return;
    }
    this.expanded.add(jobId);
    try {
      const res = await fetch(`/api/jobs/${encodeURIComponent(jobId)}/diff`);
      const data = (await res.json()) as {
        diff: string;
        stat: DiffStat | null;
        truncated?: boolean;
      };
      this.diffs.set(jobId, {
        diff: data.diff || '',
        stat: data.stat,
        truncated: !!data.truncated,
      });
    } catch {
      this.diffs.set(jobId, { diff: '', stat: null, truncated: false });
    }
    this.render();
  }

  private takeOver(jobId: string): void {
    const job = this.jobs.find((j) => j.id === jobId);
    if (!job?.claudeSessionId || !job.worktreePath) return;
    // Resume inside the worktree, not the project root: that is where the run's
    // work actually lives.
    this.onTakeOver(job.claudeSessionId, job.worktreePath);
  }

  private flash(message: string): void {
    const el = document.getElementById('project-flash');
    if (!el) return;
    el.textContent = message;
    el.classList.remove('hidden');
    window.setTimeout(() => el.classList.add('hidden'), 6000);
  }

  /** One delegated listener, so re-rendering never leaks handlers. */
  attach(container: HTMLElement): void {
    container.addEventListener('click', (event) => {
      const target = event.target as HTMLElement;

      const approve = target.closest('.jb-approve') as HTMLElement | null;
      if (approve) return void this.act(approve.dataset.job || '', 'approve');

      const cancel = target.closest('.jb-cancel') as HTMLElement | null;
      if (cancel) {
        const job = this.jobs.find((j) => j.id === cancel.dataset.job);
        if (confirm(`Cancel "${job?.title ?? 'this job'}" and remove its worktree?`)) {
          void this.act(cancel.dataset.job || '', 'cancel');
        }
        return;
      }

      const spec = target.closest('.jb-spec-btn') as HTMLElement | null;
      if (spec) return void this.toggleSpec(spec.dataset.job || '');

      const diff = target.closest('.jb-diff-btn') as HTMLElement | null;
      if (diff) return void this.toggleDiff(diff.dataset.job || '');

      const takeover = target.closest('.jb-takeover') as HTMLElement | null;
      if (takeover) return this.takeOver(takeover.dataset.job || '');

      const head = target.closest('[data-toggle]') as HTMLElement | null;
      if (head) {
        const id = head.dataset.toggle || '';
        if (this.expanded.has(id)) this.expanded.delete(id);
        else this.expanded.add(id);
        this.render();
      }
    });

    container.addEventListener('submit', (event) => {
      const form = (event.target as HTMLElement).closest('.jb-answer') as HTMLFormElement | null;
      if (!form) return;
      event.preventDefault();
      const input = form.querySelector('.jb-answer-input') as HTMLInputElement | null;
      const answer = input?.value.trim();
      if (!answer) return;
      void this.act(form.dataset.job || '', 'answer', { answer });
    });
  }
}
