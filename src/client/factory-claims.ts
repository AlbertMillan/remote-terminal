import { html, type SafeHtml } from './html-utils.js';
import { failureMessage, requestJson } from './api.js';
import type { FactorySummary, FactoryUnitSummary } from '../shared/protocol.js';

/**
 * Sessions holding factory units, on the client (project/code-factory.md,
 * "Sessions and the factory share one model of work (phase 2)"; server
 * factory/takeover.ts):
 *
 * - the board drawer's claim actions: Take over in terminal on a running,
 *   parked or ready unit; Open terminal, Return to factory and Done on one a
 *   session holds ("session · you", or "paused · claimed by you" while its
 *   terminal is closed);
 * - the session header's "Return to factory" button, shown only while the
 *   attached session holds a unit;
 * - the sidebar's claim badge on that session's row.
 *
 * All three read the pushed `factory.summary` (`unit.claim`), so they follow
 * every claim change without polling. The drawer part is hooked into
 * factory-board.ts with two calls; the rest of the board is untouched.
 */

/** What the sidebar badge and the header read: the unit a session holds. */
export interface HeldUnit {
  unit: FactoryUnitSummary;
  /** The badge text: a loose item's id, or `track`. */
  label: string;
}

/** Units held by sessions, by session id. */
export function heldBySession(units: FactoryUnitSummary[]): Map<string, HeldUnit> {
  const out = new Map<string, HeldUnit>();
  for (const unit of units) {
    if (!unit.claim || unit.column === 'done') continue;
    out.set(unit.claim.sessionId, { unit, label: unit.isTrack ? 'track' : unit.unitId });
  }
  return out;
}

/** The card line for a unit a session holds, or null for any other. */
export function claimStatus(unit: FactoryUnitSummary): string | null {
  if (!unit.claim) return null;
  return unit.claim.live ? 'session · you' : 'paused · claimed by you';
}

/**
 * Whether the drawer offers Take over: a unit that has run (it has a worktree
 * to open a terminal in, or is a track) and is running, parked or ready —
 * never one in triage, the merge queue, or already held.
 */
export function canTakeOver(unit: FactoryUnitSummary & { detail?: { worktreePath: string | null } }): boolean {
  if (unit.claim || unit.triage) return false;
  if (unit.column === 'merging' || unit.column === 'done' || unit.column === 'intake') return false;
  return unit.isTrack || !!unit.detail?.worktreePath;
}

// ---------------------------------------------------------------------------
// The drawer

/** Drawer actions this module answers (`data-fb` values). */
const ACTIONS = new Set(['take-over', 'claim-open', 'claim-return', 'claim-done']);

export function isClaimAction(kind: string | undefined): boolean {
  return !!kind && ACTIONS.has(kind);
}

/** The claim block of a unit's drawer, above its Live section. */
export function renderClaimActions(
  unit: FactoryUnitSummary & { detail?: { worktreePath: string | null } },
  busy: boolean,
  sessionExists: (id: string) => boolean
): SafeHtml {
  const disabled = busy ? 'disabled' : '';
  if (unit.claim) {
    const c = unit.claim;
    const who = c.sessionName ? `“${c.sessionName}”` : 'a session that is gone';
    return html`<div class="fb-verdict fb-claim"><span class="fb-chip c">${claimStatus(unit)}</span>
        ${c.live
          ? html`Held by your terminal ${who}. The factory skips it until you return it.`
          : html`Your terminal ${who} is closed. It stays claimed by you, never handed back on its own.`}</div>
      <div class="fb-acts">
        ${sessionExists(c.sessionId) && html`<button type="button" class="btn-secondary" data-fb="claim-open">${c.live ? 'Open terminal' : 'Open terminal (revive)'}</button>`}
        <button type="button" class="btn-secondary" data-fb="claim-return" ${disabled}>Return to factory</button>
        <button type="button" class="btn-primary" data-fb="claim-done" ${disabled} title="Its work goes through the summary, the reviewer and the merge queue">Done</button>
      </div>`;
  }
  if (!canTakeOver(unit)) return html``;
  return html`<div class="fb-acts">
      <button type="button" class="btn-primary" data-fb="take-over" ${disabled} title="Stop the factory's agent and continue its conversation in a terminal in the unit's worktree">Take over in terminal</button>
    </div>`;
}

export interface ClaimActionContext {
  unit: FactoryUnitSummary;
  /** The board's busy/notice/reload wrapper. */
  act(label: string, call: () => Promise<{ ok: boolean; status: number; data: { error?: string } }>, done?: () => void): Promise<void>;
  post(url: string, body?: object): Promise<{ ok: boolean; status: number; data: { error?: string } }>;
  /** Leave the board for a session's terminal (attaching revives a parked one). */
  openSession(sessionId: string): void;
}

/** Run a drawer claim action. */
export async function runClaimAction(kind: string, ctx: ClaimActionContext): Promise<void> {
  const { unit } = ctx;
  const featureId = unit.featureIds[0];
  if (!featureId) return;
  const url = (verb: string) => `/api/factory/items/${encodeURIComponent(featureId)}/${verb}`;
  switch (kind) {
    case 'take-over': {
      let opened: string | null = null;
      await ctx.act(
        'Taken over: its terminal is open',
        async () => {
          const res = await ctx.post(url('take'), { cwd: unit.projectCwd });
          if (res.ok) opened = (res.data as { sessionId?: string }).sessionId ?? null;
          return res;
        },
        () => {
          if (opened) ctx.openSession(opened);
        }
      );
      return;
    }
    case 'claim-open':
      if (unit.claim) ctx.openSession(unit.claim.sessionId);
      return;
    case 'claim-return':
      return ctx.act('Returned: the factory resumes it from its last commit', () => ctx.post(url('return'), { cwd: unit.projectCwd }));
    case 'claim-done':
      return ctx.act('Done: it goes to the summary, the reviewer and the merge queue', () => ctx.post(url('done'), { cwd: unit.projectCwd }));
  }
}

// ---------------------------------------------------------------------------
// Session header and sidebar

/**
 * The client's view of which session holds what, fed by every `factory.summary`.
 * `onChange` fires only when that changes, so the sidebar re-renders rarely.
 */
export class FactoryClaims {
  private held = new Map<string, HeldUnit>();
  private signature = '';
  private busy = false;

  constructor(
    private readonly host: {
      onChange(): void;
      currentSessionId(): string | null;
      showError(message: string): void;
    }
  ) {}

  update(summary: FactorySummary): void {
    this.held = heldBySession(summary.units);
    const signature = [...this.held].map(([id, h]) => `${id}:${h.unit.key}:${h.unit.claim?.live}`).join('|');
    if (signature !== this.signature) {
      this.signature = signature;
      this.host.onChange();
    }
    this.syncHeader();
  }

  /** The sidebar badge's text for a session, or null. */
  badgeFor(sessionId: string): HeldUnit | null {
    return this.held.get(sessionId) ?? null;
  }

  /** Show the header's "Return to factory" only while the attached session holds a unit. */
  syncHeader(): void {
    const btn = document.getElementById('return-factory-btn');
    if (!btn) return;
    const id = this.host.currentSessionId();
    const held = id ? this.held.get(id) : undefined;
    btn.classList.toggle('hidden', !held);
    if (held) btn.title = `Give ${held.unit.title} back to the factory: it resumes from your last commit`;
  }

  /** Wire the header button once. */
  attach(): void {
    document.getElementById('return-factory-btn')?.addEventListener('click', () => void this.returnCurrent());
  }

  private async returnCurrent(): Promise<void> {
    const id = this.host.currentSessionId();
    const held = id ? this.held.get(id) : undefined;
    if (!held || this.busy) return;
    this.busy = true;
    try {
      const featureId = held.unit.featureIds[0];
      const res = await requestJson(`/api/factory/items/${encodeURIComponent(featureId)}/return`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cwd: held.unit.projectCwd }),
      });
      if (!res.ok) this.host.showError(failureMessage(res, 'Return to factory failed'));
    } finally {
      this.busy = false;
    }
  }
}
