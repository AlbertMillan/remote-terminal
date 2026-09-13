import { describe, it, expect } from 'vitest';
import {
  GATE_AFTER,
  GATE_BEFORE,
  STAGE_ORDER,
  nextStage,
  type GateName,
  type StageName,
} from '../src/server/jobs/types.js';
import { extractBlocked, BLOCKED_MARKER } from '../src/server/jobs/stages/implement.js';

/**
 * The gate state machine, modelled exactly as the runner drives it.
 *
 * This exists because of a real bug: parking BEFORE a gated stage originally
 * advanced `stage` to the upcoming stage, so approving it made nextStage()
 * skip straight past merge to rebuild. The fix keeps `stage` on the last
 * COMPLETED stage while parked and records approval separately.
 */
interface JobState {
  stage: StageName | null;
  gate: GateName | null;
  approvedGate: GateName | null;
  parked: boolean;
}

function step(state: JobState): { state: JobState; ran: StageName | null } {
  const upcoming = nextStage(state.stage);
  if (!upcoming) return { state: { ...state, parked: false }, ran: null };

  const gateBefore = GATE_BEFORE[upcoming];
  if (gateBefore && state.approvedGate !== gateBefore) {
    // Park without advancing `stage`.
    return { state: { ...state, gate: gateBefore, parked: true }, ran: null };
  }

  const gateAfter = GATE_AFTER[upcoming];
  return {
    state: {
      stage: upcoming,
      gate: gateAfter ?? null,
      approvedGate: state.approvedGate,
      parked: !!gateAfter,
    },
    ran: upcoming,
  };
}

function approve(state: JobState): JobState {
  return { ...state, approvedGate: state.gate, gate: null, parked: false };
}

const initial: JobState = { stage: null, gate: null, approvedGate: null, parked: false };

describe('gate state machine', () => {
  it('parks after design', () => {
    const { state, ran } = step(initial);
    expect(ran).toBe('design');
    expect(state.parked).toBe(true);
    expect(state.gate).toBe('design');
  });

  it('runs implement and integrate without stopping once design is approved', () => {
    let s = approve(step(initial).state);
    const ranOrder: (StageName | null)[] = [];
    for (let i = 0; i < 2; i++) {
      const out = step(s);
      ranOrder.push(out.ran);
      s = out.state;
    }
    expect(ranOrder).toEqual(['implement', 'integrate']);
    expect(s.parked).toBe(false);
  });

  it('parks BEFORE merge without consuming the merge stage', () => {
    // Walk to just before merge, approving each gate on the way.
    let s = initial;
    for (let i = 0; i < 12; i++) {
      const out = step(s);
      s = out.state;
      if (s.parked && s.gate !== 'merge') s = approve(s);
      if (s.parked && s.gate === 'merge') break;
    }
    expect(s.parked).toBe(true);
    expect(s.gate).toBe('merge');
    // The critical assertion: merge has NOT been consumed, so approving runs it.
    expect(s.stage).not.toBe('merge');
    expect(nextStage(s.stage)).toBe('merge');
  });

  it('actually runs merge after the merge gate is approved', () => {
    let s = initial;
    for (let i = 0; i < 12; i++) {
      const out = step(s);
      s = out.state;
      if (s.parked && s.gate !== 'merge') s = approve(s);
      if (s.parked && s.gate === 'merge') break;
    }
    s = approve(s);
    const out = step(s);
    expect(out.ran).toBe('merge');
  });

  it('reaches every stage exactly once across a full approved run', () => {
    let s = initial;
    const ran: StageName[] = [];
    for (let i = 0; i < 40; i++) {
      if (s.parked) {
        s = approve(s);
        continue;
      }
      const out = step(s);
      s = out.state;
      if (!out.ran) {
        // A parked step ran nothing but is not finished — the next pass
        // approves it. Only a step that neither ran nor parked is the end.
        if (s.parked) continue;
        break;
      }
      ran.push(out.ran);
    }
    expect(ran).toEqual(STAGE_ORDER);
  });

  it('never re-parks at a gate it has already approved', () => {
    let s = approve({ ...initial, stage: 'fix', gate: 'merge', approvedGate: null, parked: true });
    const first = step(s);
    expect(first.ran).toBe('qa');
    s = first.state;
    const second = step(s);
    expect(second.ran).toBe('merge');
    expect(second.state.parked).toBe(false);
  });
});

describe('extractBlocked', () => {
  it('returns null for a spec the implement stage did not block on', () => {
    expect(extractBlocked('## Goal\nDo a thing\n## Planned changes\n- a.ts')).toBeNull();
  });

  it('extracts the blocking note', () => {
    const spec = `## Goal\nx\n\n${BLOCKED_MARKER}\n- The helper the spec names does not exist.\n`;
    expect(extractBlocked(spec)).toBe('- The helper the spec names does not exist.');
  });

  it('stops at the next heading', () => {
    const spec = `${BLOCKED_MARKER}\n- Problem\n\n## Out of scope\n- other\n`;
    expect(extractBlocked(spec)).toBe('- Problem');
  });

  it('treats an empty blocked section as not blocked', () => {
    expect(extractBlocked(`## Goal\nx\n\n${BLOCKED_MARKER}\n\n`)).toBeNull();
  });
});
