import type { FactoryBoardUnit } from '../shared/protocol.js';

/**
 * Undo on the board's decisions (project/factory-page-redesign.md, "Undo is a
 * deferred send, client-side"). Approve, Answer, Build it, Send back and triage
 * apply to the page at once — `apply` redraws the unit as it will be, or drops
 * it — and their POST goes out only when the Undo toast expires (5 s). Undo
 * drops the decision before anything reached the server.
 *
 * Why client-side, not a server-side reverse: a release starts runs (the fix
 * step, a merge) that can't be taken back cleanly. The cost is a 5 s delay
 * before the factory acts.
 *
 * - A pending decision is sent at once by `flush()`: the board calls it on
 *   `hide()` and `pagehide` (with `keepalive`, so the request outlives the page),
 *   and `add()` flushes one already pending for the same unit first.
 * - The page keeps showing a decision while it is pending, while it is sent and
 *   after it landed, until a board fetch **started after** it landed: a pushed
 *   `factory.summary` reload that raced the send would otherwise bring the old
 *   state back for a moment (`mark()` at fetch start, `settle()` once it answers).
 * - A refused send is dropped (the unit shows as the server has it) and reported.
 */

export const UNDO_MS = 5000;

export interface DecisionResult {
  ok: boolean;
  status: number;
  data: { error?: string };
}

export interface Decision {
  /** The unit it decides; a second decision on it flushes this one first. */
  unitKey: string;
  /** The toast's text: what happened and where the unit went. */
  label: string;
  /** The unit as the page shows it meanwhile; null takes it off the board. */
  apply(u: FactoryBoardUnit): FactoryBoardUnit | null;
  /** The POST; `keepalive` when the page is going away. */
  send(keepalive: boolean): Promise<DecisionResult>;
  /** After the server took it (an Undo keeps the drafts it used: clear them only here). */
  onLanded?(): void;
}

export interface PendingDecision {
  id: number;
  decision: Decision;
  expiresAt: number;
}

export interface DecisionQueueHost {
  /** The optimistic view changed: a decision was added, undone, sent, refused or settled. */
  onChange(): void;
  /** A send was answered. */
  onSent(decision: Decision, result: DecisionResult): void;
}

/** The timer calls, injectable so the tests control time. */
export interface DecisionClock {
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

const realClock: DecisionClock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

interface Entry {
  id: number;
  decision: Decision;
  state: 'pending' | 'sending' | 'landed';
  expiresAt: number;
  timer: unknown;
  /** `seq` when it landed; a fetch whose mark is at least this one shows it. */
  landedSeq: number;
  sending: Promise<void> | null;
}

export class DecisionQueue {
  private entries: Entry[] = [];
  private nextId = 1;
  private seq = 0;

  constructor(
    private readonly host: DecisionQueueHost,
    private readonly delayMs = UNDO_MS,
    private readonly clock: DecisionClock = realClock
  ) {}

  /** Apply a decision now and send it once its Undo window closes. */
  add(decision: Decision): number {
    // A second decision on the same unit: the first goes out now, in order.
    for (const e of this.entries) if (e.state === 'pending' && e.decision.unitKey === decision.unitKey) void this.send(e, false);
    const id = this.nextId++;
    const entry: Entry = {
      id,
      decision,
      state: 'pending',
      expiresAt: this.clock.now() + this.delayMs,
      timer: null,
      landedSeq: 0,
      sending: null,
    };
    entry.timer = this.clock.setTimeout(() => void this.send(entry, false), this.delayMs);
    this.entries.push(entry);
    this.host.onChange();
    return id;
  }

  /** Drop a decision still waiting; false once it has been sent. */
  undo(id: number): boolean {
    const entry = this.entries.find((e) => e.id === id);
    if (!entry || entry.state !== 'pending') return false;
    this.clock.clearTimeout(entry.timer);
    this.entries = this.entries.filter((e) => e !== entry);
    this.host.onChange();
    return true;
  }

  /** Send every waiting decision now (leaving the board, or the page). */
  flush(keepalive = false): Promise<void> {
    const sends = this.entries.filter((e) => e.state === 'pending').map((e) => this.send(e, keepalive));
    return Promise.all(sends).then(() => undefined);
  }

  /** The decisions whose toast still offers Undo, oldest first. */
  pending(): PendingDecision[] {
    return this.entries.filter((e) => e.state === 'pending').map((e) => ({ id: e.id, decision: e.decision, expiresAt: e.expiresAt }));
  }

  /** Taken when a board fetch starts; `settle()` it with the fetch's answer. */
  mark(): number {
    return this.seq;
  }

  /** A fetch started at `mark` answered: decisions that had landed by then show in it. */
  settle(mark: number): void {
    const before = this.entries.length;
    this.entries = this.entries.filter((e) => !(e.state === 'landed' && e.landedSeq <= mark));
    if (this.entries.length !== before) this.host.onChange();
  }

  /** The units as the page shows them: every decision not yet reflected by a fetch applied, in order. */
  overlay(units: FactoryBoardUnit[]): FactoryBoardUnit[] {
    if (this.entries.length === 0) return units;
    let out = units;
    for (const e of this.entries) {
      out = out.flatMap((u) => {
        if (u.key !== e.decision.unitKey) return [u];
        const next = e.decision.apply(u);
        return next ? [next] : [];
      });
    }
    return out;
  }

  private send(entry: Entry, keepalive: boolean): Promise<void> {
    if (entry.sending) return entry.sending;
    this.clock.clearTimeout(entry.timer);
    entry.state = 'sending';
    entry.sending = (async () => {
      let result: DecisionResult;
      try {
        result = await entry.decision.send(keepalive);
      } catch {
        result = { ok: false, status: 0, data: { error: `${entry.decision.label}: could not reach the server` } };
      }
      if (result.ok) {
        entry.state = 'landed';
        entry.landedSeq = ++this.seq;
      } else {
        this.entries = this.entries.filter((e) => e !== entry);
      }
      this.host.onSent(entry.decision, result);
      this.host.onChange();
    })();
    this.host.onChange();
    return entry.sending;
  }
}

// --- How each decision redraws its unit ---------------------------------------

/** Approved (a review or a mockup's park lifted): what the page shows until the board says. */
export function asApproved(u: FactoryBoardUnit): FactoryBoardUnit {
  // A review approved goes to the merge queue; a mockup approved goes on to implement.
  if (u.column === 'review') {
    return { ...u, column: 'merging', status: 'open', needsYou: false, reviewer: null, escalated: false, mergeStatus: 'queued', reason: null };
  }
  return { ...u, column: 'running', status: 'open', step: 'implement', needsYou: false, reason: null };
}

/** Sent back with your changes: the fix step runs. */
export function asSentBack(u: FactoryBoardUnit): FactoryBoardUnit {
  return { ...u, column: 'running', status: 'open', step: 'fix', needsYou: false, reviewer: null, escalated: false, reason: null };
}

/** Answered: shaping goes on. */
export function asAnswered(u: FactoryBoardUnit): FactoryBoardUnit {
  return { ...u, column: 'intake', status: 'open', step: 'shape', needsYou: false, reason: null, detail: { ...u.detail, questions: [] } };
}

/** Triage: accepted into intake for shaping; backlog and dismiss take it off the board. */
export function asTriaged(u: FactoryBoardUnit, action: 'accept' | 'backlog' | 'dismiss'): FactoryBoardUnit | null {
  if (action !== 'accept') return null;
  return { ...u, column: 'intake', status: 'open', step: null, triage: false, needsYou: false, reason: null };
}
