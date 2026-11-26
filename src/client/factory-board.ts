import { html, joinHtml, setHtml, type SafeHtml } from './html-utils.js';
import { requestJson, failureMessage } from './api.js';
import { formatTokens, shortAge } from './format.js';
import { cardKind, cardStatus, progressStrip } from './factory-overlay.js';
import { isClaimAction, renderClaimActions, runClaimAction } from './factory-claims.js';
import type {
  FactoryBoard,
  FactoryBoardUnit,
  FactoryColumn,
  FactoryMergeSummary,
  FactoryQuestion,
  FactoryReport,
} from '../shared/protocol.js';

/**
 * The factory board (project/code-factory.md, item 7): the main-area view the
 * Factory overlay's "Open board" leads to. Six columns — intake, ready,
 * running, review, merging, done today — and a drawer per card: an escalated
 * review with its summary page (Approve / Request changes / Open diff), a
 * shaping question with its options and default, a triage card (accept /
 * backlog / dismiss), a running track's features, a merge entry with its
 * resolver or park state. Add work files free-form text through intake, and
 * the morning report says what landed, what stalls and what it cost since you
 * last opened the board.
 *
 * Data: GET /api/factory/board, fetched on open and again on every pushed
 * `factory.summary` while the board is on screen — never polled. `render()`
 * replaces the board and the drawer wholesale; drafts (a note, an answer, Add
 * work's text) are captured before and restored after, with the focus.
 *
 * Routes it calls that the factory's other half serves: POST /api/factory/add,
 * /api/factory/items/:id/answer and /api/factory/triage/:id. Its own (server
 * factory/board-routes.ts): board, report, summary, diff, release, merge retry.
 */

const COLUMNS: { id: FactoryColumn; label: string }[] = [
  { id: 'intake', label: 'Intake' },
  { id: 'ready', label: 'Ready' },
  { id: 'running', label: 'Running' },
  { id: 'review', label: 'Review' },
  { id: 'merging', label: 'Merging' },
  { id: 'done', label: 'Done today' },
];

/** When this browser last opened the board: the morning report counts from here. */
export const LAST_OPENED_KEY = 'factoryBoardLastOpened';

type Drawer =
  | { kind: 'unit'; key: string; view: 'main' | 'summary' | 'diff' | 'changes' }
  | { kind: 'merge'; id: string }
  | { kind: 'add' };

/**
 * What POST /api/factory/add answers (server factory/intake.ts): the features
 * it filed, all into the request's track. A refusal (400/422) carries `error`,
 * read by failureMessage() like every route's.
 */
interface AddResult {
  features: { id: string; title: string; requirements: string[]; mockupFirst: boolean }[];
}

interface Notice {
  text: string;
  error: boolean;
}

export interface FactoryBoardHost {
  /** Take the main area: hide the terminal, welcome screen, Projects and Overview views. */
  takeMainArea(): void;
  /** Leave: back to the terminal of the attached session, or the welcome screen. */
  returnToMain(): void;
  /** The overlay hides while the board is up; re-check after a change. */
  syncOverlay(): void;
  /** Show a session's terminal (a claimed unit's "Open terminal"); a parked one is revived. */
  openSession?(sessionId: string): void;
  /** The session's row is still in the sidebar. */
  sessionExists?(sessionId: string): boolean;
}

function readStorage(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeStorage(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Private mode: the report then counts from this visit only.
  }
}

/**
 * A summary page's markdown, as blocks: headings, bullets, paragraphs and
 * fenced code. The page is the agent's own short text, so this is all it needs;
 * everything is escaped (html``), nothing is trusted.
 */
export function renderMarkdown(text: string): SafeHtml {
  const out: SafeHtml[] = [];
  let list: string[] = [];
  let code: string[] | null = null;
  const flush = () => {
    if (list.length > 0) out.push(html`<ul>${list.map((li) => html`<li>${li}</li>`)}</ul>`);
    list = [];
  };
  for (const line of text.split(/\r?\n/)) {
    if (code) {
      if (/^```/.test(line)) {
        out.push(html`<pre class="fb-pre">${code.join('\n')}</pre>`);
        code = null;
      } else code.push(line);
      continue;
    }
    if (/^```/.test(line)) {
      flush();
      code = [];
      continue;
    }
    const heading = /^#{1,6}\s+(.*)$/.exec(line);
    const bullet = /^\s*[-*]\s+(.*)$/.exec(line);
    if (heading) {
      flush();
      out.push(html`<h4>${heading[1]}</h4>`);
    } else if (bullet) {
      list.push(bullet[1]);
    } else if (line.trim()) {
      flush();
      out.push(html`<p>${line}</p>`);
    } else flush();
  }
  flush();
  if (code) out.push(html`<pre class="fb-pre">${code.join('\n')}</pre>`);
  return joinHtml(out);
}

/**
 * The one string the answer route takes: a single answer as given; several,
 * each labelled by its question (as the job board joined its answers).
 */
export function joinAnswers(questions: FactoryQuestion[], answers: string[]): string | null {
  if (answers.length === 0 || answers.some((a) => !a.trim())) return null;
  if (answers.length === 1) return answers[0].trim();
  return answers.map((a, i) => `${i + 1}) ${questions[i]?.question ?? ''}\n   ${a.trim()}`).join('\n');
}

/** The features intake filed, as POST /api/factory/add answers them; malformed entries are dropped. */
export function readAddResult(data: Record<string, unknown>): AddResult {
  const list = (Array.isArray(data.features) ? data.features : []) as unknown[];
  const features = list
    .filter((f): f is Record<string, unknown> => !!f && typeof f === 'object' && typeof (f as Record<string, unknown>).featureId === 'string')
    .map((f) => ({
      id: f.featureId as string,
      title: typeof f.title === 'string' ? f.title : (f.featureId as string),
      requirements: Array.isArray(f.requirements) ? f.requirements.filter((r): r is string => typeof r === 'string') : [],
      mockupFirst: f.mockupFirst === true,
    }));
  return { features };
}

export class FactoryBoardView {
  private data: FactoryBoard | null = null;
  private error: string | null = null;
  private visible = false;
  private drawer: Drawer | null = null;
  private summaries = new Map<string, string>();
  private summariesLoading = new Set<string>();
  private diffs = new Map<string, { stat: string; patch: string; truncated: boolean }>();
  private drafts = new Map<string, string>();
  private busy = false;
  private notice: Notice | null = null;
  private report: FactoryReport | null = null;
  private addResult: AddResult | null = null;
  private projects: { cwd: string; name: string }[] = [];
  private loading: Promise<void> | null = null;
  private reloadQueued = false;

  constructor(private readonly host: FactoryBoardHost) {}

  isVisible(): boolean {
    return this.visible;
  }

  attach(): void {
    const root = document.getElementById('factory-board-view');
    root?.addEventListener('click', (event) => void this.onClick(event));
    root?.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && this.drawer) {
        this.drawer = null;
        this.render();
      }
    });
  }

  /** Open the board, with a unit's drawer, or Add work. */
  async show(unitKey?: string, add = false): Promise<void> {
    const wasVisible = this.visible;
    this.visible = true;
    this.host.takeMainArea();
    document.getElementById('factory-board-view')?.classList.remove('hidden');
    this.host.syncOverlay();
    if (unitKey) this.drawer = { kind: 'unit', key: unitKey, view: 'main' };
    else if (add) this.openAdd();
    this.render();
    const loads: Promise<void>[] = [this.load()];
    if (!wasVisible) loads.push(this.loadReport());
    await Promise.all(loads);
  }

  hide(): void {
    if (!this.visible) return;
    this.visible = false;
    this.drawer = null;
    this.notice = null;
    document.getElementById('factory-board-view')?.classList.add('hidden');
    this.host.syncOverlay();
  }

  /** A factory write was pushed: the open board fetches the detail again. */
  onSummary(): void {
    if (this.visible) void this.load();
  }

  async load(): Promise<void> {
    if (this.loading) {
      this.reloadQueued = true;
      return this.loading;
    }
    this.loading = (async () => {
      const res = await requestJson<FactoryBoard>('/api/factory/board');
      if (res.ok) {
        this.data = res.data;
        this.error = null;
      } else {
        this.error = failureMessage(res, 'Could not load the factory board');
      }
      this.render();
    })();
    try {
      await this.loading;
    } finally {
      this.loading = null;
    }
    if (this.reloadQueued) {
      this.reloadQueued = false;
      await this.load();
    }
  }

  /** The morning report since the last visit; this visit becomes the next one's start. */
  private async loadReport(): Promise<void> {
    const since = readStorage(LAST_OPENED_KEY);
    writeStorage(LAST_OPENED_KEY, new Date().toISOString());
    this.report = null;
    if (!since || Number.isNaN(Date.parse(since))) return;
    const res = await requestJson<FactoryReport>(`/api/factory/report?since=${encodeURIComponent(since)}`);
    if (!res.ok) return;
    const r = res.data;
    if (r.landed.length > 0 || r.stalls.length > 0 || r.totalTokens > 0) this.report = r;
    this.render();
  }

  private openAdd(): void {
    this.drawer = { kind: 'add' };
    this.addResult = null;
    void this.loadProjects();
  }

  private async loadProjects(): Promise<void> {
    const res = await requestJson<{ registry?: { projects?: { cwd: string; name?: string }[] } }>('/api/projects/registry');
    const fromRegistry = res.ok ? (res.data.registry?.projects ?? []) : [];
    const seen = new Map<string, string>();
    for (const p of fromRegistry) seen.set(p.cwd, p.name || p.cwd.split(/[\\/]/).filter(Boolean).pop() || p.cwd);
    for (const u of this.data?.units ?? []) if (!seen.has(u.projectCwd)) seen.set(u.projectCwd, u.projectName);
    this.projects = [...seen].map(([cwd, name]) => ({ cwd, name }));
    this.render();
  }

  // --- Actions -------------------------------------------------------------

  private unit(key: string): FactoryBoardUnit | undefined {
    return this.data?.units.find((u) => u.key === key);
  }

  private async act(label: string, call: () => Promise<{ ok: boolean; status: number; data: { error?: string } }>, done?: () => void): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    this.notice = null;
    this.render();
    const res = await call();
    this.busy = false;
    if (res.ok) {
      this.notice = { text: label, error: false };
      done?.();
    } else {
      this.notice = { text: failureMessage(res, `${label} failed`), error: true };
    }
    this.render();
    if (res.ok) await this.load();
  }

  private post(url: string, body?: object) {
    return requestJson(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body ?? {}),
    });
  }

  private async onClick(event: Event): Promise<void> {
    const target = event.target as HTMLElement;
    const card = target.closest<HTMLElement>('[data-unit-key]');
    const mergeCard = target.closest<HTMLElement>('[data-merge-card]');
    const action = target.closest<HTMLElement>('[data-fb]');
    if (action) return this.onAction(action);
    if (card) {
      this.drawer = { kind: 'unit', key: card.dataset.unitKey as string, view: 'main' };
      this.notice = null;
      return this.render();
    }
    if (mergeCard) {
      this.drawer = { kind: 'merge', id: mergeCard.dataset.mergeCard as string };
      this.notice = null;
      return this.render();
    }
  }

  private async onAction(el: HTMLElement): Promise<void> {
    const kind = el.dataset.fb;
    const drawer = this.drawer;
    const unit = drawer?.kind === 'unit' ? this.unit(drawer.key) : undefined;
    const featureId = unit?.featureIds[0];
    switch (kind) {
      case 'back':
        this.hide();
        this.host.returnToMain();
        return;
      case 'add':
        this.openAdd();
        return this.render();
      case 'close':
        this.drawer = null;
        this.notice = null;
        return this.render();
      case 'dismiss-report':
        this.report = null;
        return this.render();
      case 'refresh':
        return this.load();
      case 'view':
        if (drawer?.kind === 'unit') {
          drawer.view = (el.dataset.view as 'main' | 'summary' | 'diff' | 'changes') ?? 'main';
          if (drawer.view === 'summary' && unit) void this.loadSummary(unit);
          if (drawer.view === 'diff' && unit) void this.loadDiff(unit);
        }
        return this.render();
      case 'approve':
        if (!unit || !featureId) return;
        return this.act('Approved: it goes to the merge queue', () =>
          this.post(`/api/factory/items/${featureId}/release`, { cwd: unit.projectCwd, outcome: 'approved' })
        );
      case 'send-changes': {
        if (!unit || !featureId) return;
        this.captureDrafts();
        const note = (this.drafts.get(`changes:${unit.key}`) ?? '').trim();
        if (!note) {
          this.notice = { text: 'Say what to change first.', error: true };
          return this.render();
        }
        return this.act(
          'Sent back with your changes',
          () => this.post(`/api/factory/items/${featureId}/release`, { cwd: unit.projectCwd, outcome: 'changes', note }),
          () => {
            this.drafts.delete(`changes:${unit.key}`);
            if (this.drawer?.kind === 'unit') this.drawer.view = 'main';
          }
        );
      }
      case 'release':
        if (!unit || !featureId) return;
        return this.act('Released for another round', () =>
          this.post(`/api/factory/items/${featureId}/release`, { cwd: unit.projectCwd })
        );
      case 'answer': {
        if (!unit || !featureId) return;
        this.captureDrafts();
        const questions = unit.detail.questions;
        const answers = questions.map((q) => this.answerFor(unit.key, q));
        const answer = joinAnswers(questions, answers);
        if (answer === null) {
          this.notice = { text: 'Answer every question first.', error: true };
          return this.render();
        }
        return this.act(
          'Answered: shaping goes on',
          () => this.post(`/api/factory/items/${featureId}/answer`, { cwd: unit.projectCwd, answer }),
          () => {
            for (const q of questions) {
              this.drafts.delete(`choice:${unit.key}:${q.id}`);
              this.drafts.delete(`other:${unit.key}:${q.id}`);
            }
          }
        );
      }
      case 'triage': {
        if (!unit || !featureId) return;
        const verb = el.dataset.action as 'accept' | 'backlog' | 'dismiss';
        const label = verb === 'accept' ? 'Accepted into the factory' : verb === 'backlog' ? 'Moved to the backlog' : 'Dismissed';
        return this.act(label, () => this.post(`/api/factory/triage/${featureId}`, { cwd: unit.projectCwd, action: verb }));
      }
      case 'retry-merge': {
        const id = el.dataset.mergeId;
        if (!id) return;
        return this.act('Merge queued again', () => this.post(`/api/factory/merges/${encodeURIComponent(id)}/retry`));
      }
      case 'submit-add': {
        this.captureDrafts();
        const cwd = this.drafts.get('add:cwd') || this.projects[0]?.cwd;
        const text = (this.drafts.get('add:text') ?? '').trim();
        const track = (this.drafts.get('add:track') ?? '').trim();
        if (!cwd || !text) {
          this.notice = { text: 'Pick a project and describe the work.', error: true };
          return this.render();
        }
        if (this.busy) return;
        this.busy = true;
        this.notice = null;
        this.render();
        const res = await this.post('/api/factory/add', { cwd, text, ...(track ? { track } : {}) });
        this.busy = false;
        if (res.ok) {
          this.addResult = readAddResult(res.data as Record<string, unknown>);
          this.drafts.delete('add:text');
          this.notice = { text: 'Filed into the Inbox', error: false };
        } else {
          this.notice = { text: failureMessage(res, 'Add work failed'), error: true };
        }
        this.render();
        return;
      }
      default:
        // Take over / Open terminal / Return to factory / Done (factory-claims.ts).
        if (unit && kind && isClaimAction(kind)) {
          return runClaimAction(kind, {
            unit,
            act: (label, call, done) => this.act(label, call, done),
            post: (url, body) => this.post(url, body),
            openSession: (id) => {
              this.hide();
              this.host.openSession?.(id);
            },
          });
        }
    }
  }

  /** The chosen option (or the default), or the typed answer when "Other" is chosen. */
  private answerFor(key: string, q: FactoryQuestion): string {
    const choice = this.drafts.get(`choice:${key}:${q.id}`) ?? q.default ?? '';
    if (choice === '__other') return this.drafts.get(`other:${key}:${q.id}`) ?? '';
    return choice;
  }

  private async loadSummary(unit: FactoryBoardUnit): Promise<void> {
    // Called from render() too: every render before the answer must not start another fetch.
    if (this.summaries.has(unit.key) || this.summariesLoading.has(unit.key)) return;
    this.summariesLoading.add(unit.key);
    try {
      const res = await requestJson<{ markdown: string }>(
        `/api/factory/summary?cwd=${encodeURIComponent(unit.projectCwd)}&unit=${encodeURIComponent(unit.unitId)}`
      );
      this.summaries.set(unit.key, res.ok ? res.data.markdown : `(${failureMessage(res, 'Could not load the summary page')})`);
    } finally {
      this.summariesLoading.delete(unit.key);
    }
    this.render();
  }

  private async loadDiff(unit: FactoryBoardUnit): Promise<void> {
    const res = await requestJson<{ stat: string; patch: string; truncated: boolean }>(
      `/api/factory/diff?cwd=${encodeURIComponent(unit.projectCwd)}&unit=${encodeURIComponent(unit.unitId)}`
    );
    this.diffs.set(unit.key, res.ok ? res.data : { stat: failureMessage(res, 'Could not diff the unit'), patch: '', truncated: false });
    this.render();
  }

  // --- Drafts ----------------------------------------------------------------

  private captureDrafts(): void {
    const root = document.getElementById('factory-board-view');
    if (!root) return;
    for (const el of root.querySelectorAll<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>('[data-draft]')) {
      if (el instanceof HTMLInputElement && el.type === 'radio') {
        if (el.checked) this.drafts.set(el.dataset.draft as string, el.value);
      } else {
        this.drafts.set(el.dataset.draft as string, el.value);
      }
    }
  }

  // --- Rendering -------------------------------------------------------------

  render(): void {
    if (!document.getElementById('factory-board-view')) return;
    // Drafts and the caret survive a wholesale render (a push lands while you type).
    this.captureDrafts();
    const active = document.activeElement as HTMLInputElement | HTMLTextAreaElement | null;
    const focusDraft = active?.dataset?.draft;
    const selection = focusDraft && 'selectionStart' in active ? [active.selectionStart, active.selectionEnd] : null;

    this.renderStatus();
    const body = document.getElementById('factory-board-body');
    if (body) setHtml(body, this.renderBody());
    const drawer = document.getElementById('factory-drawer');
    if (drawer) {
      drawer.classList.toggle('hidden', !this.drawer);
      setHtml(drawer, this.drawer ? this.renderDrawer() : html``);
    }

    if (focusDraft) {
      // Matched by dataset, not a selector: the key holds a project path.
      const again = [...document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>('#factory-board-view [data-draft]')].find(
        (el) => el.dataset.draft === focusDraft
      );
      if (again && again.type !== 'radio') {
        again.focus({ preventScroll: true });
        if (selection && selection[0] !== null) again.setSelectionRange(selection[0], selection[1]);
      }
    }
  }

  private renderStatus(): void {
    const el = document.getElementById('factory-board-status');
    if (!el) return;
    const d = this.data;
    if (!d) return setHtml(el, html``);
    const capped = Object.entries(d.dispatch.capped);
    setHtml(
      el,
      html`${d.dispatch.paused
        ? html`<span class="fb-chip y" title="${d.dispatch.paused}">dispatch paused</span>`
        : d.dispatch.started
          ? html`<span class="fb-chip g">dispatcher on · ${d.dispatch.running}/${d.dispatch.seats} seats</span>`
          : html`<span class="fb-chip">dispatcher off</span>`}
        ${capped.length > 0 && html`<span class="fb-chip y" title="${capped.map(([, why]) => why).join('\n')}">${capped.length} capped by plan usage</span>`}
        <span class="fb-path">today ${formatTokens(d.tokensToday)} tokens</span>`
    );
  }

  private renderBody(): SafeHtml {
    if (this.error && !this.data) return html`<div class="fb-empty fb-error">${this.error}</div>`;
    if (!this.data) return html`<div class="fb-empty">Loading the factory…</div>`;
    const d = this.data;
    const unitMergeIds = new Set(d.units.map((u) => u.mergeId).filter(Boolean));
    // Entries with no unit on the board: a session's Land, or a unit already gone.
    const looseMerges = d.merges.filter((m) => !unitMergeIds.has(m.id));
    return html`
      ${this.report ? this.renderReport(this.report) : ''}
      ${this.notice && !this.drawer ? html`<div class="fb-notice${this.notice.error ? ' error' : ''}">${this.notice.text}</div>` : ''}
      <div class="fb-scroll"><div class="fb-columns">
        ${COLUMNS.map((col) => {
          const units = d.units.filter((u) => u.column === col.id);
          const merges = looseMerges.filter((m) => (col.id === 'done' ? m.status === 'merged' : col.id === 'merging' && m.status !== 'merged'));
          const you = units.filter((u) => u.needsYou).length;
          const count =
            col.id === 'review' && units.length > 0 ? `agent ${units.length - you} · you ${you}` : String(units.length + merges.length);
          return html`<section class="fb-col" data-column="${col.id}">
            <h3>${col.label} <em>${count}</em></h3>
            ${units.map((u) => this.renderCard(u))}
            ${merges.map((m) => this.renderMergeCard(m))}
          </section>`;
        })}
      </div></div>`;
  }

  private renderCard(u: FactoryBoardUnit): SafeHtml {
    const open = this.drawer?.kind === 'unit' && this.drawer.key === u.key;
    return html`<button type="button" class="fb-card ${cardKind(u)}${u.stalled ? ' stalled' : ''}${open ? ' open' : ''}" data-unit-key="${u.key}">
      <span class="fb-card-top"><span class="fo-id">${u.isTrack ? 'Track' : u.unitId}</span><span class="fb-proj">${u.projectName}</span></span>
      <span class="fb-title">${u.title}</span>
      ${progressStrip(u, 'fo-prog wide')}
      <span class="fb-sub">${cardStatus(u)}</span>
      ${u.tokens > 0 && html`<span class="fb-tokens">${formatTokens(u.tokens)} tokens</span>`}
    </button>`;
  }

  private renderMergeCard(m: FactoryMergeSummary): SafeHtml {
    return html`<button type="button" class="fb-card merging${m.status === 'parked' ? ' you' : ''}" data-merge-card="${m.id}">
      <span class="fb-card-top"><span class="fo-id">${m.kind === 'session-land' ? 'Land' : 'merge'}</span><span class="fb-proj">${m.projectName}</span></span>
      <span class="fb-title">${m.title}</span>
      <span class="fb-sub">${m.status}${m.detail ? ` · ${m.detail}` : ''}</span>
    </button>`;
  }

  private renderReport(r: FactoryReport): SafeHtml {
    return html`<section class="fb-report" aria-label="Since you last looked">
      <div class="fb-report-head"><h3>Since you last looked <span class="fb-path">${shortAge(r.since)} ago</span></h3>
        <button type="button" class="fb-x" data-fb="dismiss-report" aria-label="Dismiss the report">×</button></div>
      <div class="fb-report-grid">
        <div><h4>Landed (${r.landed.length})</h4>${r.landed.length > 0
          ? html`<ul>${r.landed.map((m) => html`<li>${m.title} <span class="fb-path">${m.projectName}${m.mergeSha ? ` · ${m.mergeSha.slice(0, 7)}` : ''}</span></li>`)}</ul>`
          : html`<p class="fb-path">Nothing merged.</p>`}</div>
        <div><h4>Stalls (${r.stalls.length})</h4>${r.stalls.length > 0
          ? html`<ul>${r.stalls.map((u) => html`<li><button type="button" class="fb-link" data-unit-key="${u.key}">${u.title}</button> <span class="fb-path">${u.stalled}</span></li>`)}</ul>`
          : html`<p class="fb-path">Nothing stuck.</p>`}</div>
        <div><h4>Tokens · ${formatTokens(r.totalTokens)}</h4>${r.tokens.length > 0
          ? html`<ul>${r.tokens.slice(0, 8).map((t) => html`<li>${t.title} <span class="fb-path">${t.projectName} · ${formatTokens(t.tokens)}</span></li>`)}</ul>`
          : html`<p class="fb-path">No factory runs.</p>`}</div>
      </div>
    </section>`;
  }

  // --- Drawers -------------------------------------------------------------

  private renderDrawer(): SafeHtml {
    const d = this.drawer;
    const close = html`<button type="button" class="fb-x" data-fb="close" aria-label="Close">×</button>`;
    const notice = this.notice ? html`<div class="fb-notice${this.notice.error ? ' error' : ''}">${this.notice.text}</div>` : '';
    if (!d) return html``;
    if (d.kind === 'add') return html`${close}${this.renderAdd()}${notice}`;
    if (d.kind === 'merge') {
      const m = this.data?.merges.find((x) => x.id === d.id);
      return html`${close}${m ? this.renderMerge(m, true) : html`<p class="fb-path">This merge entry is no longer listed.</p>`}${notice}`;
    }
    const u = this.unit(d.key);
    if (!u) {
      return html`${close}${this.data ? html`<p class="fb-path">This unit is no longer on the board.</p>` : html`<p class="fb-path">Loading…</p>`}`;
    }
    return html`${close}${this.renderUnit(u, d.view)}${notice}`;
  }

  private renderUnit(u: FactoryBoardUnit, view: 'main' | 'summary' | 'diff' | 'changes'): SafeHtml {
    const head = html`<span class="fb-path">${u.isTrack ? 'Track' : u.unitId} · ${u.projectName}</span>
      <h3>${u.title}</h3>
      <div class="fb-chips">
        <span class="fb-chip ${u.needsYou ? 'y' : ''}">${u.needsYou ? 'needs you' : u.column}</span>
        ${u.isTrack && html`<span class="fb-chip b">1 agent${u.modelTier ? ` · ${u.modelTier}` : ''}</span>`}
        ${!u.isTrack && u.modelTier && html`<span class="fb-chip">${u.modelTier}</span>`}
        ${u.reviewer && html`<span class="fb-chip v">${u.reviewer === 'agent' ? 'reviewer agent checking' : 'review: you'}</span>`}
        ${u.waitsFor.length > 0 && html`<span class="fb-chip">waits for ${u.waitsFor.join(', ')}</span>`}
      </div>
      ${u.stalled && html`<div class="fb-verdict">Stalled: ${u.stalled}</div>`}`;

    if (view === 'summary') {
      const text = this.summaries.get(u.key);
      return html`${head}<div class="fb-tabs">${this.viewButton('main', 'Back')}</div>
        <h4>Summary page</h4>${text === undefined ? html`<p class="fb-path">Loading…</p>` : html`<div class="fb-md">${renderMarkdown(text)}</div>`}`;
    }
    if (view === 'diff') {
      const diff = this.diffs.get(u.key);
      return html`${head}<div class="fb-tabs">${this.viewButton('main', 'Back')}</div>
        ${diff === undefined
          ? html`<p class="fb-path">Loading the diff…</p>`
          : html`<pre class="fb-pre">${diff.stat}</pre><pre class="fb-pre fb-diff">${diff.patch}</pre>${diff.truncated && html`<p class="fb-path">Cut short; the worktree has the rest.</p>`}`}`;
    }
    if (view === 'changes') {
      return html`${head}<h4>What should change?</h4>
        <textarea class="fb-textarea" rows="6" data-draft="changes:${u.key}" placeholder="The fix step reads this as the review's findings">${this.drafts.get(`changes:${u.key}`) ?? ''}</textarea>
        <div class="fb-acts">
          <button type="button" class="btn-primary" data-fb="send-changes" ${this.busy ? 'disabled' : ''}>Send back</button>
          ${this.viewButton('main', 'Cancel')}
        </div>`;
    }

    const parts: SafeHtml[] = [head];
    if (u.triage) {
      parts.push(html`<p>An agent filed this while working on something else. Accept it into the factory, move it to the backlog, or dismiss it.</p>
        <div class="fb-acts">
          <button type="button" class="btn-primary" data-fb="triage" data-action="accept">Accept</button>
          <button type="button" class="btn-secondary" data-fb="triage" data-action="backlog">Backlog</button>
          <button type="button" class="btn-secondary" data-fb="triage" data-action="dismiss">Dismiss</button>
        </div>`);
    } else if (u.detail.questions.length > 0 && u.needsYou) {
      parts.push(this.renderQuestions(u));
    } else if (u.column === 'review' && u.needsYou) {
      parts.push(html`<div class="fb-verdict"><b>${u.escalated ? 'Escalated to you' : 'Waiting for your review'}</b>${u.detail.parkReason
        ? html`: ${u.detail.parkReason.split('\n')[0].replace(/^review: (escalated: )?/, '')}`
        : ''}</div>
        ${u.detail.verdict && html`<h4>Reviewer agent</h4><pre class="fb-pre">${u.detail.verdict}</pre>`}
        ${u.detail.hasSummary && this.inlineSummary(u)}
        <div class="fb-acts">
          <button type="button" class="btn-primary" data-fb="approve" ${this.busy ? 'disabled' : ''}>Approve</button>
          ${this.viewButton('changes', 'Request changes')}
          ${u.detail.worktreePath && this.viewButton('diff', 'Open diff')}
        </div>`);
    } else if (u.column === 'merging') {
      const m = this.data?.merges.find((x) => x.id === u.mergeId);
      parts.push(m ? this.renderMerge(m, false) : html`<p class="fb-path">Handed to the merge queue.</p>`);
    } else if (u.status === 'parked') {
      parts.push(html`<div class="fb-verdict"><b>Parked</b> at ${u.step ?? 'setup'}</div>
        ${u.detail.parkReason && html`<pre class="fb-pre">${u.detail.parkReason}</pre>`}
        <div class="fb-acts">
          <button type="button" class="btn-primary" data-fb="release" ${this.busy ? 'disabled' : ''}>Release for another round</button>
          ${u.detail.worktreePath && this.viewButton('diff', 'Open diff')}
        </div>`);
    }

    if (u.features.length > 0) {
      parts.push(html`<h4>Features, in order, one worktree</h4>
        <ul class="fb-features">${u.features.map(
          (f) => html`<li class="${f.state}"><span class="fb-mark">${f.state === 'done' ? '✓' : f.state === 'now' ? '…' : '○'}</span> ${f.state === 'now' ? html`<b>${f.title}</b> <span class="fb-path">(now)</span>` : f.title}</li>`
        )}</ul>`);
    }
    parts.push(renderClaimActions(u, this.busy, (id) => this.host.sessionExists?.(id) ?? false));
    parts.push(html`<h4>Live</h4><dl class="fb-kv">
      <dt>Step</dt><dd>${u.step ?? '—'}</dd>
      <dt>Heartbeat</dt><dd>${u.claim ? (u.claim.live ? 'your terminal' : 'terminal closed') : u.heartbeatAt ? `${shortAge(u.heartbeatAt)} ago` : '—'}</dd>
      <dt>Tokens</dt><dd>${formatTokens(u.tokens)}</dd>
      ${u.detail.worktreePath && html`<dt>Worktree</dt><dd class="fb-mono">${u.detail.worktreePath}</dd>`}
      ${u.detail.branch && html`<dt>Branch</dt><dd class="fb-mono">${u.detail.branch}</dd>`}
      ${u.detail.lastCommit && html`<dt>Last commit</dt><dd class="fb-mono">${u.detail.lastCommit.slice(0, 10)}</dd>`}
    </dl>`);
    const extra: SafeHtml[] = [];
    if (u.detail.hasSummary && !(u.column === 'review' && u.needsYou)) extra.push(this.viewButton('summary', 'Summary page'));
    if (u.detail.worktreePath && !u.needsYou) extra.push(this.viewButton('diff', 'Open diff'));
    if (extra.length > 0) parts.push(html`<div class="fb-acts">${extra}</div>`);
    return joinHtml(parts);
  }

  /** The summary page inline under an escalated review: what you read before approving. */
  private inlineSummary(u: FactoryBoardUnit): SafeHtml {
    const text = this.summaries.get(u.key);
    if (text === undefined) void this.loadSummary(u);
    return html`<h4>Summary</h4>${text === undefined ? html`<p class="fb-path">Loading…</p>` : html`<div class="fb-md">${renderMarkdown(text)}</div>`}`;
  }

  private renderQuestions(u: FactoryBoardUnit): SafeHtml {
    return html`<div class="fb-verdict"><b>Shaping needs an answer</b>${u.reason ? html`: ${u.reason}` : ''}</div>
      ${u.detail.questions.map((q) => {
        const chosen = this.drafts.get(`choice:${u.key}:${q.id}`) ?? q.default ?? '';
        const name = `choice:${u.key}:${q.id}`;
        return html`<fieldset class="fb-question"><legend>${q.question}</legend>
          ${q.options.map(
            (o) => html`<label><input type="radio" name="${name}" value="${o}" data-draft="${name}" ${o === chosen ? 'checked' : ''}> ${o}${o === q.default ? html` <span class="fb-path">(default)</span>` : ''}</label>`
          )}
          <label><input type="radio" name="${name}" value="__other" data-draft="${name}" ${chosen === '__other' || (q.options.length === 0) ? 'checked' : ''}> Other:</label>
          <input type="text" class="fb-input" data-draft="other:${u.key}:${q.id}" value="${this.drafts.get(`other:${u.key}:${q.id}`) ?? ''}" placeholder="Your answer">
        </fieldset>`;
      })}
      <div class="fb-acts"><button type="button" class="btn-primary" data-fb="answer" ${this.busy ? 'disabled' : ''}>Answer</button></div>`;
  }

  private renderMerge(m: FactoryMergeSummary, withHead: boolean): SafeHtml {
    return html`${withHead && html`<span class="fb-path">${m.kind === 'session-land' ? 'Land' : 'Merge'} · ${m.projectName}</span><h3>${m.title}</h3>`}
      <h4>Merge queue</h4>
      <dl class="fb-kv">
        <dt>Status</dt><dd>${m.status}</dd>
        <dt>Branch</dt><dd class="fb-mono">${m.branch}</dd>
        ${m.mergeSha && html`<dt>Merge commit</dt><dd class="fb-mono">${m.mergeSha.slice(0, 10)}</dd>`}
        <dt>Updated</dt><dd>${shortAge(m.updatedAt)} ago</dd>
      </dl>
      ${m.detail && html`<div class="fb-verdict">${m.status === 'parked' ? html`<b>Parked</b>: ` : ''}${m.detail}</div>`}
      ${m.conflictPaths.length > 0 && html`<h4>Conflicts the resolver could not settle</h4><ul>${m.conflictPaths.map((p) => html`<li class="fb-mono">${p}</li>`)}</ul>`}
      ${m.status === 'parked' && html`<div class="fb-acts"><button type="button" class="btn-primary" data-fb="retry-merge" data-merge-id="${m.id}" ${this.busy ? 'disabled' : ''}>Retry merge</button></div>`}`;
  }

  private renderAdd(): SafeHtml {
    const cwd = this.drafts.get('add:cwd') ?? this.projects[0]?.cwd ?? '';
    const result = this.addResult;
    return html`<span class="fb-path">Add work</span><h3>File loose work</h3>
      <p class="fb-path">A sentence, bullets, several asks mixed: intake decides what is a feature and what is a requirement of one, and files them into the project's Inbox track.</p>
      <label class="fb-label">Project
        <select class="fb-input" data-draft="add:cwd">${this.projects.map((p) => html`<option value="${p.cwd}" ${p.cwd === cwd ? 'selected' : ''}>${p.name}</option>`)}</select>
      </label>
      <label class="fb-label">Track <span class="fb-path">(optional; Inbox by default)</span>
        <input type="text" class="fb-input" data-draft="add:track" value="${this.drafts.get('add:track') ?? ''}" placeholder="Inbox">
      </label>
      <label class="fb-label">What to do
        <textarea class="fb-textarea" rows="8" data-draft="add:text" placeholder="- fork loses the window title&#10;- android push should retry on 503, but don't spam">${this.drafts.get('add:text') ?? ''}</textarea>
      </label>
      <div class="fb-acts"><button type="button" class="btn-primary" data-fb="submit-add" ${this.busy ? 'disabled' : ''}>${this.busy ? 'Filing…' : 'Add work'}</button></div>
      ${result && html`<h4>Intake filed</h4>${result.features.length > 0
        ? html`<ul class="fb-intake">${result.features.map(
            (f) => html`<li><span class="fo-id">${f.id}</span> ${f.title}${f.mockupFirst ? html` <span class="fb-path">· mockup first</span>` : ''}${f.requirements.length > 0
              ? html`<ul>${f.requirements.map((r) => html`<li class="fb-path">requirement: ${r}</li>`)}</ul>`
              : ''}</li>`
          )}</ul>`
        : html`<p class="fb-path">Nothing was filed.</p>`}`}`;
  }

  private viewButton(view: 'main' | 'summary' | 'diff' | 'changes', label: string): SafeHtml {
    return html`<button type="button" class="btn-secondary" data-fb="view" data-view="${view}">${label}</button>`;
  }
}
