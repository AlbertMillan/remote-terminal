import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  DecisionQueue,
  asAnswered,
  asApproved,
  asSentBack,
  asTriaged,
  type Decision,
  type DecisionResult,
} from '../src/client/factory-decisions.js';
import { FakeClock } from './helpers/fake-clock.js';
import type { FactoryBoardUnit } from '../src/shared/protocol.js';

/**
 * The board's deferred-send queue (project/factory-page-redesign.md, "Undo is a
 * deferred send, client-side"): applied at once, sent when the Undo window
 * closes, dropped by Undo, flushed on leave and before a second decision on the
 * same unit, and shown until a fetch started after it landed. A fake clock.
 */

function unit(key: string, over: Partial<FactoryBoardUnit> = {}): FactoryBoardUnit {
  return {
    key,
    projectCwd: 'C:\\p',
    projectName: 'p',
    unitId: key,
    isTrack: false,
    trackName: 'Inbox',
    title: key,
    featureIds: [key],
    column: 'review',
    status: 'parked',
    step: 'review',
    needsYou: true,
    reviewer: 'you',
    escalated: true,
    triage: false,
    reason: 'review: escalated',
    features: [],
    waitsFor: [],
    mergeId: null,
    mergeStatus: null,
    tokens: 0,
    modelTier: null,
    stalled: null,
    heartbeatAt: null,
    updatedAt: '2026-11-28T10:00:00.000Z',
    claim: null,
    detail: { parkReason: null, verdict: null, questions: [], hasSummary: false, worktreePath: null, branch: null, baseBranch: null, lastCommit: null },
    ...over,
  };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

let clock: FakeClock;
let sent: { key: string; keepalive: boolean }[];
let results: DecisionResult[];
let answered: { label: string; ok: boolean }[];
let changes: number;
let queue: DecisionQueue;

function decision(key: string, over: Partial<Decision> = {}): Decision {
  return {
    unitKey: key,
    label: `approve ${key}`,
    apply: asApproved,
    send: async (keepalive) => {
      sent.push({ key, keepalive });
      return results.shift() ?? { ok: true, status: 200, data: {} };
    },
    ...over,
  };
}

beforeEach(() => {
  clock = new FakeClock();
  sent = [];
  results = [];
  answered = [];
  changes = 0;
  queue = new DecisionQueue(
    {
      onChange: () => changes++,
      onSent: (d, r) => answered.push({ label: d.label, ok: r.ok }),
    },
    5000,
    clock
  );
});

describe('the deferred send', () => {
  it('applies at once and sends only when the Undo window closes', async () => {
    const units = [unit('a'), unit('b')];
    queue.add(decision('a'));
    expect(changes).toBe(1);
    expect(queue.overlay(units).map((u) => [u.key, u.column, u.needsYou])).toEqual([
      ['a', 'merging', false],
      ['b', 'review', true],
    ]);
    expect(queue.pending().map((p) => [p.decision.unitKey, p.expiresAt])).toEqual([['a', 5000]]);
    clock.advance(4999);
    expect(sent).toEqual([]);
    clock.advance(1);
    await flush();
    expect(sent).toEqual([{ key: 'a', keepalive: false }]);
    expect(answered).toEqual([{ label: 'approve a', ok: true }]);
    expect(queue.pending()).toEqual([]);
  });

  it('Undo drops it: nothing is sent and the unit shows as it was', async () => {
    const id = queue.add(decision('a'));
    expect(queue.undo(id)).toBe(true);
    expect(queue.overlay([unit('a')])[0].column).toBe('review');
    clock.advance(10_000);
    await flush();
    expect(sent).toEqual([]);
    expect(queue.undo(id)).toBe(false);
  });

  it('cannot undo once sent', async () => {
    const id = queue.add(decision('a'));
    clock.advance(5000);
    await flush();
    expect(queue.undo(id)).toBe(false);
  });

  it('flush sends every waiting decision now, with keepalive when the page goes away, and only once', async () => {
    queue.add(decision('a'));
    queue.add(decision('b'));
    await queue.flush(true);
    expect(sent).toEqual([
      { key: 'a', keepalive: true },
      { key: 'b', keepalive: true },
    ]);
    clock.advance(5000);
    await queue.flush();
    await flush();
    expect(sent).toHaveLength(2);
  });

  it('a second decision on the same unit sends the first now, in order; another unit waits', async () => {
    queue.add(decision('a', { label: 'first' }));
    queue.add(decision('b'));
    queue.add(decision('a', { label: 'second', apply: asSentBack }));
    await flush();
    expect(sent).toEqual([{ key: 'a', keepalive: false }]);
    expect(queue.pending().map((p) => p.decision.label)).toEqual(['approve b', 'second']);
    clock.advance(5000);
    await flush();
    expect(sent.map((s) => s.key)).toEqual(['a', 'b', 'a']);
  });

  it('keeps a landed decision applied until a fetch started after it landed answers', async () => {
    const before = queue.mark();
    queue.add(decision('a'));
    clock.advance(5000);
    await flush();
    // A fetch that started before the send landed: the server's answer may predate it.
    queue.settle(before);
    expect(queue.overlay([unit('a')])[0].column).toBe('merging');
    const after = queue.mark();
    queue.settle(after);
    // Settled: the board's own data shows it now; the queue no longer rewrites it.
    expect(queue.overlay([unit('a')])[0].column).toBe('review');
  });

  it('keeps a waiting or sending decision applied across any fetch', async () => {
    let release!: (r: DecisionResult) => void;
    queue.add(decision('a', { send: () => new Promise((r) => (release = r)) }));
    queue.settle(queue.mark());
    expect(queue.overlay([unit('a')])[0].column).toBe('merging');
    clock.advance(5000);
    queue.settle(queue.mark());
    expect(queue.overlay([unit('a')])[0].column).toBe('merging');
    release({ ok: true, status: 200, data: {} });
    await flush();
    expect(queue.overlay([unit('a')])[0].column).toBe('merging');
  });

  it('drops a refused decision and reports it', async () => {
    results.push({ ok: false, status: 409, data: { error: 'a is not parked' } });
    queue.add(decision('a'));
    clock.advance(5000);
    await flush();
    expect(answered).toEqual([{ label: 'approve a', ok: false }]);
    expect(queue.overlay([unit('a')])[0].column).toBe('review');
  });

  it('treats a send that throws as refused', async () => {
    queue.add(decision('a', { send: () => Promise.reject(new Error('offline')) }));
    await queue.flush();
    expect(answered).toEqual([{ label: 'approve a', ok: false }]);
  });

  it('takes a unit off the board when the decision says so', () => {
    queue.add(decision('a', { apply: (u) => asTriaged(u, 'dismiss') }));
    expect(queue.overlay([unit('a'), unit('b')]).map((u) => u.key)).toEqual(['b']);
  });

  it('hands the timer to the real clock by default', () => {
    vi.useFakeTimers();
    try {
      const q = new DecisionQueue({ onChange: () => {}, onSent: () => {} });
      q.add(decision('a'));
      vi.advanceTimersByTime(5000);
      expect(sent).toEqual([{ key: 'a', keepalive: false }]);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('how each decision redraws its unit', () => {
  it('Approve moves a review to Merging; Build it moves a mockup to Running', () => {
    expect(asApproved(unit('a'))).toMatchObject({ column: 'merging', needsYou: false, reviewer: null, mergeStatus: 'queued' });
    const mockup = unit('m', { column: 'intake', step: 'mockup', reviewer: null, escalated: false });
    expect(asApproved(mockup)).toMatchObject({ column: 'running', step: 'implement', status: 'open', needsYou: false });
  });

  it('Send back moves it to Running for the fix step', () => {
    expect(asSentBack(unit('a'))).toMatchObject({ column: 'running', step: 'fix', needsYou: false, reviewer: null });
  });

  it('Answer leaves it shaping in Intake, its questions answered', () => {
    const asked = unit('q', { column: 'intake', step: 'shape', detail: { ...unit('q').detail, questions: [{ id: 'x', question: '?', options: [], default: null }] } });
    expect(asAnswered(asked)).toMatchObject({ column: 'intake', needsYou: false, detail: { questions: [] } });
  });

  it('triage Accept moves it into Intake; Backlog and Dismiss take it off the board', () => {
    const t = unit('t', { column: 'intake', triage: true, step: 'triage' });
    expect(asTriaged(t, 'accept')).toMatchObject({ column: 'intake', triage: false, needsYou: false });
    expect(asTriaged(t, 'backlog')).toBeNull();
    expect(asTriaged(t, 'dismiss')).toBeNull();
  });
});
