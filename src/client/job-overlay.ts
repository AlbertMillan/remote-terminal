import { escapeHtml, escapeAttr } from './html-utils.js';
import type { JobStatus, StageName, StageStatus } from './job-board.js';
import { parseDecision, stripMarks } from './decision-format.js';

/**
 * The live job panel over the main area.
 *
 * Fed by `jobs.summary` pushed over the WebSocket — it never polls. The board
 * in the Projects tab polls because it is a page you are already looking at;
 * this one has to notice a job *starting* while you are in a terminal, and a
 * poll that has to run forever to do that is a poll that runs forever.
 *
 * Mirrors JobSummary in src/server/jobs/summary.ts.
 */

export interface JobSummaryStage {
  name: StageName;
  status: StageStatus;
}

export interface JobSummary {
  id: string;
  projectCwd: string;
  projectName: string;
  featureId: string | null;
  title: string;
  status: JobStatus;
  stage: StageName | null;
  gate: string | null;
  parkReason: string | null;
  detail: string | null;
  stages: JobSummaryStage[];
  costUsd: number;
  createdAt: string;
  updatedAt: string;
}

/**
 * Mirrors JobsSummary in src/server/jobs/summary.ts. Carries no counts: the
 * pill counts the cards it is showing, and a finished job leaves the panel a
 * minute before it leaves the feed.
 */
export interface JobsSummary {
  jobs: JobSummary[];
}

export type OverlayPlacement = 'header' | 'below';

const ENABLED_KEY = 'jobOverlayEnabled';
const PLACEMENT_KEY = 'jobOverlayPlacement';
const OPEN_KEY = 'jobOverlayOpen';

/**
 * How long a finished job stays on the panel after we first see it finish.
 *
 * Measured from first sight, not from `updatedAt`: the point is that a job that
 * completed while you were reading a terminal does not vanish before you look
 * up. A reconnect that replays a job finished 90s ago must not show it as news,
 * which is why the server also drops terminal jobs after two minutes.
 */
export const FINISHED_LINGER_MS = 60_000;

/** Ranked by what it costs you to miss it — the order rollup.ts sorts by. */
const STATUS_RANK: Record<JobStatus, number> = {
  parked: 0,
  failed: 1,
  running: 2,
  queued: 3,
  cancelled: 4,
  done: 4,
};

const PARK_LABEL: Record<string, string> = {
  question: 'needs a decision',
  gate: 'waiting for you',
};

export function isTerminal(status: JobStatus): boolean {
  return status === 'done' || status === 'failed' || status === 'cancelled';
}

/**
 * Which jobs still deserve a card, in the order they are shown.
 *
 * Pure, and exported, so the two rules that are easy to get quietly wrong — a
 * finished job expiring on when it was *first seen* finished, and a live job
 * never expiring at all — are testable without a DOM.
 *
 * `finishedSeenAt` maps job id to when this client first saw it terminal; a
 * job missing from it is treated as finishing now, which is what happens on the
 * very first summary after a reconnect.
 */
export function selectVisibleJobs(
  jobs: JobSummary[],
  finishedSeenAt: Map<string, number>,
  now: number
): JobSummary[] {
  return jobs
    .filter((job) => {
      if (!isTerminal(job.status)) return true;
      const seenAt = finishedSeenAt.get(job.id) ?? now;
      return now - seenAt < FINISHED_LINGER_MS;
    })
    .sort((a, b) => {
      const byStatus = STATUS_RANK[a.status] - STATUS_RANK[b.status];
      return byStatus !== 0 ? byStatus : b.updatedAt.localeCompare(a.updatedAt);
    });
}

/** The pill's figures, counted off the cards actually on screen. */
export function countJobs(jobs: JobSummary[]): { running: number; waiting: number; failed: number } {
  const counts = { running: 0, waiting: 0, failed: 0 };
  for (const job of jobs) {
    if (job.status === 'running' || job.status === 'queued') counts.running++;
    else if (job.status === 'parked') counts.waiting++;
    else if (job.status === 'failed') counts.failed++;
  }
  return counts;
}

/**
 * The one line worth reading off a parked job.
 *
 * `detail` on a job parked for a decision is free prose — the question, its
 * context, the alternatives and a recommendation — written for the board's
 * decision cards, not for a two-line excerpt. Lead with the question itself
 * where `decision-format` can find one; the rest is what the board is for.
 *
 * Falls back to the raw text with its emphasis marks stripped, so a card never
 * shows a stray `**` whatever shape the prose turns out to have.
 */
export function cardDetail(job: JobSummary): string | null {
  if (!job.detail) return null;
  if (job.parkReason === 'question') {
    const question = parseDecision(job.detail)?.cards[0]?.question;
    if (question) return stripMarks(question);
  }
  return stripMarks(job.detail);
}

function readPlacement(): OverlayPlacement {
  return localStorage.getItem(PLACEMENT_KEY) === 'header' ? 'header' : 'below';
}

export class JobOverlay {
  private jobs: JobSummary[] = [];
  /** When each finished job was first seen finished, keyed by job id. */
  private finishedSeenAt = new Map<string, number>();
  /**
   * Parsed card details, keyed by job id and the timestamp they were parsed at.
   *
   * `render()` runs on every push and re-derives every card, but the prose
   * behind a parked question only changes when `updatedAt` does — and parsing
   * it is the one non-trivial thing a card does. Per instance rather than
   * per module: a cache shared between overlays is state one can serve to the
   * other, and it is swept in `update()` so it cannot outlive its jobs.
   */
  private detailCache = new Map<string, { updatedAt: string; text: string | null }>();
  private enabled = localStorage.getItem(ENABLED_KEY) !== 'false';
  private placement: OverlayPlacement = readPlacement();
  private open = localStorage.getItem(OPEN_KEY) !== 'false';
  /** True while a view owns the top-right corner itself (Projects, Overview). */
  private suppressed = false;
  private expiryTimer: number | null = null;

  constructor(private readonly onOpenJob: (job: JobSummary) => void) {}

  /** Wire up the static markup. Safe to call once, after DOMContentLoaded. */
  attach(): void {
    const root = document.getElementById('job-overlay');
    if (!root) return;

    document.getElementById('job-overlay-bar')?.addEventListener('click', () => {
      this.open = !this.open;
      localStorage.setItem(OPEN_KEY, String(this.open));
      this.render();
    });

    document.getElementById('job-overlay-list')?.addEventListener('click', (event) => {
      const card = (event.target as HTMLElement).closest('[data-job-id]') as HTMLElement | null;
      const job = this.jobs.find((j) => j.id === card?.dataset.jobId);
      if (job) this.onOpenJob(job);
    });

    this.applyPlacement();
    this.render();
  }

  // --- Preferences -------------------------------------------------------

  isEnabled(): boolean {
    return this.enabled;
  }

  getPlacement(): OverlayPlacement {
    return this.placement;
  }

  setPreferences(enabled: boolean, placement: OverlayPlacement): void {
    this.enabled = enabled;
    this.placement = placement;
    localStorage.setItem(ENABLED_KEY, String(enabled));
    localStorage.setItem(PLACEMENT_KEY, placement);
    this.applyPlacement();
    this.render();
  }

  /**
   * Hide while the Projects or Overview view is open: both put their own
   * actions exactly here, and both already render these jobs in full below.
   */
  setSuppressed(suppressed: boolean): void {
    if (this.suppressed === suppressed) return;
    this.suppressed = suppressed;
    this.render();
  }

  /**
   * Re-home the panel. In `header` placement it becomes a flex item inside the
   * terminal header; absolute positioning would mean hard-coding the width of
   * the controls it sits beside, and that width changes as the Keep button
   * comes and goes on forks. With no header on screen there is nothing to dock
   * to, so it floats where the header would have been — and nothing collides
   * there, because the buttons it was avoiding are gone too.
   */
  applyPlacement(): void {
    const root = document.getElementById('job-overlay');
    if (!root) return;

    const header = document.getElementById('terminal-header');
    const headerVisible = !!header && !header.classList.contains('hidden');
    const docked = this.placement === 'header' && headerVisible;

    root.classList.toggle('jo-docked', docked);
    root.classList.toggle('jo-floating', !docked);

    const parent = docked ? header : document.getElementById('main-content');
    if (!parent || root.parentElement === parent) return;
    if (docked) parent.insertBefore(root, parent.querySelector('.terminal-controls'));
    else parent.appendChild(root);
  }

  // --- Data --------------------------------------------------------------

  update(summary: JobsSummary): void {
    const now = Date.now();
    const seen = new Set<string>();

    for (const job of summary.jobs) {
      seen.add(job.id);
      if (isTerminal(job.status)) {
        if (!this.finishedSeenAt.has(job.id)) this.finishedSeenAt.set(job.id, now);
      } else {
        // A retried job is live again; it must not inherit its old countdown.
        this.finishedSeenAt.delete(job.id);
      }
    }
    for (const id of [...this.finishedSeenAt.keys()]) {
      if (!seen.has(id)) this.finishedSeenAt.delete(id);
    }
    for (const id of [...this.detailCache.keys()]) {
      if (!seen.has(id)) this.detailCache.delete(id);
    }

    this.jobs = summary.jobs;
    this.render();
  }

  /** Nothing to show while the socket is down; stale job states are worse than none. */
  clear(): void {
    this.jobs = [];
    this.finishedSeenAt.clear();
    this.detailCache.clear();
    this.render();
  }

  /** Jobs still worth a card: everything live, plus recent finishers. */
  private visibleJobs(now: number): JobSummary[] {
    return selectVisibleJobs(this.jobs, this.finishedSeenAt, now);
  }

  // --- Rendering ---------------------------------------------------------

  render(): void {
    const root = document.getElementById('job-overlay');
    if (!root) return;

    const now = Date.now();
    const jobs = this.visibleJobs(now);
    // An empty panel is chrome with nothing to say — take it off the screen
    // entirely rather than leave an "idle" pill over the terminal.
    const show = this.enabled && !this.suppressed && jobs.length > 0;
    root.classList.toggle('hidden', !show);
    if (!show) {
      this.stopExpiryTimer();
      return;
    }

    root.classList.toggle('open', this.open);
    this.renderCounts(jobs);
    if (this.open) this.renderList(jobs);
    this.scheduleExpiry(jobs, now);
  }

  private renderCounts(jobs: JobSummary[]): void {
    const el = document.getElementById('job-overlay-counts');
    if (!el) return;

    const counts = countJobs(jobs);

    const parts: string[] = [];
    if (counts.waiting) parts.push(`<span class="jo-count waiting">${counts.waiting} waiting</span>`);
    if (counts.running) {
      parts.push(
        `<span class="jo-count running"><span class="jo-pulse"></span>${counts.running} running</span>`
      );
    }
    if (counts.failed) parts.push(`<span class="jo-count failed">${counts.failed} failed</span>`);
    if (parts.length === 0) parts.push(`<span class="jo-count done">${jobs.length} finished</span>`);
    el.innerHTML = parts.join('');
  }

  /**
   * Replace the cards, putting the user back where they were.
   *
   * Every push re-renders the whole list, and the list scrolls once a few jobs
   * are in flight. Without this, a summary landing while you are scrolled down
   * — or tabbed onto a card — silently snaps you to the top and drops focus.
   */
  private renderList(jobs: JobSummary[]): void {
    const el = document.getElementById('job-overlay-list');
    if (!el) return;

    const scrollTop = el.scrollTop;
    const focused = document.activeElement as HTMLElement | null;
    const focusedJobId = el.contains(focused) ? focused?.dataset.jobId : undefined;

    el.innerHTML = jobs.map((job) => this.renderCard(job)).join('');

    el.scrollTop = scrollTop;
    if (focusedJobId) {
      const again = [...el.querySelectorAll<HTMLElement>('[data-job-id]')].find(
        (node) => node.dataset.jobId === focusedJobId
      );
      again?.focus({ preventScroll: true });
    }
  }

  private renderCard(job: JobSummary): string {
    const strip = job.stages
      .map((stage) => `<span class="jo-seg ${stage.status}"></span>`)
      .join('');

    // A job can be parked before any stage has been recorded against it, and
    // then there is no position to report. Repeating the status here would just
    // say "parked" beside a chip already reading "needs a decision".
    const position = job.stage ? job.stages.findIndex((s) => s.name === job.stage) + 1 : 0;
    const stageLabel = job.stage
      ? `${job.stage} ${position}/${job.stages.length}`
      : job.status === 'queued'
        ? 'queued'
        : '';

    let chip = '';
    if (job.status === 'parked') {
      const label = PARK_LABEL[job.parkReason || ''] || 'waiting for you';
      chip = `<span class="jo-chip ${escapeAttr(job.parkReason || 'gate')}">${escapeHtml(label)}</span>`;
    } else if (job.status === 'failed') {
      chip = '<span class="jo-chip failed">failed</span>';
    } else if (job.status === 'done') {
      chip = '<span class="jo-chip done">finished</span>';
    } else if (job.status === 'cancelled') {
      chip = '<span class="jo-chip cancelled">cancelled</span>';
    }

    const finished = isTerminal(job.status);
    const detail = this.detailFor(job);
    return `
      <button class="jo-card ${escapeAttr(job.status)}${finished ? ' fading' : ''}"
              data-job-id="${escapeAttr(job.id)}"
              title="Open ${escapeAttr(job.projectName)} and show this job">
        <span class="jo-card-top">
          <span class="jo-project">${escapeHtml(job.projectName)}</span>
          <span class="jo-age">${escapeHtml(this.age(job.createdAt))}</span>
        </span>
        <span class="jo-title">${escapeHtml(job.title)}</span>
        <span class="jo-strip">${strip}</span>
        <span class="jo-foot">
          ${stageLabel ? `<span class="jo-stage">${escapeHtml(stageLabel)}</span>` : ''}
          ${chip}
          <span class="jo-cost">${this.cost(job.costUsd)}</span>
        </span>
        ${detail ? `<span class="jo-detail">${escapeHtml(detail)}</span>` : ''}
      </button>`;
  }

  /** `cardDetail`, memoized for as long as the job has not changed. */
  private detailFor(job: JobSummary): string | null {
    const cached = this.detailCache.get(job.id);
    if (cached && cached.updatedAt === job.updatedAt) return cached.text;
    const text = cardDetail(job);
    this.detailCache.set(job.id, { updatedAt: job.updatedAt, text });
    return text;
  }

  /**
   * Finished cards expire on their own, so the panel needs one timer to take
   * them away — there is no further push coming for a job that is already done.
   */
  private scheduleExpiry(jobs: JobSummary[], now: number): void {
    this.stopExpiryTimer();
    let soonest = Infinity;
    for (const job of jobs) {
      if (!isTerminal(job.status)) continue;
      const seenAt = this.finishedSeenAt.get(job.id) ?? now;
      soonest = Math.min(soonest, seenAt + FINISHED_LINGER_MS - now);
    }
    if (!Number.isFinite(soonest)) return;
    this.expiryTimer = window.setTimeout(() => this.render(), Math.max(250, soonest));
  }

  private stopExpiryTimer(): void {
    if (this.expiryTimer !== null) {
      window.clearTimeout(this.expiryTimer);
      this.expiryTimer = null;
    }
  }

  private cost(usd: number): string {
    if (!usd) return '';
    return usd < 0.01 ? '<$0.01' : `$${usd.toFixed(2)}`;
  }

  private age(iso: string): string {
    const then = new Date(iso).getTime();
    if (Number.isNaN(then)) return '';
    const mins = Math.max(0, Math.round((Date.now() - then) / 60000));
    if (mins < 60) return `${mins}m`;
    const hours = Math.round(mins / 60);
    return hours < 24 ? `${hours}h` : `${Math.round(hours / 24)}d`;
  }
}
