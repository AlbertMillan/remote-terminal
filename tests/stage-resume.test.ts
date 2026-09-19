import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

/**
 * What a stage does when the user answers the question it stopped on.
 *
 * It used to start a brand-new session and paste the spec back in, so the run
 * rediscovered the repository to apply a one-line answer — 23 turns and 1.45M
 * cache-read tokens on a one-file feature, measured on a real job. Continuing
 * the session that asked keeps all of that in context.
 *
 * The properties worth pinning are the ones that make it safe to do so: a
 * failed resume must fall back to exactly the old behaviour, a cancellation
 * must NOT be mistaken for a failed resume, and the answer must reach the run
 * either way.
 */

const runs = vi.hoisted(() => ({
  calls: [] as { prompt: string; resumeSessionId?: string }[],
  /** Set to make the next resumed run reject. */
  failResumeWith: null as Error | null,
}));

vi.mock('../src/server/agent/claude-run.js', async () => {
  const actual = await vi.importActual<Record<string, unknown>>(
    '../src/server/agent/claude-run.js'
  );
  return {
    ...actual,
    runClaude: vi.fn(async (_cwd: string, prompt: string, _globs: string[], options = {}) => {
      const { resumeSessionId } = options as { resumeSessionId?: string };
      runs.calls.push({ prompt, resumeSessionId });
      if (resumeSessionId && runs.failResumeWith) throw runs.failResumeWith;
      return { sessionId: 'cs-new', usage: null, isError: false, permissionDenials: 0, result: '' };
    }),
  };
});

const { runDesignStage } = await import('../src/server/jobs/stages/design.js');
const { RunAbortedError } = await import('../src/server/agent/claude-run.js');

function worktree(): string {
  const dir = mkdtempSync(join(tmpdir(), 'cr-resume-'));
  mkdirSync(join(dir, 'project'), { recursive: true });
  // A spec must exist when the stage finishes or it throws by contract.
  writeFileSync(join(dir, 'project', 'a-feature.md'), '# Spec\n\n## Goal\nDone.\n');
  return dir;
}

const job = {
  id: 'job-1',
  title: 'A feature',
  featureId: null,
  projectCwd: 'C:/p/alpha',
} as never;

beforeEach(() => {
  runs.calls = [];
  runs.failResumeWith = null;
});

describe('design stage resume', () => {
  it('continues the session that asked, sending only the answer', async () => {
    await runDesignStage({
      job,
      worktreePath: worktree(),
      answer: 'Use option (b)',
      resumeSessionId: 'cs-asked',
    });

    expect(runs.calls).toHaveLength(1);
    const [call] = runs.calls;
    expect(call.resumeSessionId).toBe('cs-asked');
    expect(call.prompt).toContain('Use option (b)');
    // The whole saving: no re-statement of the task, no spec pasted back in.
    expect(call.prompt).not.toContain('You are designing one feature');
    expect(call.prompt.length).toBeLessThan(800);
  });

  it('runs the full pass when there is no session to continue', async () => {
    await runDesignStage({
      job,
      worktreePath: worktree(),
      answer: 'Use option (b)',
      resumeSessionId: null,
    });

    expect(runs.calls).toHaveLength(1);
    expect(runs.calls[0].resumeSessionId).toBeUndefined();
    // The answer still has to reach the run.
    expect(runs.calls[0].prompt).toContain('Use option (b)');
    expect(runs.calls[0].prompt).toContain('You are designing one feature');
  });

  it('falls back to a full pass when the resume fails', async () => {
    runs.failResumeWith = new Error('No conversation found with session ID');

    await runDesignStage({
      job,
      worktreePath: worktree(),
      answer: 'Use option (b)',
      resumeSessionId: 'cs-gone',
    });

    // Worst case of resuming is exactly the behaviour it replaced.
    expect(runs.calls).toHaveLength(2);
    expect(runs.calls[0].resumeSessionId).toBe('cs-gone');
    expect(runs.calls[1].resumeSessionId).toBeUndefined();
    expect(runs.calls[1].prompt).toContain('You are designing one feature');
  });

  it('does not retry a cancelled run', async () => {
    runs.failResumeWith = new RunAbortedError();

    await expect(
      runDesignStage({
        job,
        worktreePath: worktree(),
        answer: 'Use option (b)',
        resumeSessionId: 'cs-asked',
      })
    ).rejects.toBeInstanceOf(RunAbortedError);

    // Cancelling must not be read as a broken session and re-run at full cost.
    expect(runs.calls).toHaveLength(1);
  });

  it('never resumes a first pass, only an answered one', async () => {
    await runDesignStage({ job, worktreePath: worktree(), resumeSessionId: 'cs-stale' });

    expect(runs.calls[0].resumeSessionId).toBeUndefined();
  });
});
