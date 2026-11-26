import { html, joinHtml, setHtml, type SafeHtml } from './html-utils.js';
import { formatTokens } from './format.js';
import type { FactorySummary, FactoryUnitSummary } from '../shared/protocol.js';

export type { FactorySummary, FactoryUnitSummary } from '../shared/protocol.js';

/**
 * The Factory panel over the main area (project/code-factory.md, item 7): the
 * Jobs overlay, reworked for the factory. Counts in the pill, one card per unit
 * of work with a status rail, a track's features as a progress strip, and a
 * footer to the board and Add work.
 *
 * Fed by the pushed `factory.summary` (server factory/board.ts) — it never
 * polls. When a unit newly waits for you (an escalated review, a question, a
 * park) the pill flashes amber and a toast names it: that is the one thing
 * here worth interrupting you for.
 *
 * Placement and on/off are per device in localStorage, as the Jobs overlay's
 * were (project/live-job-overlay.md); the old keys are read once as defaults.
 */

export type OverlayPlacement = 'header' | 'below';

const ENABLED_KEY = 'factoryOverlayEnabled';
const PLACEMENT_KEY = 'factoryOverlayPlacement';
const OPEN_KEY = 'factoryOverlayOpen';
/** The Jobs overlay's keys: a device that turned it off keeps the Factory overlay off. */
const LEGACY = { enabled: 'jobOverlayEnabled', placement: 'jobOverlayPlacement', open: 'jobOverlayOpen' };

/** A finished unit's card stays this long after it finished; the pill's count keeps the day's. */
export const DONE_LINGER_MS = 15 * 60_000;
const TOAST_MS = 9000;

function stored(key: string, legacy: string): string | null {
  try {
    return localStorage.getItem(key) ?? localStorage.getItem(legacy);
  } catch {
    return null;
  }
}

function store(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Private mode: the preference lasts for this page only.
  }
}

/** The rail and tint of a card: what waits for you first, then the column. */
export function cardKind(unit: FactoryUnitSummary): string {
  if (unit.needsYou) return 'you';
  return unit.column;
}

/** The cards worth showing, in the overlay's order: you, running, review, intake, ready, merging, done. */
export function overlayUnits(units: FactoryUnitSummary[], now: number): FactoryUnitSummary[] {
  const rank: Record<string, number> = { you: 0, running: 1, review: 2, intake: 3, ready: 4, merging: 5, done: 6 };
  return units
    .filter((u) => u.column !== 'done' || now - Date.parse(u.updatedAt) < DONE_LINGER_MS)
    .sort((a, b) => rank[cardKind(a)] - rank[cardKind(b)] || b.updatedAt.localeCompare(a.updatedAt));
}

/** Units that wait for you now and did not in the last summary seen. */
export function newlyNeedingYou(previous: Set<string>, units: FactoryUnitSummary[]): FactoryUnitSummary[] {
  return units.filter((u) => u.needsYou && u.column !== 'done' && !previous.has(u.key));
}

/** The line under a card's title: where it is and why. */
export function cardStatus(unit: FactoryUnitSummary): string {
  if (unit.stalled) return `stalled: ${unit.stalled}`;
  if (unit.triage) return 'triage: accept, backlog or dismiss';
  if (unit.needsYou && unit.escalated) return unit.reason?.replace(/^review: /, '') ?? 'escalated to you';
  if (unit.needsYou) return unit.reason ?? `waits for you at ${unit.step ?? unit.column}`;
  const model = unit.modelTier ? ` · ${unit.modelTier}` : '';
  switch (unit.column) {
    case 'intake':
      return `shaping${model}`;
    case 'ready':
      return unit.waitsFor.length > 0 ? `waits for ${unit.waitsFor.join(', ')}` : `ready${model}`;
    case 'running': {
      if (unit.isTrack && unit.features.length > 0) {
        const at = unit.features.findIndex((f) => f.state === 'now');
        const n = at >= 0 ? at + 1 : unit.features.filter((f) => f.state === 'done').length + 1;
        return `feature ${Math.min(n, unit.features.length)} of ${unit.features.length}${unit.step ? ` · ${unit.step}` : ''}${model}`;
      }
      return `${unit.step ?? 'running'}${model}`;
    }
    case 'review':
      return 'reviewer agent checking';
    case 'merging':
      return unit.reason ?? `merge ${unit.mergeStatus ?? 'queued'}`;
    case 'done':
      return 'merged';
  }
}

/** A track's features as a strip: done, now, to do. */
export function progressStrip(unit: FactoryUnitSummary, cls = 'fo-prog'): SafeHtml | '' {
  if (!unit.isTrack || unit.features.length === 0) return '';
  return html`<span class="${cls}" aria-label="${unit.features.filter((f) => f.state === 'done').length} of ${unit.features.length} features done">${unit.features.map(
    (f) => html`<i class="${f.state === 'done' ? 'd' : f.state === 'now' ? 'n' : ''}"></i>`
  )}</span>`;
}

function readPlacement(): OverlayPlacement {
  return stored(PLACEMENT_KEY, LEGACY.placement) === 'header' ? 'header' : 'below';
}

export interface FactoryOverlayHost {
  /** Open the board, with this unit's drawer when given. */
  openBoard(unitKey?: string): void;
  /** The board's Add work dialog. */
  addWork(): void;
}

export class FactoryOverlay {
  private summary: FactorySummary | null = null;
  /** Keys that waited for you in the last summary, so a new one is news; null until the first. */
  private needing: Set<string> | null = null;
  private enabled = stored(ENABLED_KEY, LEGACY.enabled) !== 'false';
  private placement: OverlayPlacement = readPlacement();
  private open = stored(OPEN_KEY, LEGACY.open) !== 'false';
  /** True while a view owns the top-right corner itself (Projects, Overview, the board). */
  private suppressed = false;
  private toastTimer: number | null = null;

  constructor(private readonly host: FactoryOverlayHost) {}

  /** Wire up the static markup. Call once, after DOMContentLoaded. */
  attach(): void {
    const toggle = () => {
      this.open = !this.open;
      store(OPEN_KEY, String(this.open));
      this.render();
    };
    const bar = document.getElementById('factory-overlay-bar');
    bar?.addEventListener('click', toggle);
    bar?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        toggle();
      }
    });
    document.getElementById('factory-overlay')?.addEventListener('click', (event) => {
      const target = event.target as HTMLElement;
      const card = target.closest<HTMLElement>('[data-unit-key]');
      if (card) return this.host.openBoard(card.dataset.unitKey);
      if (target.closest('[data-fo-board]')) return this.host.openBoard();
      if (target.closest('[data-fo-add]')) return this.host.addWork();
    });
    document.getElementById('factory-toast')?.addEventListener('click', (event) => {
      const target = event.target as HTMLElement;
      const review = target.closest<HTMLElement>('[data-unit-key]');
      if (review) {
        this.hideToast();
        this.host.openBoard(review.dataset.unitKey);
      } else if (target.closest('[data-fo-dismiss]')) {
        this.hideToast();
      }
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
    store(ENABLED_KEY, String(enabled));
    store(PLACEMENT_KEY, placement);
    this.applyPlacement();
    this.render();
  }

  setSuppressed(suppressed: boolean): void {
    if (this.suppressed === suppressed) return;
    this.suppressed = suppressed;
    this.render();
  }

  /**
   * Re-home the panel: in `header` placement a flex item inside the terminal
   * header (left of its controls), floating where the header would be when no
   * header is on screen. The Jobs overlay's rule (project/live-job-overlay.md).
   */
  applyPlacement(): void {
    const root = document.getElementById('factory-overlay');
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

  latest(): FactorySummary | null {
    return this.summary;
  }

  update(summary: FactorySummary): void {
    const fresh = this.needing ? newlyNeedingYou(this.needing, summary.units) : [];
    this.needing = new Set(summary.units.filter((u) => u.needsYou).map((u) => u.key));
    this.summary = summary;
    this.render();
    // The first summary after a (re)connect is the state, not news.
    if (fresh.length > 0 && this.enabled) this.announce(fresh);
  }

  /** Nothing while the socket is down: stale states are worse than none. */
  clear(): void {
    this.summary = null;
    this.needing = null;
    this.render();
  }

  // --- Rendering ---------------------------------------------------------

  render(): void {
    const root = document.getElementById('factory-overlay');
    if (!root) return;
    const show = this.enabled && !this.suppressed && this.summary !== null;
    root.classList.toggle('hidden', !show);
    if (!show || !this.summary) return;
    root.classList.toggle('open', this.open);
    const units = overlayUnits(this.summary.units, Date.now());
    this.renderCounts();
    if (this.open) this.renderList(units);
  }

  private renderCounts(): void {
    const el = document.getElementById('factory-overlay-counts');
    if (!el || !this.summary) return;
    const c = this.summary.counts;
    const parts: SafeHtml[] = [];
    if (c.running) parts.push(html`<span class="jo-count running" title="Intake, ready and running"><span class="jo-pulse"></span>${c.running}</span>`);
    if (c.reviewing) parts.push(html`<span class="jo-count review" title="The reviewer agent is checking these">${c.reviewing} review</span>`);
    if (c.needsYou) parts.push(html`<span class="jo-count waiting">${c.needsYou} needs you</span>`);
    if (c.merging) parts.push(html`<span class="jo-count merging">${c.merging} merging</span>`);
    if (c.done) parts.push(html`<span class="jo-count done" title="Done today">${c.done}</span>`);
    if (parts.length === 0) parts.push(html`<span class="jo-count idle">idle</span>`);
    setHtml(el, joinHtml(parts));
  }

  /** Replace the cards, keeping the scroll position and the focused card. */
  private renderList(units: FactoryUnitSummary[]): void {
    const el = document.getElementById('factory-overlay-list');
    if (!el || !this.summary) return;
    const scrollTop = el.scrollTop;
    const focused = document.activeElement as HTMLElement | null;
    const focusedKey = el.contains(focused) ? focused?.dataset.unitKey : undefined;

    const cards = units.length > 0 ? units.map((u) => this.renderCard(u)) : [html`<div class="fo-empty">Nothing in the factory. Add work, or send a track from a session.</div>`];
    setHtml(el, joinHtml(cards));
    const foot = document.getElementById('factory-overlay-foot');
    if (foot) {
      const paused = this.summary.dispatch.paused;
      setHtml(
        foot,
        html`<span class="fo-fuel">${paused ? `paused: ${paused}` : `today ${formatTokens(this.summary.tokensToday)} tokens`}</span>
          <button type="button" class="fo-link" data-fo-add>Add work</button>
          <button type="button" class="fo-link" data-fo-board>Open board →</button>`
      );
    }

    el.scrollTop = scrollTop;
    if (focusedKey) [...el.querySelectorAll<HTMLElement>('[data-unit-key]')].find((n) => n.dataset.unitKey === focusedKey)?.focus({ preventScroll: true });
  }

  private renderCard(unit: FactoryUnitSummary): SafeHtml {
    return html`
      <button type="button" class="jo-card fo-card ${cardKind(unit)}${unit.stalled ? ' stalled' : ''}" data-unit-key="${unit.key}"
              title="Open ${unit.title} on the board">
        <span class="jo-card-top">
          <span class="jo-project">${unit.projectName}</span>
          <span class="fo-id">${unit.isTrack ? 'track' : unit.unitId}</span>
        </span>
        <span class="jo-title">${unit.title}</span>
        <span class="fo-meta">${progressStrip(unit)}<span>${cardStatus(unit)}</span></span>
      </button>`;
  }

  // --- Escalation ----------------------------------------------------------

  private announce(units: FactoryUnitSummary[]): void {
    const bar = document.getElementById('factory-overlay-bar');
    if (bar) {
      bar.classList.remove('flash');
      void bar.offsetWidth; // restart the animation
      bar.classList.add('flash');
    }
    const toast = document.getElementById('factory-toast');
    if (!toast) return;
    const first = units[0];
    const more = units.length > 1 ? ` (and ${units.length - 1} more)` : '';
    setHtml(
      toast,
      html`<span><b>Factory</b> · ${first.title} needs you${first.reason ? html`: ${first.reason.replace(/^review: /, '')}` : ''}${more}</span>
        <button type="button" class="btn-primary fo-toast-btn" data-unit-key="${first.key}">Review</button>
        <button type="button" class="fo-toast-x" data-fo-dismiss aria-label="Dismiss">×</button>`
    );
    toast.classList.remove('hidden');
    if (this.toastTimer !== null) window.clearTimeout(this.toastTimer);
    this.toastTimer = window.setTimeout(() => this.hideToast(), TOAST_MS);
  }

  private hideToast(): void {
    document.getElementById('factory-toast')?.classList.add('hidden');
    if (this.toastTimer !== null) window.clearTimeout(this.toastTimer);
    this.toastTimer = null;
  }
}
