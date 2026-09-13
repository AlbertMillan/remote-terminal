import { escapeHtml, escapeAttr } from './html-utils.js';

/**
 * Cross-project overview: what is in flight and what is waiting on you.
 *
 * Deliberately leads with "Needs you" rather than a project list. A list of 22
 * projects tells you nothing you did not already know; three items blocking
 * work do.
 */

export type AttentionKind = 'question' | 'failed' | 'gate' | 'blocked';

export interface AttentionItem {
  kind: AttentionKind;
  projectCwd: string;
  projectName: string;
  title: string;
  detail: string | null;
  jobId: string | null;
  featureId: string | null;
  since: string;
}

export interface ProjectSummary {
  cwd: string;
  name: string;
  status: string | null;
  hasDoc: boolean;
  counts: { total: number; done: number; in_progress: number; pending: number; blocked: number };
  runningJobs: number;
  waitingJobs: number;
  lastActivity: string | null;
  lastModified: string | null;
  vcsKind: string;
  canDispatch: boolean;
}

export interface Rollup {
  attention: AttentionItem[];
  inFlight: { jobId: string; projectName: string; title: string; stage: string | null }[];
  projects: ProjectSummary[];
  totals: {
    projects: number;
    withDoc: number;
    features: number;
    done: number;
    inProgress: number;
    blocked: number;
    attention: number;
    running: number;
  };
}

const KIND_LABEL: Record<AttentionKind, string> = {
  question: 'needs a decision',
  failed: 'failed',
  gate: 'waiting for you',
  blocked: 'blocked',
};

/** Re-poll only while something is actually moving. */
const POLL_MS = 6000;

export class RollupView {
  private data: Rollup | null = null;
  private pollTimer: number | null = null;
  private visible = false;

  constructor(private readonly onOpenProject: (cwd: string) => void) {}

  isVisible(): boolean {
    return this.visible;
  }

  async show(): Promise<void> {
    this.visible = true;
    document.getElementById('terminal-container')?.classList.add('hidden');
    document.getElementById('terminal-header')?.classList.add('hidden');
    document.getElementById('welcome-screen')?.classList.add('hidden');
    document.getElementById('project-log-view')?.classList.add('hidden');
    document.getElementById('rollup-view')?.classList.remove('hidden');
    await this.load();
  }

  hide(): void {
    this.visible = false;
    this.stopPolling();
    document.getElementById('rollup-view')?.classList.add('hidden');
  }

  async load(): Promise<void> {
    try {
      const res = await fetch('/api/projects/rollup');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      this.data = (await res.json()) as Rollup;
    } catch {
      this.data = null;
    }
    this.render();
    this.schedulePoll();
  }

  private schedulePoll(): void {
    this.stopPolling();
    if (!this.visible || !this.data || this.data.inFlight.length === 0) return;
    this.pollTimer = window.setTimeout(() => void this.load(), POLL_MS);
  }

  private stopPolling(): void {
    if (this.pollTimer !== null) {
      window.clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }
  }

  private render(): void {
    const el = document.getElementById('rollup-body');
    if (!el) return;
    if (!this.data) {
      el.innerHTML = '<div class="project-empty">Couldn\'t load the overview.</div>';
      return;
    }
    el.innerHTML =
      this.renderTotals(this.data) +
      this.renderAttention(this.data) +
      this.renderInFlight(this.data) +
      this.renderProjects(this.data);
  }

  private renderTotals(data: Rollup): string {
    const t = data.totals;
    const tile = (value: string | number, label: string, cls = ''): string =>
      `<div class="rv-tile ${cls}"><div class="rv-tile-value">${escapeHtml(
        String(value)
      )}</div><div class="rv-tile-label">${escapeHtml(label)}</div></div>`;

    return `
      <div class="rv-tiles">
        ${tile(t.attention, t.attention === 1 ? 'needs you' : 'need you', t.attention ? 'warn' : '')}
        ${tile(t.running, 'running', t.running ? 'active' : '')}
        ${tile(`${t.done}/${t.features}`, 'features done')}
        ${tile(t.inProgress, 'in progress')}
        ${tile(t.blocked, 'blocked', t.blocked ? 'danger' : '')}
        ${tile(`${t.withDoc}/${t.projects}`, 'projects indexed')}
      </div>`;
  }

  private renderAttention(data: Rollup): string {
    if (data.attention.length === 0) {
      return `
        <section class="rv-section">
          <h3 class="project-log-subhead">Needs you</h3>
          <div class="project-empty">Nothing is waiting on you.</div>
        </section>`;
    }

    const rows = data.attention
      .map(
        (item) => `
        <li class="rv-item ${item.kind}" data-cwd="${escapeAttr(item.projectCwd)}">
          <span class="rv-kind ${item.kind}">${escapeHtml(KIND_LABEL[item.kind])}</span>
          <div class="rv-item-body">
            <div class="rv-item-title">${escapeHtml(item.title)}</div>
            ${item.detail ? `<div class="rv-item-detail">${escapeHtml(item.detail)}</div>` : ''}
          </div>
          <span class="rv-item-project">${escapeHtml(item.projectName)}</span>
          <span class="rv-item-age">${escapeHtml(this.age(item.since))}</span>
        </li>`
      )
      .join('');

    return `
      <section class="rv-section">
        <h3 class="project-log-subhead">Needs you</h3>
        <ul class="rv-list">${rows}</ul>
      </section>`;
  }

  private renderInFlight(data: Rollup): string {
    if (data.inFlight.length === 0) return '';
    const rows = data.inFlight
      .map(
        (j) => `
        <li class="rv-item running">
          <span class="rv-kind running">${escapeHtml(j.stage || 'running')}</span>
          <div class="rv-item-body"><div class="rv-item-title">${escapeHtml(j.title)}</div></div>
          <span class="rv-item-project">${escapeHtml(j.projectName)}</span>
        </li>`
      )
      .join('');
    return `
      <section class="rv-section">
        <h3 class="project-log-subhead">In flight</h3>
        <ul class="rv-list">${rows}</ul>
      </section>`;
  }

  private renderProjects(data: Rollup): string {
    // Projects with an index first: they are the ones this board can actually
    // say something about.
    const sorted = [...data.projects].sort((a, b) => {
      if (a.hasDoc !== b.hasDoc) return a.hasDoc ? -1 : 1;
      const ar = a.lastActivity || a.lastModified || '';
      const br = b.lastActivity || b.lastModified || '';
      return br.localeCompare(ar);
    });

    const rows = sorted
      .map((p) => {
        const pct = p.counts.total > 0 ? Math.round((p.counts.done / p.counts.total) * 100) : 0;
        const badges: string[] = [];
        if (p.runningJobs) badges.push(`<span class="rv-badge active">${p.runningJobs} running</span>`);
        if (p.waitingJobs) badges.push(`<span class="rv-badge warn">${p.waitingJobs} waiting</span>`);
        if (p.counts.blocked) badges.push(`<span class="rv-badge danger">${p.counts.blocked} blocked</span>`);
        if (!p.canDispatch) badges.push(`<span class="rv-badge">${escapeHtml(p.vcsKind)}</span>`);

        return `
        <li class="rv-project" data-cwd="${escapeAttr(p.cwd)}">
          <div class="rv-project-name">${escapeHtml(p.name)}</div>
          ${p.status ? `<span class="rv-status">${escapeHtml(p.status)}</span>` : ''}
          <div class="rv-project-bar" title="${p.counts.done}/${p.counts.total} done">
            <span style="width:${pct}%"></span>
          </div>
          <div class="rv-project-counts">${
            p.hasDoc ? `${p.counts.done}/${p.counts.total}` : 'no index'
          }</div>
          <div class="rv-project-badges">${badges.join('')}</div>
        </li>`;
      })
      .join('');

    return `
      <section class="rv-section">
        <h3 class="project-log-subhead">All projects</h3>
        <ul class="rv-projects">${rows}</ul>
      </section>`;
  }

  private age(iso: string): string {
    const then = new Date(iso).getTime();
    if (!iso || Number.isNaN(then)) return '';
    const mins = Math.max(0, Math.round((Date.now() - then) / 60000));
    if (mins < 60) return `${mins}m`;
    const hours = Math.round(mins / 60);
    if (hours < 24) return `${hours}h`;
    return `${Math.round(hours / 24)}d`;
  }

  /** One delegated listener; rows are re-rendered on every poll. */
  attach(container: HTMLElement): void {
    container.addEventListener('click', (event) => {
      const row = (event.target as HTMLElement).closest('[data-cwd]') as HTMLElement | null;
      if (!row?.dataset.cwd) return;
      this.hide();
      this.onOpenProject(row.dataset.cwd);
    });
  }
}
