import { describe, it, expect } from 'vitest';
import {
  emptyProgress,
  ITEM_TEMPLATE,
  nextStep,
  parseProgress,
  recordOutcome,
  TemplateError,
  TRACK_TEMPLATE,
  validateTemplate,
  type Progress,
  type WorkflowTemplate,
} from '../src/server/factory/templates.js';
import { parseVerdict } from '../src/server/factory/steps.js';
import { DEFAULT_FACTORY_LIMITS, planCapReason } from '../src/server/factory/limits.js';

/**
 * Workflow templates (project/code-factory.md, f-uwj3b0): the step walk is
 * pure, so loops, caps and skips are tested by feeding outcomes directly.
 */

/** Walk a template, answering each step from `answer`, until it parks or finishes. */
function walk(t: WorkflowTemplate, answer: (step: string, n: number) => string, progress: Progress = emptyProgress()) {
  const ran: string[] = [];
  for (let guard = 0; guard < 50; guard++) {
    const next = nextStep(t, progress);
    if (next.kind === 'finished') return { ran, end: 'finished' as const, progress };
    if (next.kind === 'park') return { ran, end: 'park' as const, at: next.step.id, reason: next.reason, progress };
    ran.push(next.step.id);
    recordOutcome(t, progress, next.step.id, answer(next.step.id, ran.filter((s) => s === next.step.id).length));
  }
  throw new Error('walk did not end');
}

const happy = (step: string) => (step === 'verify' || step === 'self-review' ? 'pass' : 'done');

describe('item template', () => {
  it('runs every step in order and skips fix when nothing failed', () => {
    const r = walk(ITEM_TEMPLATE, happy);
    expect(r.end).toBe('finished');
    expect(r.ran).toEqual(['shape', 'implement', 'verify', 'self-review', 'summary', 'review', 'merge']);
    expect(r.progress.skipped).toEqual(['fix', 'review-fix']);
  });

  it("loops review-fix → verify → … → review while the reviewer asks for changes, up to the cap", () => {
    const answer = (step: string, n: number) =>
      step === 'review' ? (n < 3 ? 'changes' : 'approved') : step === 'verify' || step === 'self-review' ? 'pass' : 'done';
    const r = walk(ITEM_TEMPLATE, answer);
    expect(r.end).toBe('finished');
    expect(r.ran.filter((s) => s === 'review-fix')).toHaveLength(2);
    expect(r.ran.slice(-2)).toEqual(['review', 'merge']);

    const stuck = walk(ITEM_TEMPLATE, (step) => (step === 'review' ? 'changes' : happy(step)));
    expect(stuck).toMatchObject({ end: 'park', at: 'review-fix' });
    expect(stuck.ran.filter((s) => s === 'review-fix')).toHaveLength(2);
  });

  it('loops fix → verify → self-review until the checks pass', () => {
    const r = walk(ITEM_TEMPLATE, (step, n) => {
      if (step === 'verify') return n === 1 ? 'fail' : 'pass';
      if (step === 'self-review') return 'pass';
      return 'done';
    });
    expect(r.end).toBe('finished');
    expect(r.ran).toEqual([
      'shape', 'implement', 'verify', 'self-review', 'fix',
      'verify', 'self-review', 'summary', 'review', 'merge',
    ]);
    expect(r.progress.loops.fix).toBe(1);
  });

  it('runs fix after a self-review that asks for changes', () => {
    const r = walk(ITEM_TEMPLATE, (step, n) => {
      if (step === 'verify') return 'pass';
      if (step === 'self-review') return n === 1 ? 'changes' : 'pass';
      return 'done';
    });
    expect(r.ran.filter((s) => s === 'fix')).toHaveLength(1);
    expect(r.end).toBe('finished');
  });

  it('caps the fix loop at 2 runs, then parks at fix instead of a third', () => {
    const r = walk(ITEM_TEMPLATE, (step) => (step === 'self-review' ? 'changes' : step === 'verify' ? 'pass' : 'done'));
    expect(r.end).toBe('park');
    expect(r.at).toBe('fix');
    expect(r.reason).toMatch(/fix ran 2 times/);
    expect(r.ran.filter((s) => s === 'fix')).toHaveLength(2);
    // Every fix is re-checked: verify ran after each of them.
    expect(r.ran.filter((s) => s === 'verify')).toHaveLength(3);
  });

  it('leaves out the steps a unit skips, and the steps after still run', () => {
    const r = walk(ITEM_TEMPLATE, happy, emptyProgress(['shape', 'self-review']));
    expect(r.ran).toEqual(['implement', 'verify', 'summary', 'review', 'merge']);
    expect(r.progress.skipped).toEqual(expect.arrayContaining(['shape', 'self-review', 'fix']));
  });

  it('resumes from recorded progress without re-running finished steps', () => {
    const progress = emptyProgress();
    for (const s of ['shape', 'implement']) recordOutcome(ITEM_TEMPLATE, progress, s, 'done');
    const restored = parseProgress(JSON.stringify(progress));
    const next = nextStep(ITEM_TEMPLATE, restored);
    expect(next.kind === 'run' && next.step.id).toBe('verify');
  });
});

describe('track template', () => {
  it('has no shaping step: the features run first', () => {
    const r = walk(TRACK_TEMPLATE, happy);
    expect(r.ran).toEqual(['features', 'verify', 'self-review', 'summary', 'review', 'merge']);
    expect(r.progress.skipped).toEqual(expect.arrayContaining(['review-fix', 'next-feature']));
  });

  it('reviewed per feature, walks features → … → review once per feature, then merges once', () => {
    // Three features: the features step reports `more` until the last one.
    const answer = (step: string, n: number) =>
      step === 'features' ? (n < 3 ? 'more' : 'done') : step === 'review' ? 'approved' : happy(step);
    const r = walk(TRACK_TEMPLATE, answer);
    expect(r.end).toBe('finished');
    const round = ['features', 'verify', 'self-review', 'summary', 'review'];
    expect(r.ran).toEqual([...round, 'next-feature', ...round, 'next-feature', ...round, 'merge']);
  });
});

describe('validateTemplate', () => {
  it('refuses a need, condition or loop that is not an earlier step', () => {
    expect(() => validateTemplate({ name: 'x', steps: [{ id: 'a', handler: 'a', needs: ['b'] }] })).toThrow(TemplateError);
    expect(() =>
      validateTemplate({ name: 'x', steps: [{ id: 'a', handler: 'a', needs: [], when: [{ step: 'z', outcome: 'y' }] }] })
    ).toThrow(TemplateError);
    expect(() =>
      validateTemplate({ name: 'x', steps: [{ id: 'a', handler: 'a', needs: [], loop: { back: 'b', max: 1 } }] })
    ).toThrow(TemplateError);
    expect(() =>
      validateTemplate({
        name: 'x',
        steps: [
          { id: 'a', handler: 'a', needs: [] },
          { id: 'a', handler: 'a', needs: [] },
        ],
      })
    ).toThrow(/duplicate/);
  });
});

describe('parseProgress', () => {
  it('tolerates garbage and missing fields', () => {
    expect(parseProgress('not json')).toEqual(emptyProgress());
    expect(parseProgress('{"outcomes":{"a":"done"}}').outcomes).toEqual({ a: 'done' });
    expect(parseProgress(null).tokenBase).toBe(0);
  });
});

describe('parseVerdict', () => {
  it('takes the last verdict object in the reply', () => {
    const text = 'I looked.\n{"verdict": "pass", "findings": []}\nOn reflection:\n{"verdict": "changes", "findings": ["no test for x"]}';
    expect(parseVerdict(text)).toEqual({ verdict: 'changes', findings: ['no test for x'] });
  });
  it('returns null when there is none', () => {
    expect(parseVerdict('looks fine to me')).toBeNull();
    expect(parseVerdict('{"verdict": "maybe"}')).toBeNull();
  });
});

describe('planCapReason', () => {
  const now = Date.parse('2026-11-26T10:00:00Z');
  const future = now / 1000 + 3600;
  const w = (pct: number, resetsAt = future) => ({ usedPercentage: pct, resetsAt, observedAt: '', loginUuid: 'u' });

  it('stops new work at 80% of the 5-hour window or 90% of the week', () => {
    expect(planCapReason({ fiveHour: w(80), sevenDay: w(10) }, DEFAULT_FACTORY_LIMITS, now)).toMatch(/5-hour/);
    expect(planCapReason({ fiveHour: w(50), sevenDay: w(90) }, DEFAULT_FACTORY_LIMITS, now)).toMatch(/weekly/);
    expect(planCapReason({ fiveHour: w(79), sevenDay: w(89) }, DEFAULT_FACTORY_LIMITS, now)).toBeNull();
  });

  it('ignores a window that has already reset, and no reading at all', () => {
    expect(planCapReason({ fiveHour: w(99, now / 1000 - 1), sevenDay: null }, DEFAULT_FACTORY_LIMITS, now)).toBeNull();
    expect(planCapReason(null, DEFAULT_FACTORY_LIMITS, now)).toBeNull();
  });
});
