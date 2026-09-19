import { describe, it, expect, vi, beforeEach, afterEach, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

/**
 * Drives the REAL runner — runNextStage, approveGate, answerQuestion, cancelJob,
 * retryJob — against a real SQLite database with the stages stubbed.
 *
 * tests/job-gates.test.ts models the gate machine in a reimplementation, which
 * is useful but cannot catch a divergence between the model and the runner. All
 * three of the bugs this file was written for (a cancelled job resurrected by
 * its own in-flight stage, an answer restarting the pipeline from design, a
 * reconciled stage left both pending and finished) lived in the gap between
 * them.
 */

const dataDir = mkdtempSync(join(tmpdir(), 'cr-runner-'));

// The runner reaches the filesystem and spawns agents through exactly two
// modules; stub both so a test is fast and deterministic.
const stageResults = vi.hoisted(() => ({
  design: { specPath: 'project/x.md', openQuestion: null as string | null, claudeSessionId: 'cs-1' },
  implement: {
    claudeSessionId: 'cs-2',
    stat: { files: 1, insertions: 2, deletions: 0 },
    openQuestion: null as string | null,
  },
  integrate: {
    outcome: 'already-current' as 'already-current' | 'rebased' | 'conflict',
    conflicts: [] as string[],
    stat: { files: 1, insertions: 2, deletions: 0 },
    detail: null as string | null,
  },
  /** Records the args each stage was called with, for assertions. */
  calls: [] as { stage: string; args: unknown }[],
}));

vi.mock('../src/server/jobs/worktree.js', () => ({
  createWorktree: vi.fn(async () => ({
    path: 'C:/wt/job',
    branch: 'job/x',
    baseBranch: 'trunk',
    initialisedRepo: false,
  })),
  removeWorktree: vi.fn(async () => ({ removed: true, branchDeleted: true })),
  commitAll: vi.fn(async () => true),
  currentBranch: vi.fn(async () => 'SHOULD-NOT-BE-USED'),
  diffStat: vi.fn(async () => ({ files: 0, insertions: 0, deletions: 0 })),
  hasRemote: vi.fn(async () => false),
  worktreeRoot: () => 'C:/wt',
  WorktreeError: class WorktreeError extends Error {},
}));

vi.mock('../src/server/jobs/stages/design.js', () => ({
  runDesignStage: vi.fn(async (args: unknown) => {
    stageResults.calls.push({ stage: 'design', args });
    return stageResults.design;
  }),
}));
vi.mock('../src/server/jobs/stages/implement.js', () => ({
  runImplementStage: vi.fn(async (args: unknown) => {
    stageResults.calls.push({ stage: 'implement', args });
    return stageResults.implement;
  }),
}));
vi.mock('../src/server/jobs/stages/integrate.js', () => ({
  runIntegrateStage: vi.fn(async (args: unknown) => {
    stageResults.calls.push({ stage: 'integrate', args });
    return stageResults.integrate;
  }),
}));
vi.mock('../src/server/jobs/stages/review.js', () => ({
  runReviewStage: vi.fn(async () => ({ findings: null, summary: 'no findings', claudeSessionId: null })),
}));
vi.mock('../src/server/jobs/stages/fix.js', () => ({ runFixStage: vi.fn() }));
vi.mock('../src/server/jobs/stages/qa.js', () => ({
  runQaStage: vi.fn(async () => ({ outcome: 'passed', checks: [], summary: '1 passed', claudeSessionId: null })),
}));
vi.mock('../src/server/jobs/stages/merge.js', () => ({
  runMergeStage: vi.fn(async () => ({ merged: true, pushed: false, pushSkippedReason: 'no-remote', detail: null })),
}));
vi.mock('../src/server/jobs/stages/rebuild.js', () => ({
  runRebuildStage: vi.fn(async () => ({ updated: true, committed: true, pushed: false, detail: 'marked done' })),
}));

// The project must look dispatchable without touching a real repo.
vi.mock('../src/server/projects/workspace.js', () => ({
  findWorkspaceProject: (cwd: string) => ({ cwd }),
  getWorkspaceBoard: () => [],
}));
vi.mock('../src/server/projects/vcs.js', () => ({
  detectVcs: () => 'git',
  capabilitiesFor: () => ({
    kind: 'git',
    canDispatch: true,
    needsInit: false,
    canPush: true,
    note: null,
  }),
}));

const configPath = join(dataDir, 'config.json');
writeFileSync(
  configPath,
  JSON.stringify({ persistence: { dataDir }, projectLog: { maxConcurrent: 4 } })
);
process.env.CLAUDE_REMOTE_CONFIG = configPath;

const { loadConfig } = await import('../src/server/config.js');
const { initDatabase, closeDatabase, getDatabase } = await import('../src/server/db/schema.js');
const runner = await import('../src/server/jobs/runner.js');
const store = await import('../src/server/jobs/store.js');
const scheduler = await import('../src/server/jobs/scheduler.js');

const CWD = 'C:\\p\\alpha';

/** Let the detached pump()/runNextStage chain finish. */
async function settle(rounds = 40): Promise<void> {
  for (let i = 0; i < rounds; i++) await new Promise((r) => setTimeout(r, 0));
}

/** Queue a job and run it up to its first park. */
async function startJob(featureId: string | null = 'f-1') {
  const job = runner.queueJob({ cwd: CWD, featureId, title: 'A feature' });
  await settle();
  return job.id;
}

beforeAll(() => {
  loadConfig();
  initDatabase();
});

afterAll(() => {
  closeDatabase();
  rmSync(dataDir, { recursive: true, force: true });
});

beforeEach(() => {
  // Several tests swap the policy; always start from the real one.
  scheduler.setPolicy(new scheduler.OneRunningJobPerProject());
  getDatabase().exec('DELETE FROM jobs');
  stageResults.design = { specPath: 'project/x.md', openQuestion: null, claudeSessionId: 'cs-1' };
  stageResults.implement = {
    claudeSessionId: 'cs-2',
    stat: { files: 1, insertions: 2, deletions: 0 },
    openQuestion: null,
  };
  stageResults.integrate = {
    outcome: 'already-current',
    conflicts: [],
    stat: { files: 1, insertions: 2, deletions: 0 },
    detail: null,
  };
  stageResults.calls = [];
});

afterEach(() => vi.clearAllMocks());

describe('the happy path', () => {
  it('parks at the design gate with the spec recorded', async () => {
    const id = await startJob();
    const job = store.getJobWithStages(id)!;

    expect(job.status).toBe('parked');
    expect(job.gate).toBe('design');
    expect(job.stages.find((s) => s.name === 'design')).toMatchObject({
      status: 'passed',
      detail: 'project/x.md',
    });
  });

  it('records the base branch the worktree was cut from', async () => {
    const id = await startJob();
    expect(store.getJob(id)!.baseBranch).toBe('trunk');
  });

  it('runs to done through both gates', async () => {
    const id = await startJob();

    runner.approveGate(id); // design
    await settle();
    expect(store.getJob(id)!.gate).toBe('merge'); // parked before merge

    runner.approveGate(id); // merge
    await settle();

    const job = store.getJobWithStages(id)!;
    expect(job.status).toBe('done');
    expect(job.stages.filter((s) => s.status === 'pending')).toEqual([]);
  });

  it('passes the recorded base branch to the stages, not the live one', async () => {
    const id = await startJob();
    runner.approveGate(id);
    await settle();

    const implement = stageResults.calls.find((c) => c.stage === 'implement');
    expect((implement?.args as { baseBranch: string }).baseBranch).toBe('trunk');
  });
});

describe('questions re-run the stage that asked (finding 2)', () => {
  it('a design question re-runs design', async () => {
    stageResults.design.openQuestion = 'Which option?';
    const id = await startJob();

    const parked = store.getJobWithStages(id)!;
    expect(parked.parkReason).toBe('question');
    expect(parked.detail).toBe('Which option?');
    // The asking stage is recorded as needing a decision, not passed (finding 8).
    const design = parked.stages.find((s) => s.name === 'design')!;
    expect(design.status).toBe('needs_decision');
    // The spec path is recorded even here, so the board can show the document
    // the question is about. What keeps implement from building off an
    // unapproved spec is the STATUS above, not this field's contents.
    expect(design.detail).toBe('project/x.md');

    stageResults.design.openQuestion = null;
    stageResults.calls = [];
    runner.answerQuestion(id, 'Option A');
    await settle();

    expect(stageResults.calls.map((c) => c.stage)).toContain('design');
    expect(store.getJob(id)!.gate).toBe('design');
  });

  it('an implement question re-runs IMPLEMENT, not design', async () => {
    stageResults.implement.openQuestion = 'The spec does not hold';
    const id = await startJob();
    runner.approveGate(id);
    await settle();

    const parked = store.getJob(id)!;
    expect(parked.parkReason).toBe('question');
    // `stage` steps back to design so nextStage() resolves to implement.
    expect(parked.stage).toBe('design');

    stageResults.implement.openQuestion = null;
    stageResults.calls = [];
    runner.answerQuestion(id, 'Do it this way');
    await settle();

    const ran = stageResults.calls.map((c) => c.stage);
    expect(ran).toContain('implement');
    // The regression: it used to restart from design, discarding the work.
    expect(ran).not.toContain('design');
  });

  it('an integrate conflict re-runs INTEGRATE, not design', async () => {
    stageResults.integrate = {
      outcome: 'conflict',
      conflicts: ['a.ts'],
      stat: { files: 0, insertions: 0, deletions: 0 },
      detail: 'Rebase onto trunk conflicts in: a.ts',
    };
    const id = await startJob();
    runner.approveGate(id);
    await settle();

    expect(store.getJob(id)!.stage).toBe('implement');

    stageResults.integrate.outcome = 'already-current';
    stageResults.calls = [];
    runner.answerQuestion(id, 'Resolved by hand');
    await settle();

    const ran = stageResults.calls.map((c) => c.stage);
    expect(ran).toContain('integrate');
    expect(ran).not.toContain('design');
    expect(ran).not.toContain('implement');
  });

  it('keeps the answer in the database, not in process memory (finding 5)', async () => {
    stageResults.design.openQuestion = 'Which option?';
    const id = await startJob();

    // Freeze the scheduler so answerQuestion's pump cannot consume the answer
    // before we can observe where it was stored.
    scheduler.setPolicy({ name: 'frozen', canStart: () => false });
    runner.answerQuestion(id, 'Option A');

    // Read it straight out of SQLite — a module-level Map would not be here,
    // and would be gone after a restart.
    const row = getDatabase().prepare('SELECT pending_answer FROM jobs WHERE id = ?').get(id) as {
      pending_answer: string;
    };
    expect(row.pending_answer).toBe('Option A');
  });

  it('hands the stored answer to the stage and then clears it', async () => {
    stageResults.design.openQuestion = 'Which option?';
    const id = await startJob();

    stageResults.design.openQuestion = null;
    stageResults.calls = [];
    runner.answerQuestion(id, 'Option A');
    await settle();

    const design = stageResults.calls.find((c) => c.stage === 'design');
    expect((design?.args as { answer: string }).answer).toBe('Option A');
    expect(store.getJob(id)!.pendingAnswer).toBeNull();
  });

  it('refuses an answer for a job with no question', async () => {
    const id = await startJob();
    expect(() => runner.answerQuestion(id, 'x')).toThrow(/no open question/);
  });
});

describe('cancellation (finding 1)', () => {
  it('cancels a parked job and tears the worktree down', async () => {
    const id = await startJob();
    const job = await runner.cancelJob(id);
    expect(job.status).toBe('cancelled');
    expect(job.worktreePath).toBeNull();
  });

  it('aborts a stage that is mid-flight instead of refusing', async () => {
    // A stage that only ends when its signal fires — the shape of a real
    // `claude -p` run, which spawnClaude kills on abort.
    const design = await import('../src/server/jobs/stages/design.js');
    let receivedSignal: AbortSignal | undefined;
    vi.mocked(design.runDesignStage).mockImplementationOnce(async (args) => {
      receivedSignal = (args as { signal?: AbortSignal }).signal;
      await new Promise<never>((_resolve, reject) => {
        receivedSignal?.addEventListener('abort', () => reject(new Error('run aborted')), {
          once: true,
        });
      });
      return stageResults.design;
    });

    const job = runner.queueJob({ cwd: CWD, featureId: 'f-1', title: 'Slow one' });
    await settle(5);
    expect(store.getJob(job.id)!.status).toBe('running');

    const cancelled = await runner.cancelJob(job.id);
    // The stage was actually handed a signal — without one it could not be stopped.
    expect(receivedSignal).toBeDefined();
    expect(receivedSignal!.aborted).toBe(true);
    expect(cancelled.status).toBe('cancelled');
    expect(cancelled.worktreePath).toBeNull();
  });

  it('does not let the aborted stage rewrite the cancellation as failed', async () => {
    // The regression this guards: the catch in runNextStage was the one terminal
    // write with no stillLive() check, so an aborted run's rejection landed as
    // `failed` on top of the status the user had just asked for.
    const design = await import('../src/server/jobs/stages/design.js');
    vi.mocked(design.runDesignStage).mockImplementationOnce(async (args) => {
      const { signal } = args as { signal?: AbortSignal };
      await new Promise<never>((_resolve, reject) => {
        signal?.addEventListener('abort', () => reject(new Error('run aborted')), { once: true });
      });
      return stageResults.design;
    });

    const job = runner.queueJob({ cwd: CWD, featureId: 'f-1', title: 'Slow one' });
    await settle(5);
    await runner.cancelJob(job.id);

    // Let every queued microtask and pump() settle: the status must still be the
    // one cancelJob wrote, not `failed`.
    await settle();
    expect(store.getJob(job.id)!.status).toBe('cancelled');
    // The abort's rejection message must not have been recorded as a failure.
    expect(store.getJob(job.id)!.detail).toBeNull();
  });

  it('refuses to cancel a job that already finished, pointing at discard', async () => {
    const id = await startJob();
    await runner.cancelJob(id);
    await expect(runner.cancelJob(id)).rejects.toThrow(/already finished/);
  });
});

describe('discard', () => {
  it('refuses to discard a job that is still live', async () => {
    const id = await startJob(); // parked at the design gate
    await expect(runner.discardJob(id)).rejects.toThrow(/still active/);
  });

  it('tears down the worktree and drops the row off the board', async () => {
    const id = await startJob();
    await runner.cancelJob(id);

    const result = await runner.discardJob(id);
    expect(result.worktreeRemoved).toBe(true);
    expect(result.branchDeleted).toBe(true);
    expect(store.getJob(id)).toBeNull();
  });

  it('reports a job that never merged as fully restoring the project', async () => {
    const id = await startJob();
    await runner.cancelJob(id);

    const result = await runner.discardJob(id);
    expect(result.mergeLanded).toBe(false);
    expect(result.baseBranch).toBeNull();
  });

  it('reports a landed merge rather than pretending it was undone', async () => {
    const id = await startJob();
    runner.approveGate(id); // design
    await settle();
    runner.approveGate(id); // merge
    await settle();
    expect(store.getJob(id)!.status).toBe('done');

    const result = await runner.discardJob(id);
    // The commit is in the base branch and stays there; discard only says so.
    expect(result.mergeLanded).toBe(true);
    expect(result.baseBranch).toBe('trunk');
    expect(store.getJob(id)).toBeNull();
  });
});

describe('gates', () => {
  it('refuses approval for a job waiting on a question', async () => {
    stageResults.design.openQuestion = 'Which option?';
    const id = await startJob();
    expect(() => runner.approveGate(id)).toThrow(/waiting for an answer/);
  });

  it('refuses approval for a job that is not parked', async () => {
    const id = await startJob();
    runner.approveGate(id);
    expect(() => runner.approveGate(id)).toThrow(/not waiting for approval/);
  });

  it('records the approved gate so the merge stage is not re-gated', async () => {
    const id = await startJob();
    runner.approveGate(id);
    await settle();
    expect(store.getJob(id)!.gate).toBe('merge');

    runner.approveGate(id);
    expect(store.getJob(id)!.approvedGate).toBe('merge');
  });
});

describe('retry and restart reconciliation', () => {
  it('retries the failed stage without redoing the ones before it', async () => {
    const design = await import('../src/server/jobs/stages/design.js');
    vi.mocked(design.runDesignStage).mockRejectedValueOnce(new Error('boom'));

    const id = await startJob();
    expect(store.getJob(id)!.status).toBe('failed');

    stageResults.calls = [];
    runner.retryJob(id);
    await settle();

    expect(store.getJob(id)!.status).toBe('parked');
    expect(stageResults.calls.map((c) => c.stage)).toEqual(['design']);
  });

  it('refuses to retry a job that did not fail', async () => {
    const id = await startJob();
    expect(() => runner.retryJob(id)).toThrow(/Only a failed job/);
  });

  it('re-queues a job stranded mid-stage by a restart, leaving no finished-pending stage', async () => {
    const id = await startJob();
    // Simulate the crash exactly as runNextStage leaves it: job.stage and the
    // running stage row are always the same stage.
    store.updateJob(id, { status: 'running', stage: 'implement' });
    store.startStage(id, 'implement');

    // Freeze the scheduler: reconcile ends with pump(), which would restart the
    // stage and mask what reconcile itself left behind.
    scheduler.setPolicy({ name: 'frozen', canStart: () => false });
    runner.reconcileJobsOnStartup();

    const stage = store.getJobStages(id).find((s) => s.name === 'implement')!;
    expect(stage.status).toBe('pending');
    // Finding 10: pending is not a finish.
    expect(stage.finishedAt).toBeNull();
    expect(stage.startedAt).toBeNull();
    // Stepped back so the interrupted stage re-runs rather than being skipped.
    expect(store.getJob(id)!.stage).toBe('design');
  });
});
