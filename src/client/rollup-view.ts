import { html, joinHtml, setHtml, type SafeHtml } from './html-utils.js';
import { shortAge } from './format.js';

/**
 * Cross-project overview: every project, led by the features marked blocked.
 * What the factory is running or waits on is the Factory overlay's (pushed
 * `factory.summary`), not this page's.
 */

export type AttentionKind = 'blocked';

export interface AttentionItem {
  kind: AttentionKind;
  projectCwd: string;
  projectName: string;
  title: string;
  detail: string | null;
  featureId: string | null;
  since: string;
}

export interface ProjectSummary {
  cwd: string;
  name: string;
  status: string | null;
  hasDoc: boolean;
  counts: { total: number; done: number; in_progress: number; pending: number; blocked: number };
  lastActivity: string | null;
  lastModified: string | null;
  vcsKind: string;
  canDispatch: boolean;
}

export interface Rollup {
  attention: AttentionItem[];
  projects: ProjectSummary[];
  totals: {
    projects: number;
    withDoc: number;
    features: number;
    done: number;
    inProgress: number;
    blocked: number;
    attention: number;
  };
}

const KIND_LABEL: Record<AttentionKind, string> = {
  blocked: 'blocked',
};

export class RollupView {
  private data: Rollup | null = null;
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
  }

  private render(): void {
    const el = document.getElementById('rollup-body');
    if (!el) return;
    if (!this.data) {
      setHtml(el, html`<div class="project-empty">Couldn't load the overview.</div>`);
      return;
    }
    setHtml(
      el,
      joinHtml([
        this.renderTotals(this.data),
        this.renderAttention(this.data),
        this.renderProjects(this.data),
      ])
    );
  }

  private renderTotals(data: Rollup): SafeHtml {
    const t = data.totals;
    const tile = (value: string | number, label: string, cls = ''): SafeHtml =>
      html`<div class="rv-tile ${cls}"><div class="rv-tile-value">${String(value)}</div><div class="rv-tile-label">${label}</div></div>`;

    return html`
      <div class="rv-tiles">
        ${tile(`${t.done}/${t.features}`, 'features done')}
        ${tile(t.inProgress, 'in progress')}
        ${tile(t.blocked, 'blocked', t.blocked ? 'danger' : '')}
        ${tile(`${t.withDoc}/${t.projects}`, 'projects indexed')}
      </div>`;
  }

  private renderAttention(data: Rollup): SafeHtml {
    if (data.attention.length === 0) {
      return html`
        <section class="rv-section">
          <h3 class="project-log-subhead">Blocked</h3>
          <div class="project-empty">No feature is marked blocked.</div>
        </section>`;
    }

    const rows = data.attention.map(
      (item) => html`
        <li class="rv-item ${item.kind}" data-cwd="${item.projectCwd}">
          <span class="rv-kind ${item.kind}">${KIND_LABEL[item.kind]}</span>
          <div class="rv-item-body">
            <div class="rv-item-title">${item.title}</div>
            ${item.detail && html`<div class="rv-item-detail">${item.detail}</div>`}
          </div>
          <span class="rv-item-project">${item.projectName}</span>
          <span class="rv-item-age">${shortAge(item.since)}</span>
        </li>`
    );

    return html`
      <section class="rv-section">
        <h3 class="project-log-subhead">Blocked</h3>
        <ul class="rv-list">${rows}</ul>
      </section>`;
  }

  private renderProjects(data: Rollup): SafeHtml {
    // Projects with an index first: they are the ones this board can actually
    // say something about.
    const sorted = [...data.projects].sort((a, b) => {
      if (a.hasDoc !== b.hasDoc) return a.hasDoc ? -1 : 1;
      const ar = a.lastActivity || a.lastModified || '';
      const br = b.lastActivity || b.lastModified || '';
      return br.localeCompare(ar);
    });

    const rows = sorted.map((p) => {
        const pct = p.counts.total > 0 ? Math.round((p.counts.done / p.counts.total) * 100) : 0;
        const badges: SafeHtml[] = [];
        if (p.counts.blocked) badges.push(html`<span class="rv-badge danger">${p.counts.blocked} blocked</span>`);
        if (!p.canDispatch) badges.push(html`<span class="rv-badge">${p.vcsKind}</span>`);

        return html`
        <li class="rv-project" data-cwd="${p.cwd}">
          <div class="rv-project-name">${p.name}</div>
          ${p.status && html`<span class="rv-status">${p.status}</span>`}
          <div class="rv-project-bar" title="${p.counts.done}/${p.counts.total} done">
            <span style="width:${pct}%"></span>
          </div>
          <div class="rv-project-counts">${
            p.hasDoc ? `${p.counts.done}/${p.counts.total}` : 'no index'
          }</div>
          <div class="rv-project-badges">${badges}</div>
        </li>`;
    });

    return html`
      <section class="rv-section">
        <h3 class="project-log-subhead">All projects</h3>
        <ul class="rv-projects">${rows}</ul>
      </section>`;
  }

  /** One delegated listener; rows are re-rendered on every load. */
  attach(container: HTMLElement): void {
    container.addEventListener('click', (event) => {
      const row = (event.target as HTMLElement).closest('[data-cwd]') as HTMLElement | null;
      if (!row?.dataset.cwd) return;
      this.hide();
      this.onOpenProject(row.dataset.cwd);
    });
  }
}
