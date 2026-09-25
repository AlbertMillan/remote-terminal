import { escapeHtml, escapeAttr } from './html-utils.js';
import {
  hasSpend,
  formatUsageCost,
  usageTooltip,
  usageOf,
  isQueued,
  elapsedSince,
  type StageName,
  type JobStatus,
  type StageStatus,
  type ParkReason,
  type StageUsage,
  type ProjectUsage,
  type JobStage,
  type Job,
  type Severity,
  type Finding,
  type DiffStat,
  BODYLESS_POST,
  jsonPost,
} from './job-board-types.js';
import { renderDocs, specPathOf, highlightDiff, type JobDoc } from './job-board-docs.js';
import { renderDecision, renderFindings } from './job-board-decision.js';

export type {
  StageName,
  JobStatus,
  StageStatus,
  ParkReason,
  StageUsage,
  ProjectUsage,
  JobStage,
  Job,
  Severity,
  Finding,
  DiffStat,
  JobDoc,
};
export { hasSpend, formatUsageCost, usageTooltip, usageOf, isQueued, elapsedSince, BODYLESS_POST, jsonPost };
export {
  formatTokens,
  formatCost,
  projectUsageTooltip,
} from './job-board-types.js';

/**
 * Client for the job pipeline: dispatching a feature, watching its stages, and
 * acting at the gates.
 *
 * Mirrors src/server/jobs/types.ts. Jobs are polled rather than pushed while a
 * job is live; a parked job changes only when the user acts on it, so polling
 * stops as soon as nothing is running.
 */

const STAGE_ICON: Record<StageStatus, string> = {
  pending: '·',
  running: '◐',
  passed: '✓',
  skipped: '−',
  failed: '✕',
  // Deliberately not a tick: the stage ran but is waiting on the user.
  needs_decision: '?',
};

/** How often to re-poll while any job is still moving. */
const POLL_MS = 4000;

export class JobBoard {
  private jobs: Job[] = [];
  private cwd: string | null = null;
  private pollTimer: number | null = null;
  /**
   * The documents behind each job, keyed by job id.
   *
   * Loaded eagerly for a job parked on a question — the question cites them, so
   * the card is not readable without them — and on request for anything else.
   */
  private docs = new Map<string, JobDoc[]>();
  /** Which document is open on a job, and whether as text or as this job's diff. */
  private openDoc = new Map<string, { path: string; mode: 'text' | 'diff' }>();
  /** Document bodies, keyed `jobId|mode|path`. */
  private docBodies = new Map<string, { body: string; truncated: boolean }>();
  /** Jobs whose unchanged-document tail the user has unfolded. */
  private docsExpanded = new Set<string>();
  /**
   * Jobs whose document pane is folded away.
   *
   * Kept apart from the cache above on purpose: folding is presentational, and
   * the list itself has to stay loaded whether or not it is on screen, because
   * the references inside a parked question resolve against it.
   */
  private docsCollapsed = new Set<string>();
  /** A section to scroll to once the document it lives in has rendered. */
  private pendingAnchor: { jobId: string; section: string } | null = null;
  /**
   * A job whose fold control should get focus back after the next render.
   *
   * The head folds through render(), which replaces the board's HTML wholesale
   * — so the button destroys itself on its own click and focus falls back to
   * <body>. Without this a keyboard user cannot press Space twice to fold and
   * unfold; they have to tab through the whole card again.
   */
  private refocusDocsHead: string | null = null;
  /** Diff text keyed by job id, fetched lazily at the merge gate. */
  private diffs = new Map<string, { diff: string; stat: DiffStat | null; truncated: boolean }>();
  /** Findings keyed by job id, loaded when a job parks at the review gate. */
  private findings = new Map<string, Finding[]>();
  private expanded = new Set<string>();
  /** A job the overlay asked to show, applied by the next render. */
  private pendingFocus: string | null = null;
  /**
   * Answers typed but not yet sent, keyed `jobId#questionNumber`.
   *
   * Every render replaces the board's HTML wholesale, and opening a spec or
   * ticking a finding renders. Half a decision is expensive to retype, so it is
   * read back out of the DOM before it is thrown away.
   */
  private answerDrafts = new Map<string, string>();
  /**
   * Incremented on every load. A response whose token is stale belongs to a
   * project the user has already navigated away from, and rendering it would
   * show one project's jobs under another's name.
   */
  private loadToken = 0;

  constructor(private readonly onTakeOver: (claudeSessionId: string, cwd: string) => void) {}

  /** Jobs currently shown, for callers that need counts. */
  getJobs(): Job[] {
    return this.jobs;
  }

  jobsForFeature(featureId: string): Job[] {
    return this.jobs.filter((j) => j.featureId === featureId);
  }

  /**
   * Expand a job and scroll it into view — how the live overlay hands a job
   * over to the board.
   *
   * The caller may arrive before or after this project's jobs have loaded, so
   * the request is remembered and applied by whichever render comes next
   * rather than requiring the two to be sequenced.
   */
  focusJob(jobId: string): void {
    this.expanded.add(jobId);
    this.pendingFocus = jobId;
    if (this.jobs.some((j) => j.id === jobId)) this.render();
  }

  /** Scroll to a job the overlay asked for, once it is actually on the page. */
  private applyPendingFocus(container: HTMLElement): void {
    if (!this.pendingFocus) return;
    // Matched by dataset rather than a selector: job ids come from the server
    // and never need escaping, but nothing here has to know that.
    const el = [...container.querySelectorAll<HTMLElement>('[data-job]')].find(
      (node) => node.dataset.job === this.pendingFocus
    );
    if (!el) return;
    this.pendingFocus = null;
    el.scrollIntoView({ block: 'center', behavior: 'smooth' });
    el.classList.add('jb-focused');
    window.setTimeout(() => el.classList.remove('jb-focused'), 2000);
  }

  // --- Loading -----------------------------------------------------------

  async load(cwd: string): Promise<void> {
    const token = ++this.loadToken;
    // Switching project strands every cached detail for the old one's jobs, and
    // a cached diff runs to MAX_DIFF_CHARS apiece — so drop them rather than
    // carry another project's scrollback around for the life of the page.
    if (this.cwd !== cwd) this.forgetCachedDetail();
    this.cwd = cwd;

    let jobs: Job[] = [];
    try {
      const res = await fetch(`/api/jobs?cwd=${encodeURIComponent(cwd)}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as { jobs: Job[] };
      jobs = data.jobs || [];
    } catch {
      jobs = [];
    }
    if (token !== this.loadToken) return; // superseded by a newer load

    this.jobs = jobs;
    await Promise.all([this.loadFindingsForGates(), this.loadDocsForParked()]);
    if (token !== this.loadToken) return;

    this.render();
    this.schedulePoll();
  }

  /**
   * Fetch findings for jobs parked at the review gate. Done eagerly rather than
   * behind a button: the gate is meaningless without the list it is asking
   * about.
   */
  private async loadFindingsForGates(): Promise<void> {
    const waiting = this.jobs.filter(
      (j) => j.status === 'parked' && j.gate === 'review' && !this.findings.has(j.id)
    );
    await Promise.all(
      waiting.map(async (job) => {
        try {
          const res = await fetch(`/api/jobs/${encodeURIComponent(job.id)}/findings`);
          const data = (await res.json()) as { findings: Finding[] };
          this.findings.set(job.id, data.findings || []);
          this.expanded.add(job.id);
        } catch {
          this.findings.set(job.id, []);
        }
      })
    );
  }

  /**
   * Fetch the documents a parked job is waiting on, before they are asked for —
   * no park is readable without the thing it is about, and a question's
   * citations only become links once this list is here.
   *
   * The pane itself starts FOLDED: this fetch is the board's initiative rather
   * than a request to read the list. Folding only on this FIRST fetch is what
   * the `!this.docs.has()` selection above buys — fold anywhere else and a poll
   * re-folds a pane the user just opened.
   *
   * A live job's list is refetched only when already on screen: it changes as
   * stages run, and a stale list of what a run touched is worse than none.
   */
  private async loadDocsForParked(): Promise<void> {
    const parked = this.jobs.filter((j) => j.status === 'parked' && !this.docs.has(j.id));
    const live = this.jobs.filter(
      (j) => (j.status === 'running' || j.status === 'queued') && this.docs.has(j.id)
    );
    await Promise.all([...parked, ...live].map((job) => this.fetchDocs(job.id)));
    for (const job of parked) {
      if (job.parkReason === 'question') this.expanded.add(job.id);
      this.docsCollapsed.add(job.id);
    }
  }

  /** Load a job's document list into the cache. Empty on any failure. */
  private async fetchDocs(jobId: string): Promise<void> {
    try {
      const res = await fetch(`/api/jobs/${encodeURIComponent(jobId)}/docs`);
      const data = (await res.json()) as { docs: JobDoc[] };
      this.docs.set(jobId, data.docs || []);
    } catch {
      this.docs.set(jobId, []);
    }
  }

  /** Drop every per-job detail cache. */
  private forgetCachedDetail(): void {
    this.docs.clear();
    this.openDoc.clear();
    this.docBodies.clear();
    this.docsExpanded.clear();
    this.docsCollapsed.clear();
    this.diffs.clear();
    this.findings.clear();
    this.expanded.clear();
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
    this.captureDrafts(container);
    if (this.jobs.length === 0) {
      container.innerHTML = '';
      return;
    }
    container.innerHTML = `
      <div class="jb-section">
        <h3 class="project-log-subhead">Jobs</h3>
        ${this.jobs.map((job) => this.renderJob(job)).join('')}
      </div>`;
    this.applyPendingFocus(container);
    this.applyPendingAnchor(container);
    this.applyRefocusDocsHead(container);
  }

  /** Put focus back on the fold control that its own render just destroyed. */
  private applyRefocusDocsHead(container: HTMLElement): void {
    const jobId = this.refocusDocsHead;
    if (!jobId) return;
    this.refocusDocsHead = null;
    const head = [...container.querySelectorAll<HTMLButtonElement>('.jb-docs-head')].find(
      (node) => node.dataset.job === jobId
    );
    head?.focus();
  }

  private renderJob(job: Job): string {
    const open = this.expanded.has(job.id);
    return `
      <div class="jb-job ${job.status}" data-job="${escapeAttr(job.id)}">
        <div class="jb-head" data-toggle="${escapeAttr(job.id)}">
          <span class="jb-state ${job.status}">${this.stateLabel(job)}</span>
          <span class="jb-title">${escapeHtml(job.title)}</span>
          ${this.qaChip(job)}
          ${this.usageChip(job)}
          ${job.branch ? `<code class="jb-branch">${escapeHtml(job.branch)}</code>` : ''}
          <span class="jb-chevron">${open ? '▾' : '▸'}</span>
        </div>
        ${this.renderPipeline(job)}
        ${open ? this.renderBody(job) : ''}
        ${this.renderActions(job)}
      </div>`;
  }

  /** A short warning chip for the collapsed row when checks did not run. */
  private qaChip(job: Job): string {
    const qa = job.stages.find((s) => s.name === 'qa');
    if (!qa) return '';
    if (qa.status === 'failed') return '<span class="jb-qa-chip failed">QA failed</span>';
    if (qa.status === 'skipped') return '<span class="jb-qa-chip skipped">QA not run</span>';
    return '';
  }

  /** What this job has cost so far, Take over included. Absent until it spent anything. */
  private usageChip(job: Job): string {
    const usage = usageOf(job);
    if (!hasSpend(usage)) return '';
    return `<span class="jb-usage" title="${escapeAttr(usageTooltip(usage))}">${escapeHtml(
      formatUsageCost(usage)
    )}</span>`;
  }

  private stateLabel(job: Job): string {
    if (job.status === 'running') {
      const active = job.stages.find((s) => s.status === 'running');
      if (active && isQueued(active)) {
        // Named for what it is waiting on: another run in this same project.
        const waited = elapsedSince(active.startedAt);
        return `queued · ${active.name}${waited ? ` · ${waited}` : ''}`;
      }
      const ran = active ? elapsedSince(active.spawnedAt ?? active.startedAt) : '';
      return `running · ${job.stage ?? ''}${ran ? ` · ${ran}` : ''}`;
    }
    if (job.status === 'parked') {
      return job.parkReason === 'question' ? 'needs a decision' : `waiting · ${job.stage ?? ''}`;
    }
    return job.status;
  }

  private renderPipeline(job: Job): string {
    return `
      <div class="jb-pipeline">
        ${job.stages
          .map((s) => {
            const queued = isQueued(s);
            const what = queued
              ? `waiting for another run in this project to finish (${elapsedSince(s.startedAt)})`
              : `${s.status}${s.detail ? ` — ${s.detail}` : ''}`;
            return `<span class="jb-stage ${queued ? 'queued' : s.status}" title="${escapeAttr(
              `${s.name}: ${what}` +
                (hasSpend(usageOf(s)) ? `
${usageTooltip(usageOf(s))}` : '')
            )}">${queued ? '⋯' : STAGE_ICON[s.status]} ${escapeHtml(s.name)}</span>`;
          })
          .join('')}
      </div>`;
  }

  private renderBody(job: Job): string {
    const parts: string[] = [];

    if (job.parkReason === 'question' && job.detail) {
      parts.push(renderDecision(job, this.answerDrafts, this.docs));
    } else if (job.detail) {
      parts.push(`<div class="jb-detail">${escapeHtml(job.detail)}</div>`);
    }

    const docs = this.docs.get(job.id);
    if (docs !== undefined) {
      parts.push(renderDocs(job, docs, this.docsExpanded, this.docsCollapsed, this.openDoc, this.docBodies));
    }

    const notRun = job.stages.filter((st) => st.status === 'skipped' && st.detail);
    if (notRun.length > 0) {
      // Skips must be visible before the merge gate, not buried in a tooltip:
      // approving a merge means knowing which checks did not actually run.
      parts.push(`
        <div class="jb-skips">
          <div class="jb-skips-label">Not verified</div>
          <ul>${notRun
            .map(
              (st) =>
                `<li><code>${escapeHtml(st.name)}</code> ${escapeHtml(st.detail as string)}</li>`
            )
            .join('')}</ul>
        </div>`);
    }

    const findings = this.findings.get(job.id);
    if (findings && job.gate === 'review') {
      parts.push(renderFindings(job, findings));
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
            }</div><pre class="jb-diff">${highlightDiff(diff.diff)}</pre>`
          : '<div class="pw-hint">No changes on this branch yet.</div>'
      );
    }
    return parts.join('');
  }

  /**
   * Send the decision.
   *
   * With more than one question the answers go over labelled by the question
   * they belong to. The stage re-runs from its own prompt with this text folded
   * in, and "stop" on its own does not say which of two questions it settles.
   *
   * Every box has to be filled: sending a partial answer would restart a stage
   * that is still missing what it stopped for.
   */
  private async submitAnswer(form: HTMLFormElement): Promise<void> {
    const jobId = form.dataset.job || '';
    const inputs = Array.from(form.querySelectorAll('.jb-answer-input')) as HTMLInputElement[];
    if (inputs.length === 0) return;

    const blank = inputs.find((input) => !input.value.trim());
    if (blank) {
      blank.focus();
      this.flash(
        inputs.length > 1 ? 'Answer every question before continuing.' : 'Type a decision first.'
      );
      return;
    }

    const answer =
      inputs.length === 1
        ? inputs[0].value.trim()
        : inputs
            .map((input, i) => `${i + 1}) ${input.dataset.question || ''}\n   ${input.value.trim()}`)
            .join('\n');

    if (await this.act(jobId, 'answer', { answer })) {
      for (const input of inputs) this.answerDrafts.delete(`${jobId}#${input.dataset.index}`);
    }
  }

  /** Read part-written answers out of the DOM before a render discards them. */
  private captureDrafts(container: HTMLElement): void {
    for (const el of Array.from(container.querySelectorAll('.jb-answer-input'))) {
      const input = el as HTMLInputElement;
      const jobId = (input.closest('.jb-answer') as HTMLElement | null)?.dataset.job;
      if (!jobId) continue;
      const key = `${jobId}#${input.dataset.index}`;
      if (input.value.trim()) this.answerDrafts.set(key, input.value);
      else this.answerDrafts.delete(key);
    }
  }

  private renderActions(job: Job): string {
    const id = escapeAttr(job.id);
    const buttons: string[] = [];

    if (job.status === 'parked' && job.parkReason === 'gate') {
      // Spell out what approving the merge gate actually sets in motion.
      const label =
        job.gate === 'merge'
          ? 'Approve &amp; merge'
          : job.gate === 'review'
            ? this.approveReviewLabel(job)
            : 'Approve';
      buttons.push(`<button class="btn-primary jb-approve" data-job="${id}">${label}</button>`);
    }
    // The spec is a row in the document pane, so this is a shortcut to it
    // rather than a second viewer — two surfaces on one file drift apart the
    // first time either changes. Offered for a design that parked on a question
    // too: that spec is exactly what the question is about.
    const specPath = specPathOf(job, this.docs);
    if (specPath) {
      const shown = this.openDoc.get(job.id)?.path === specPath;
      buttons.push(
        `<button class="btn-secondary jb-spec-btn" data-job="${id}"
                 data-path="${escapeAttr(specPath)}">${shown ? 'Hide spec' : 'View spec'}</button>`
      );
    }
    if (job.worktreePath) {
      // Not gated on the implement stage: a design that only wrote documents
      // has a diff worth reading, and it is the one thing that says what it
      // changed.
      buttons.push(
        `<button class="btn-secondary jb-diff-btn" data-job="${id}">${
          this.diffs.has(job.id) ? 'Hide diff' : 'View diff'
        }</button>`
      );
      // The entry point for a job whose list has never been fetched — there is
      // no pane to click the chevron on yet. Offered on a job parked on a
      // question too, now that hiding is a fold rather than a delete: the
      // references in the question resolve against a list that stays loaded
      // either way.
      const shown = this.docs.has(job.id) && !this.docsCollapsed.has(job.id);
      buttons.push(
        `<button class="btn-secondary jb-docs-btn" data-job="${id}">${
          shown ? 'Hide documents' : 'View documents'
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
    if (job.status === 'failed') {
      buttons.push(`<button class="btn-primary jb-retry" data-job="${id}">Retry stage</button>`);
    }
    // Cancel stops a live job; Discard cleans up one that has already stopped.
    // The split matters: the server refuses each verb on the other's statuses, so
    // offering Cancel on a finished job (as this once did) only ever produced a 409.
    if (job.status === 'queued' || job.status === 'running' || job.status === 'parked') {
      buttons.push(`<button class="btn-secondary jb-cancel" data-job="${id}">Cancel</button>`);
    } else {
      buttons.push(`<button class="btn-secondary jb-discard" data-job="${id}">Discard</button>`);
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

  private async act(jobId: string, action: string, body?: Record<string, unknown>): Promise<boolean> {
    try {
      const res = await fetch(
        `/api/jobs/${encodeURIComponent(jobId)}/${action}`,
        body ? jsonPost(body) : BODYLESS_POST
      );
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        this.flash(data.error || `Request failed (${res.status})`);
        return false;
      }
      if (this.cwd) await this.load(this.cwd);
      return true;
    } catch (error) {
      this.flash(error instanceof Error ? error.message : 'Request failed');
      return false;
    }
  }

  /**
   * Discard a finished job: remove its worktree and branch, drop it off the board.
   *
   * Not routed through act(), because the response says whether a merge was left
   * in the base branch. Telling the user that is the whole point — "discarded"
   * would otherwise read as "undone", which for a merged job it is not.
   */
  private async discard(jobId: string): Promise<void> {
    const job = this.jobs.find((j) => j.id === jobId);
    const merged = job?.stages.some((s) => s.name === 'merge' && s.status === 'passed');
    const warning = merged
      ? `\n\nIts merge has already landed in ${job?.baseBranch ?? 'the base branch'} and will NOT be undone — revert that commit by hand if you need to.`
      : '\n\nThis job never merged, so the project returns to exactly its state beforehand.';
    if (!confirm(`Discard "${job?.title ?? 'this job'}"?${warning}`)) return;

    try {
      const res = await fetch(`/api/jobs/${encodeURIComponent(jobId)}/discard`, BODYLESS_POST);
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        this.flash(data.error || `Could not discard (${res.status})`);
        return;
      }
      const result = (await res.json()) as { mergeLanded?: boolean; baseBranch?: string | null };
      if (result.mergeLanded) {
        this.flash(
          `Discarded. The merge commit remains in ${result.baseBranch ?? 'the base branch'}.`
        );
      }
      this.expanded.delete(jobId);
      this.docs.delete(jobId);
      this.docsCollapsed.delete(jobId);
      this.openDoc.delete(jobId);
      this.diffs.delete(jobId);
      if (this.cwd) await this.load(this.cwd);
    } catch (error) {
      this.flash(error instanceof Error ? error.message : 'Could not discard');
    }
  }

  /** Open a document on a job's card, or close it if it is already open. */
  private async toggleDoc(
    jobId: string,
    path: string,
    mode: 'text' | 'diff' = 'text'
  ): Promise<void> {
    if (!path) return;
    const open = this.openDoc.get(jobId);
    if (open && open.path === path && open.mode === mode) {
      this.openDoc.delete(jobId);
      this.render();
      return;
    }
    this.expanded.add(jobId);
    // Opening a document is asking to read it — a pane folded away cannot show it.
    this.docsCollapsed.delete(jobId);
    this.openDoc.set(jobId, { path, mode });
    // Rendered before the fetch so the row opens on the click and says it is
    // loading, rather than nothing happening while git runs.
    this.render();
    await this.fetchDocBody(jobId, path, mode);
    this.render();
  }

  /**
   * Fold or unfold a job's document pane, fetching the list the first time.
   *
   * Nothing here discards the list: a question's references resolve against it,
   * and specPathOf() reads which row is the spec, so hiding has to stay a class.
   * Freshness is unaffected — a live job on screen is refetched by
   * loadDocsForParked() on every poll, and a project switch clears the lot.
   *
   * Unfolding a cached list has to expand the card as well: the pane renders
   * only inside renderBody(), while the button that got us here renders on
   * every card. A job parked at the design or merge gate is cached and
   * collapsed — without this, its button flips its own label and puts nothing
   * on screen.
   */
  private async toggleDocs(jobId: string): Promise<void> {
    if (this.docs.has(jobId)) {
      if (this.docsCollapsed.has(jobId)) {
        this.docsCollapsed.delete(jobId);
        this.expanded.add(jobId);
      } else {
        this.docsCollapsed.add(jobId);
      }
      this.render();
      return;
    }
    this.expanded.add(jobId);
    // Asking for a list that is not here yet is asking to see it.
    this.docsCollapsed.delete(jobId);
    await this.fetchDocs(jobId);
    this.render();
  }

  private async fetchDocBody(jobId: string, path: string, mode: 'text' | 'diff'): Promise<void> {
    const key = `${jobId}|${mode}|${path}`;
    if (this.docBodies.has(key)) return;
    try {
      const res = await fetch(
        `/api/jobs/${encodeURIComponent(jobId)}/file?path=${encodeURIComponent(path)}` +
          (mode === 'diff' ? '&mode=diff' : '')
      );
      const data = (await res.json()) as {
        text?: string | null;
        diff?: string | null;
        truncated?: boolean;
      };
      this.docBodies.set(key, {
        body: (mode === 'diff' ? data.diff : data.text) || '',
        truncated: Boolean(data.truncated),
      });
    } catch {
      this.docBodies.set(key, { body: '', truncated: false });
    }
  }

  /**
   * Follow a reference out of a question into the document it names.
   *
   * The scroll cannot happen here: the body is still being fetched, and the
   * render that puts it on the page comes later. So the section is remembered
   * and applied by whichever render brings it into existence — the same shape
   * as the overlay's focusJob.
   */
  private async openReference(jobId: string, path: string, section: string): Promise<void> {
    if (section) this.pendingAnchor = { jobId, section };
    // Needed here as well as in toggleDoc(): the early return below renders
    // without going near it, and scrolling to a heading inside a folded pane
    // silently does nothing. With parked panes starting folded, that is the
    // normal path — every reference click begins on one.
    this.docsCollapsed.delete(jobId);
    const open = this.openDoc.get(jobId);
    if (open?.path === path && open.mode === 'text') {
      this.render(); // already open — only the scroll is left to do
      return;
    }
    await this.toggleDoc(jobId, path, 'text');
  }

  /** Scroll to a referenced section once its document is on the page. */
  private applyPendingAnchor(container: HTMLElement): void {
    const pending = this.pendingAnchor;
    if (!pending) return;
    const card = [...container.querySelectorAll<HTMLElement>('.jb-job')].find(
      (node) => node.dataset.job === pending.jobId
    );
    const heading = [...(card?.querySelectorAll<HTMLElement>('.jb-doc-h') ?? [])].find(
      (node) => node.dataset.section === pending.section
    );
    if (!heading) return;
    this.pendingAnchor = null;
    heading.scrollIntoView({ block: 'center', behavior: 'smooth' });
    heading.classList.add('jb-doc-h-hit');
    window.setTimeout(() => heading.classList.remove('jb-doc-h-hit'), 2000);
  }

  /** Say whether approving will apply fixes or move straight on. */
  private approveReviewLabel(job: Job): string {
    const chosen = (this.findings.get(job.id) || []).filter((f) => f.selected).length;
    return chosen > 0 ? `Fix ${chosen} &amp; continue` : 'Skip all &amp; continue';
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

  /**
   * Persist the selection as it changes rather than on approval, so a tick is
   * never lost to a refresh or a poll landing mid-decision.
   */
  private async selectFinding(jobId: string, findingId: string, checked: boolean): Promise<void> {
    const current = this.findings.get(jobId) || [];
    const next = current.map((f) => (f.id === findingId ? { ...f, selected: checked } : f));
    this.findings.set(jobId, next);

    try {
      const res = await fetch(`/api/jobs/${encodeURIComponent(jobId)}/findings/select`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ selected: next.filter((f) => f.selected).map((f) => f.id) }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as { findings: Finding[] };
      this.findings.set(jobId, data.findings || next);
    } catch {
      // Put the box back rather than leave the UI claiming a choice the server
      // never recorded.
      this.findings.set(jobId, current);
      this.flash('Could not save that selection — try again.');
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

      const retry = target.closest('.jb-retry') as HTMLElement | null;
      if (retry) return void this.act(retry.dataset.job || '', 'retry');

      const cancel = target.closest('.jb-cancel') as HTMLElement | null;
      if (cancel) {
        const job = this.jobs.find((j) => j.id === cancel.dataset.job);
        const running = job?.status === 'running';
        const what = running
          ? `Stop "${job?.title ?? 'this job'}" mid-${job?.stage ?? 'stage'} and remove its worktree?`
          : `Cancel "${job?.title ?? 'this job'}" and remove its worktree?`;
        if (confirm(what)) {
          void this.act(cancel.dataset.job || '', 'cancel');
        }
        return;
      }

      const discard = target.closest('.jb-discard') as HTMLElement | null;
      if (discard) {
        void this.discard(discard.dataset.job || '');
        return;
      }

      const spec = target.closest('.jb-spec-btn') as HTMLElement | null;
      if (spec) return void this.toggleDoc(spec.dataset.job || '', spec.dataset.path || '');

      const ref = target.closest('.jb-ref') as HTMLElement | null;
      if (ref) {
        return void this.openReference(
          ref.dataset.job || '',
          ref.dataset.path || '',
          ref.dataset.section || ''
        );
      }

      const docTab = target.closest('.jb-doc-tab') as HTMLElement | null;
      if (docTab) {
        return void this.toggleDoc(
          docTab.dataset.job || '',
          docTab.dataset.path || '',
          docTab.dataset.mode === 'diff' ? 'diff' : 'text'
        );
      }

      const docRow = target.closest('.jb-doc-row') as HTMLElement | null;
      if (docRow) return void this.toggleDoc(docRow.dataset.job || '', docRow.dataset.path || '');

      const more = target.closest('.jb-doc-more') as HTMLElement | null;
      if (more) {
        this.docsExpanded.add(more.dataset.job || '');
        this.render();
        return;
      }

      const docsBtn = target.closest('.jb-docs-btn') as HTMLElement | null;
      if (docsBtn) return void this.toggleDocs(docsBtn.dataset.job || '');

      // The pane's own chevron: the affordance once the list is on screen.
      // Only this path asks for the focus back — the actions-row button is a
      // different control, and moving focus off it would be a surprise.
      const docsHead = target.closest('.jb-docs-head') as HTMLElement | null;
      if (docsHead) {
        this.refocusDocsHead = docsHead.dataset.job || '';
        return void this.toggleDocs(docsHead.dataset.job || '');
      }

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

    container.addEventListener('change', (event) => {
      const box = (event.target as HTMLElement).closest('.jb-finding-box') as HTMLInputElement | null;
      if (!box) return;
      void this.selectFinding(box.dataset.job || '', box.dataset.finding || '', box.checked);
    });

    container.addEventListener('submit', (event) => {
      const form = (event.target as HTMLElement).closest('.jb-answer') as HTMLFormElement | null;
      if (!form) return;
      event.preventDefault();
      void this.submitAnswer(form);
    });
  }
}
