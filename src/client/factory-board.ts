import { html, setHtml, type SafeHtml } from './html-utils.js';
import { requestJson, failureMessage } from './api.js';
import { isClaimAction, runClaimAction } from './factory-claims.js';
import { formatTokens } from './format.js';
import { MockupDrawer } from './factory-mockup.js';
import { DEFAULT_STAGE, STAGES, renderStagePicker, renderStageRows, stageGroups, type StageGroup } from './factory-board-pipeline.js';
import { needsYouUnits, renderNeedsYou } from './factory-board-needs.js';
import {
  PHONE_QUERY,
  PHONE_STAGES,
  PHONE_TABS,
  phoneStage,
  phoneStageGroups,
  renderDone,
  renderPhoneFlow,
  renderPhoneTabs,
  renderYou,
  type PhoneTab,
} from './factory-board-phone.js';
import type { PlanUsage } from './plan-usage-chip.js';
import { VIEW_MODE_KEY, flowLanes, readViewMode, renderFlow, type ViewMode } from './factory-board-flow.js';
import { renderSidePanel } from './factory-board-side.js';
import {
  DecisionQueue,
  UNDO_MS,
  asAnswered,
  asApproved,
  asSentBack,
  asTriaged,
  type Decision,
  type DecisionClock,
  type DecisionResult,
} from './factory-decisions.js';
import { paneShowsMockup, renderMarkdown, renderPane, type PaneSelection, type UnitView } from './factory-board-pane.js';
import type { FactoryBoard, FactoryBoardUnit, FactoryColumn, FactoryQuestion, FactoryReport } from '../shared/protocol.js';

// Their tests and callers import these from the board.
export { cancellable, renderMarkdown } from './factory-board-pane.js';

/**
 * The factory board (project/code-factory.md, item 7; layout E in
 * project/factory-page-redesign.md): the main-area view the Factory overlay's
 * "Open board" leads to. **Needs you** first, each card with its decision
 * inline (factory-board-needs.ts), hidden when nothing waits; then the
 * **Pipeline**, a stage picker over the six columns — intake, ready, running,
 * review, merging, done today — listing the selected stage's units as rows
 * (factory-board-pipeline.ts), or, with the header's toggle on Flow, one lane
 * per track with each unit at its stage (factory-board-flow.ts); on the right a side panel with capacity, the
 * morning report and the merge queue (factory-board-side.ts). Clicking a card,
 * a row or a link opens the unit in the **detail pane** (factory-board-pane.ts),
 * docked in that right-hand column in the side panel's place, never over the
 * board: an escalated review with its summary page (Approve / Request changes /
 * Open diff), a shaping question with its options and default, a triage card
 * (accept / backlog / dismiss), a running track's features, a mockup, a merge
 * entry with its resolver or park state. Add work is a modal that files
 * free-form text through intake.
 *
 * Data: GET /api/factory/board, fetched on open and again on every pushed
 * `factory.summary` while the board is on screen — never polled. `render()`
 * replaces the board, the pane and the modal wholesale (an unchanged mockup pane
 * excepted); drafts (a note, an answer, Add work's text) are captured before and
 * restored after, with the focus.
 *
 * Routes it calls that the factory's other half serves: POST /api/factory/add,
 * /api/factory/items/:id/answer and /api/factory/triage/:id. Its own (server
 * factory/board-routes.ts): board, report, summary, diff, release, merge retry.
 */

/** When this browser last opened the board: the morning report counts from here. */
export const LAST_OPENED_KEY = 'factoryBoardLastOpened';

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
  /** The plan-usage chip's last reading, for the phone's You tile; null before the first. */
  planUsage?(): PlanUsage | null;
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

export interface FactoryBoardOptions {
  /** How long a decision's Undo toast stays before it is sent (factory-decisions.ts). */
  undoMs?: number;
  /** Its timers; the tests pass their own. */
  clock?: DecisionClock;
  /** The page is a phone's (≤640px): You / Flow / Done tabs and a bottom sheet. Default: the media query. */
  isPhone?: () => boolean;
}

export class FactoryBoardView {
  /** The board as GET /api/factory/board last answered. */
  private served: FactoryBoard | null = null;
  /** What the page shows: `served` with the decisions not yet reflected in it applied. */
  private data: FactoryBoard | null = null;
  /** Approve, Answer, Build it, Send back and triage: applied now, sent after Undo's window. */
  private readonly decisions: DecisionQueue;
  /** The toasts' ids last drawn, so a render doesn't restart their countdown. */
  private drawnToasts = '';
  private error: string | null = null;
  private visible = false;
  /** The unit or merge entry the docked detail pane shows; null shows the side panel. */
  private pane: PaneSelection | null = null;
  /** The Add work modal is open (over the board: it is not a unit, so it never docks). */
  private adding = false;
  /** The Pipeline's selected stage; kept across visits in this page, not stored. */
  private stage: FactoryColumn = DEFAULT_STAGE;
  /** A unit the board was opened on: its stage is selected once the board data holds it. */
  private selectStageOf: string | null = null;
  /** Board (the Pipeline's stage picker) or Flow (lanes per track); remembered per browser. */
  private mode: ViewMode = readViewMode(readStorage(VIEW_MODE_KEY));
  /** On a phone: the tab bar's tab (factory-board-phone.ts). You first on every visit. */
  private phoneTab: PhoneTab = 'you';
  private readonly isPhone: () => boolean;
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
  /** The pane markup last set, so an unchanged mockup pane is not replaced (render()). */
  private drawnPane = '';
  /** An item parked at its mockup step: its pane part and `mockup-*` actions (factory-mockup.ts). */
  private readonly mockup = new MockupDrawer({
    render: () => this.render(),
    act: (label, call, done) => this.act(label, call, done),
    post: (url, body) => this.post(url, body),
    busy: () => this.busy,
    draft: (key) => this.drafts.get(key) ?? '',
    clearDraft: (key) => {
      this.drafts.delete(key);
      // render() captures drafts from the DOM first: a box still holding the text would bring it back.
      const box = [...document.querySelectorAll<HTMLTextAreaElement>('#factory-board-view [data-draft]')].find((el) => el.dataset.draft === key);
      if (box) box.value = '';
    },
    notify: (text) => {
      this.notice = { text, error: true };
      this.render();
    },
    markdown: renderMarkdown,
  });

  constructor(
    private readonly host: FactoryBoardHost,
    options: FactoryBoardOptions = {}
  ) {
    this.decisions = new DecisionQueue(
      {
        onChange: () => {
          this.refreshView();
          this.render();
        },
        onSent: (decision, result) => this.onDecisionSent(decision, result),
      },
      options.undoMs ?? UNDO_MS,
      options.clock
    );
    this.isPhone = options.isPhone ?? (() => window.matchMedia?.(PHONE_QUERY).matches ?? false);
  }

  isVisible(): boolean {
    return this.visible;
  }

  attach(): void {
    const root = document.getElementById('factory-board-view');
    root?.addEventListener('click', (event) => void this.onClick(event));
    // Leaving the page sends what still waits for its Undo window; keepalive lets it outlive the page.
    window.addEventListener('pagehide', () => void this.decisions.flush(true));
    // Crossing 640px switches between the desktop layout and the phone's tabs.
    window.matchMedia?.(PHONE_QUERY).addEventListener?.('change', () => {
      if (this.visible) this.render();
    });
    root?.addEventListener('keydown', (event) => {
      if (event.key !== 'Escape') return;
      // The modal first: it sits over the pane.
      if (this.adding) this.adding = false;
      else if (this.pane) this.pane = null;
      else return;
      this.notice = null;
      this.render();
    });
  }

  /** Open the board, with a unit in the detail pane, or Add work. */
  async show(unitKey?: string, add = false): Promise<void> {
    const wasVisible = this.visible;
    this.visible = true;
    this.host.takeMainArea();
    document.getElementById('factory-board-view')?.classList.remove('hidden');
    this.host.syncOverlay();
    if (unitKey) {
      this.pane = { kind: 'unit', key: unitKey, view: 'main' };
      this.selectStageOf = unitKey;
      this.syncStageToUnit();
    } else if (add) this.openAdd();
    this.render();
    const loads: Promise<void>[] = [this.load()];
    if (!wasVisible) loads.push(this.loadReport());
    await Promise.all(loads);
  }

  hide(): void {
    if (!this.visible) return;
    // Decisions waiting for their Undo window go out now: leaving the board must not lose them.
    void this.decisions.flush();
    this.visible = false;
    this.pane = null;
    this.selectStageOf = null;
    this.adding = false;
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
      // Decisions that land after this point are not in this answer: they stay applied.
      const mark = this.decisions.mark();
      const res = await requestJson<FactoryBoard>('/api/factory/board');
      if (res.ok) {
        this.served = res.data;
        this.decisions.settle(mark);
        this.refreshView();
        this.syncStageToUnit();
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
    this.adding = true;
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

  private post(url: string, body?: object, keepalive = false) {
    return requestJson(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body ?? {}),
      ...(keepalive ? { keepalive } : {}),
    });
  }

  // --- Decisions (factory-decisions.ts) -------------------------------------

  /**
   * Opening the board on a unit selects the stage that lists it (the picker keeps its
   * last stage otherwise, and the unit's row is not shown). Waits for board data, which
   * the first render may precede; fires once, so picking another stage afterwards sticks.
   * The phone's Flow stage follows `stage` (phoneStage), and Flow lists every stage.
   */
  private syncStageToUnit(): void {
    if (!this.selectStageOf || !this.data) return;
    const unit = this.unit(this.selectStageOf);
    if (!unit) return;
    this.selectStageOf = null;
    if (STAGES.some((s) => s.id === unit.column)) this.stage = unit.column;
  }

  private refreshView(): void {
    this.data = this.served ? { ...this.served, units: this.decisions.overlay(this.served.units) } : null;
  }

  /** Apply a decision now; its POST goes out when the Undo toast expires. */
  private decide(unit: FactoryBoardUnit, label: string, apply: Decision['apply'], url: string, body: object, onLanded?: () => void): void {
    this.notice = null;
    this.decisions.add({ unitKey: unit.key, label, apply, onLanded, send: (keepalive) => this.post(url, body, keepalive) });
  }

  private onDecisionSent(decision: Decision, result: DecisionResult): void {
    if (result.ok) {
      decision.onLanded?.();
      if (this.visible) void this.load();
      return;
    }
    // Refused: the queue dropped it, so the unit shows as the server has it again.
    this.notice = { text: failureMessage(result, `Could not send "${decision.label}"`), error: true };
    this.render();
    if (this.visible) void this.load();
  }

  /** One toast per decision still in its Undo window. */
  private renderToasts(): void {
    const el = document.getElementById('factory-board-toasts');
    if (!el) return;
    const pending = this.decisions.pending();
    const phone = this.isPhone();
    const ids = `${phone ? 'phone' : 'desk'}:${pending.map((p) => p.id).join(',')}`;
    // Redrawn only when the set changes, or each render would restart the countdown bar.
    if (ids === this.drawnToasts) return;
    this.drawnToasts = ids;
    setHtml(
      el,
      html`${pending.map((p) => {
        // On a phone the toast says where the unit went in Flow, and takes you there.
        const stage = phone ? this.movedTo(p.decision) : null;
        const label = stage ? PHONE_STAGES.find((s) => s.id === stage)?.label : null;
        return html`<div class="fb-toast" data-decision="${String(p.id)}" role="status">
          <span>${p.decision.label}</span>
          ${stage && label && html`<button type="button" class="fb-undo" data-fb="phone-flow" data-stage="${stage}">Flow: ${label}</button>`}
          <button type="button" class="fb-undo" data-fb="undo" data-decision="${String(p.id)}">Undo</button>
          <i class="fb-toast-bar"></i>
        </div>`;
      })}`
    );
  }

  /** The phone Flow stage a decision moves its unit to, or null when it leaves the board. */
  private movedTo(decision: Decision): FactoryColumn | null {
    const before = this.served?.units.find((u) => u.key === decision.unitKey);
    const after = before ? decision.apply(before) : null;
    return after && after.column !== 'done' ? phoneStage(after.column) : null;
  }

  private async onClick(event: Event): Promise<void> {
    const target = event.target as HTMLElement;
    const card = target.closest<HTMLElement>('[data-unit-key]');
    const mergeCard = target.closest<HTMLElement>('[data-merge-card]');
    const action = target.closest<HTMLElement>('[data-fb]');
    if (action) return this.onAction(action);
    if (card) {
      this.pane = { kind: 'unit', key: card.dataset.unitKey as string, view: 'main' };
      this.notice = null;
      return this.render();
    }
    if (mergeCard) {
      this.pane = { kind: 'merge', id: mergeCard.dataset.mergeCard as string };
      this.notice = null;
      return this.render();
    }
  }

  private async onAction(el: HTMLElement): Promise<void> {
    const kind = el.dataset.fb;
    const pane = this.pane;
    // A Needs you card's inline decision acts on its own unit, whatever the pane shows.
    const needKey = el.closest<HTMLElement>('[data-need]')?.dataset.need;
    const unit = needKey ? this.unit(needKey) : pane?.kind === 'unit' ? this.unit(pane.key) : undefined;
    const featureId = unit?.featureIds[0];
    if (kind === 'mockup-approve') {
      // Build it: a decision like Approve, with Undo (the comment stays an immediate send).
      if (!unit || !featureId) return;
      return this.decide(unit, 'Mockup approved: it moves to Running to be built', asApproved, `/api/factory/items/${featureId}/release`, {
        cwd: unit.projectCwd,
        outcome: 'approved',
      });
    }
    if (kind?.startsWith('mockup-')) {
      this.captureDrafts();
      return this.mockup.onAction(kind, unit);
    }
    switch (kind) {
      case 'back':
        this.hide();
        this.host.returnToMain();
        return;
      case 'add':
        this.openAdd();
        return this.render();
      case 'close':
        this.pane = null;
        this.notice = null;
        return this.render();
      case 'close-add':
        this.adding = false;
        this.notice = null;
        return this.render();
      case 'dismiss-report':
        this.report = null;
        return this.render();
      case 'refresh':
        return this.load();
      case 'view-mode': {
        this.mode = readViewMode(el.dataset.mode ?? null);
        writeStorage(VIEW_MODE_KEY, this.mode);
        return this.render();
      }
      case 'stage': {
        const stage = el.dataset.stage as FactoryColumn | undefined;
        if (stage && STAGES.some((s) => s.id === stage)) this.stage = stage;
        return this.render();
      }
      case 'phone-tab': {
        const tab = el.dataset.tab as PhoneTab | undefined;
        if (tab && PHONE_TABS.some((t) => t.id === tab)) this.phoneTab = tab;
        return this.render();
      }
      case 'phone-flow': {
        // A tile, the running preview or a toast: Flow at that stage.
        const stage = el.dataset.stage as FactoryColumn | undefined;
        this.phoneTab = 'flow';
        if (stage && STAGES.some((s) => s.id === stage)) this.stage = stage;
        return this.render();
      }
      case 'view':
        if (pane?.kind === 'unit') {
          pane.view = (el.dataset.view as UnitView | undefined) ?? 'main';
          if (pane.view === 'summary' && unit) void this.loadSummary(unit);
          if (pane.view === 'diff' && unit) void this.loadDiff(unit);
        }
        return this.render();
      case 'undo': {
        if (this.decisions.undo(Number(el.dataset.decision))) this.notice = { text: 'Undone: nothing was sent', error: false };
        return this.render();
      }
      case 'approve':
        if (!unit || !featureId) return;
        return this.decide(unit, 'Approved: it moves to Merging', asApproved, `/api/factory/items/${featureId}/release`, {
          cwd: unit.projectCwd,
          outcome: 'approved',
        });
      case 'send-changes': {
        if (!unit || !featureId) return;
        this.captureDrafts();
        const note = (this.drafts.get(`changes:${unit.key}`) ?? '').trim();
        if (!note) {
          this.notice = { text: 'Say what to change first.', error: true };
          return this.render();
        }
        // Back to the unit's main view now; the note stays a draft until the send lands, so Undo keeps it.
        if (this.pane?.kind === 'unit') this.pane.view = 'main';
        return this.decide(
          unit,
          'Sent back: it moves to Running for the fix step',
          asSentBack,
          `/api/factory/items/${featureId}/release`,
          { cwd: unit.projectCwd, outcome: 'changes', note },
          () => this.drafts.delete(`changes:${unit.key}`)
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
        return this.decide(
          unit,
          'Answered: shaping goes on in Intake',
          asAnswered,
          `/api/factory/items/${featureId}/answer`,
          { cwd: unit.projectCwd, answer },
          () => {
            for (const q of questions) {
              this.drafts.delete(`choice:${unit.key}:${q.id}`);
              this.drafts.delete(`other:${unit.key}:${q.id}`);
            }
          }
        );
      }
      case 'answer-option': {
        // Needs you: one question, answered by clicking an option.
        const answer = el.dataset.value;
        const q = unit?.detail.questions[0];
        if (!unit || !featureId || !q || answer === undefined) return;
        return this.decide(
          unit,
          'Answered: shaping goes on in Intake',
          asAnswered,
          `/api/factory/items/${featureId}/answer`,
          { cwd: unit.projectCwd, answer },
          () => {
            this.drafts.delete(`choice:${unit.key}:${q.id}`);
            this.drafts.delete(`other:${unit.key}:${q.id}`);
          }
        );
      }
      case 'triage': {
        if (!unit || !featureId) return;
        const verb = el.dataset.action as 'accept' | 'backlog' | 'dismiss';
        if (verb !== 'accept' && verb !== 'backlog' && verb !== 'dismiss') return;
        const label = verb === 'accept' ? 'Accepted: it moves to Intake for shaping' : verb === 'backlog' ? 'Moved to the backlog' : 'Dismissed';
        // Backlog and dismiss take it off the board: its pane has nothing left to show.
        if (verb !== 'accept' && this.pane?.kind === 'unit' && this.pane.key === unit.key) this.pane = null;
        return this.decide(unit, label, (u) => asTriaged(u, verb), `/api/factory/triage/${featureId}`, { cwd: unit.projectCwd, action: verb });
      }
      case 'cancel-unit':
        if (!unit || !featureId) return;
        return this.act(
          `Cancelled ${unit.isTrack ? `"${unit.trackName}"` : featureId}`,
          () => this.post(`/api/factory/items/${featureId}/cancel`, { cwd: unit.projectCwd }),
          () => {
            this.pane = null;
          }
        );
      case 'start-now': {
        // A Ready row's button: its unit is named on the button, not the pane's.
        const ready = el.dataset.unit ? this.unit(el.dataset.unit) : undefined;
        const id = ready?.featureIds[0];
        if (!ready || !id) return;
        return this.act('Started now: it moves to Running', () => this.post(`/api/factory/items/${id}/start`, { cwd: ready.projectCwd }));
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
        const mockupFirst = this.drafts.get('add:mockup') === 'on';
        if (!cwd || !text) {
          this.notice = { text: 'Pick a project and describe the work.', error: true };
          return this.render();
        }
        if (this.busy) return;
        this.busy = true;
        this.notice = null;
        this.render();
        const res = await this.post('/api/factory/add', { cwd, text, ...(track ? { track } : {}), ...(mockupFirst ? { mockupFirst } : {}) });
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
      } else if (el instanceof HTMLInputElement && el.type === 'checkbox') {
        this.drafts.set(el.dataset.draft as string, el.checked ? 'on' : '');
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

    const phone = this.isPhone();
    document.getElementById('factory-board-view')?.classList.toggle('fb-phone', phone);
    this.renderStatus();
    this.renderModeToggle();
    this.renderPhoneTabs(phone);
    const body = document.getElementById('factory-board-body');
    if (body) setHtml(body, this.renderBody());
    this.renderRight();
    this.renderAddModal();
    this.renderToasts();

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
    const groups = stageGroups(d);
    const selected = groups.find((g) => g.id === this.stage) ?? groups[0];
    const openKey = this.pane?.kind === 'unit' ? this.pane.key : null;
    const openMerge = this.pane?.kind === 'merge' ? this.pane.id : null;
    const notice = this.notice && !this.pane && !this.adding ? html`<div class="fb-notice${this.notice.error ? ' error' : ''}">${this.notice.text}</div>` : '';
    // Ready rows offer Start now (POST /api/factory/items/:id/start).
    const start = { dispatch: d.dispatch, busy: this.busy };
    if (this.isPhone()) {
      const tab =
        this.phoneTab === 'flow'
          ? renderPhoneFlow(phoneStageGroups(groups), phoneStage(this.stage), openKey, openMerge, start)
          : this.phoneTab === 'done'
            ? renderDone(groups.find((g) => g.id === 'done') as StageGroup, this.report, openKey, openMerge)
            : renderYou(d, groups, this.host.planUsage?.() ?? null, this.busy, openKey);
      return html`${notice}${tab}`;
    }
    return html`<div class="fb-main">
        ${notice}
        ${renderNeedsYou(d.units, this.busy, openKey)}
        ${this.mode === 'flow'
          ? renderFlow(flowLanes(d), openKey, openMerge)
          : html`<section class="fb-pipeline" aria-label="Pipeline">
              <h3>Pipeline</h3>
              ${renderStagePicker(groups, selected.id)}
              ${renderStageRows(selected, openKey, openMerge, start)}
            </section>`}
      </div>`;
  }

  /** The phone's You / Flow / Done bar; empty (and hidden by CSS) on a desktop. */
  private renderPhoneTabs(phone: boolean): void {
    const el = document.getElementById('factory-phone-tabs');
    if (!el) return;
    el.classList.toggle('hidden', !phone);
    const needs = phone && this.data ? needsYouUnits(this.data.units).length : 0;
    setHtml(el, phone ? renderPhoneTabs(this.phoneTab, needs) : html``);
  }

  /** The header's Board / Flow toggle shows the view on screen. */
  private renderModeToggle(): void {
    for (const el of document.querySelectorAll<HTMLElement>('#factory-board-view [data-fb="view-mode"]')) {
      const on = el.dataset.mode === this.mode;
      el.classList.toggle('on', on);
      el.setAttribute('aria-pressed', String(on));
    }
  }

  /**
   * The right-hand column: the side panel, or the detail pane in its place while a
   * unit is open. The pane docks beside the board, never over it.
   */
  private renderRight(): void {
    const root = document.getElementById('factory-board-view');
    const side = document.getElementById('factory-side');
    const paneEl = document.getElementById('factory-drawer');
    // A mockup needs room: the column widens while the pane shows one.
    const mockup = paneShowsMockup(this.pane, this.data);
    root?.classList.toggle('fb-pane-open', !!this.pane);
    root?.classList.toggle('fb-pane-wide', !!this.pane && mockup);
    // A phone has no side panel: its tiles are on You, the report on Done.
    const phone = this.isPhone();
    if (side) {
      const shown = !this.pane && !phone;
      side.classList.toggle('hidden', !shown);
      setHtml(side, this.data && shown ? renderSidePanel(this.data, this.report) : html``);
    }
    if (!paneEl) return;
    paneEl.classList.toggle('hidden', !this.pane);
    const markup = this.pane
      ? renderPane(this.pane, {
          data: this.data,
          busy: this.busy,
          notice: this.adding ? null : this.notice,
          drafts: this.drafts,
          summary: (u, load) => {
            const text = this.summaries.get(u.key);
            if (text === undefined && load) void this.loadSummary(u);
            return text;
          },
          diff: (key) => this.diffs.get(key),
          mockup: this.mockup,
          sessionExists: (id) => this.host.sessionExists?.(id) ?? false,
          phone,
        })
      : html``;
    // Replacing a mockup's frame reloads it and loses where you clicked to; a push for
    // another unit renders the same pane, so an unchanged one is left as it is.
    if (!mockup || markup.value !== this.drawnPane) setHtml(paneEl, markup);
    this.drawnPane = markup.value;
  }

  /** Add work: a modal over the board, not a unit, so it never takes the pane's place. */
  private renderAddModal(): void {
    const el = document.getElementById('factory-add');
    if (!el) return;
    el.classList.toggle('hidden', !this.adding);
    const notice = this.notice ? html`<div class="fb-notice${this.notice.error ? ' error' : ''}">${this.notice.text}</div>` : '';
    setHtml(
      el,
      this.adding
        ? html`<div class="fb-modal-box" role="dialog" aria-modal="true" aria-label="Add work">
            <button type="button" class="fb-x" data-fb="close-add" aria-label="Close">×</button>${this.renderAdd()}${notice}
          </div>`
        : html``
    );
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
      <label class="fb-check"><input type="checkbox" data-draft="add:mockup" ${this.drafts.get('add:mockup') === 'on' ? 'checked' : ''}> Mockup first <span class="fb-path">(approve a clickable mockup before it is built)</span></label>
      <div class="fb-acts"><button type="button" class="btn-primary" data-fb="submit-add" ${this.busy ? 'disabled' : ''}>${this.busy ? 'Filing…' : 'Add work'}</button></div>
      ${result && html`<h4>Intake filed</h4>${result.features.length > 0
        ? html`<ul class="fb-intake">${result.features.map(
            (f) => html`<li><span class="fo-id">${f.id}</span> ${f.title}${f.mockupFirst ? html` <span class="fb-path">· mockup first</span>` : ''}${f.requirements.length > 0
              ? html`<ul>${f.requirements.map((r) => html`<li class="fb-path">requirement: ${r}</li>`)}</ul>`
              : ''}</li>`
          )}</ul>`
        : html`<p class="fb-path">Nothing was filed.</p>`}`}`;
  }
}
