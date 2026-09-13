import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  admit,
  getPolicy,
  setPolicy,
  OneRunningJobPerProject,
  FullParallel,
  type SchedulePolicy,
} from '../src/server/jobs/scheduler.js';
import {
  nextStage,
  isLive,
  STAGE_ORDER,
  type Job,
  type JobStatus,
} from '../src/server/jobs/types.js';
import {
  extractOpenQuestion,
  specSlugFor,
  OPEN_QUESTION_MARKER,
} from '../src/server/jobs/stages/design.js';
import { branchNameFor } from '../src/server/jobs/worktree.js';

let seq = 0;
function job(cwd: string, over: Partial<Job> = {}): Job {
  seq += 1;
  return {
    id: `job-${seq}`,
    projectCwd: cwd,
    featureId: null,
    title: `Job ${seq}`,
    status: 'queued' as JobStatus,
    stage: null,
    gate: null,
    parkReason: null,
    detail: null,
    worktreePath: null,
    branch: null,
    claudeSessionId: null,
    createdAt: `2026-09-13T10:0${seq}:00.000Z`,
    updatedAt: '2026-09-13T10:00:00.000Z',
    ...over,
  };
}

const A = 'C:\\Users\\Albert\\NodeProjects\\a';
const B = 'C:\\Users\\Albert\\NodeProjects\\b';

const original = getPolicy();
beforeEach(() => {
  seq = 0;
  setPolicy(new OneRunningJobPerProject());
});
afterEach(() => setPolicy(original));

describe('OneRunningJobPerProject', () => {
  it('admits one job per project and queues the rest', () => {
    const a1 = job(A);
    const a2 = job(A);
    const b1 = job(B);
    const admitted = admit([a1, a2, b1], []);
    expect(admitted.map((j) => j.id)).toEqual([a1.id, b1.id]);
  });

  it('admits nothing for a project that already has a job running', () => {
    const running = job(A, { status: 'running' });
    expect(admit([job(A)], [running])).toEqual([]);
  });

  it('still admits other projects while one is busy', () => {
    const running = job(A, { status: 'running' });
    const candidate = job(B);
    expect(admit([candidate], [running]).map((j) => j.id)).toEqual([candidate.id]);
  });

  it('matches project paths case- and separator-insensitively', () => {
    const running = job('C:/Users/Albert/NodeProjects/A', { status: 'running' });
    expect(admit([job(A)], [running])).toEqual([]);
  });

  it('drains a project queue oldest-first', () => {
    const older = job(A, { createdAt: '2026-09-13T09:00:00.000Z' });
    const newer = job(A, { createdAt: '2026-09-13T11:00:00.000Z' });
    // Deliberately pass newest first; admission must not follow input order.
    expect(admit([newer, older], []).map((j) => j.id)).toEqual([older.id]);
  });

  it('accounts for jobs admitted earlier in the same pass', () => {
    // Two jobs for one project in one pass: the second must see the first.
    const admitted = admit([job(A), job(A)], []);
    expect(admitted).toHaveLength(1);
  });
});

describe('policy is swappable', () => {
  it('FullParallel admits several jobs for one project up to its cap', () => {
    setPolicy(new FullParallel(3));
    const admitted = admit([job(A), job(A), job(A), job(A)], []);
    expect(admitted).toHaveLength(3);
  });

  it('a custom policy changes admission with no other code touched', () => {
    const refuseEverything: SchedulePolicy = { name: 'test-stub', canStart: () => false };
    setPolicy(refuseEverything);
    expect(admit([job(A), job(B)], [])).toEqual([]);
    expect(getPolicy().name).toBe('test-stub');
  });

  it('a policy sees the running set it is given', () => {
    const seen: number[] = [];
    setPolicy({
      name: 'observer',
      canStart: (_c, running) => {
        seen.push(running.length);
        return true;
      },
    });
    admit([job(A), job(A), job(A)], []);
    expect(seen).toEqual([0, 1, 2]);
  });
});

describe('pipeline order', () => {
  it('starts at design and runs to rebuild', () => {
    expect(nextStage(null)).toBe('design');
    expect(nextStage('design')).toBe('implement');
    expect(nextStage('review')).toBe('fix');
    expect(nextStage('rebuild')).toBeNull();
  });

  it('covers every stage exactly once', () => {
    const walked: string[] = [];
    let stage = nextStage(null);
    while (stage) {
      walked.push(stage);
      stage = nextStage(stage);
    }
    expect(walked).toEqual(STAGE_ORDER);
  });

  it('treats queued, running and parked as live', () => {
    expect(['queued', 'running', 'parked'].every((s) => isLive(s as JobStatus))).toBe(true);
    expect(['done', 'failed', 'cancelled'].some((s) => isLive(s as JobStatus))).toBe(false);
  });
});

describe('extractOpenQuestion', () => {
  it('returns null when the spec has no open question', () => {
    expect(extractOpenQuestion('## Goal\nDo a thing.\n## Planned changes\n- a.ts')).toBeNull();
  });

  it('extracts the question body', () => {
    const spec = `## Goal\nDo a thing.\n\n${OPEN_QUESTION_MARKER}\n- Should X be configurable?\n`;
    expect(extractOpenQuestion(spec)).toBe('- Should X be configurable?');
  });

  it('stops at the next heading', () => {
    const spec = `${OPEN_QUESTION_MARKER}\n- The question\n\n## Out of scope\n- Not this\n`;
    expect(extractOpenQuestion(spec)).toBe('- The question');
  });

  it('returns null for an empty question section rather than parking on nothing', () => {
    expect(extractOpenQuestion(`## Goal\nx\n\n${OPEN_QUESTION_MARKER}\n\n`)).toBeNull();
  });
});

describe('naming', () => {
  it('derives a readable branch name with a short id suffix', () => {
    const branch = branchNameFor('abcdef12-3456-7890-abcd-ef1234567890', 'Task dispatch queue!');
    expect(branch).toBe('job/task-dispatch-queue-abcdef12');
  });

  it('falls back when a title has no usable characters', () => {
    expect(branchNameFor('abcdef12-0000-0000-0000-000000000000', '***')).toBe(
      'job/feature-abcdef12'
    );
  });

  it('derives a spec slug, falling back to the feature id', () => {
    expect(specSlugFor('Task Dispatch Queue', 'f-abc123')).toBe('task-dispatch-queue');
    expect(specSlugFor('***', 'f-abc123')).toBe('f-abc123');
  });
});
