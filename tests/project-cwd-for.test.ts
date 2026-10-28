import { describe, it, expect, vi } from 'vitest';

/**
 * A track or job worktree lives under ~/.claude-remote/worktrees, outside its
 * project, so its sessions must look up the project's account by the project's
 * main checkout, never the worktree path.
 */

const TRACK_WT = 'C:\\Users\\me\\.claude-remote\\worktrees\\tracks\\alpha-ab12cd34';
const JOB_WT = 'C:\\Users\\me\\.claude-remote\\worktrees\\job-1';
const ALPHA = 'C:\\Projects\\alpha';

vi.mock('../src/server/projects/track-store.js', () => ({
  trackBranchForPath: (cwd: string) =>
    cwd === TRACK_WT ? { projectCwd: ALPHA, branch: 'track/x', worktreePath: TRACK_WT } : null,
}));
vi.mock('../src/server/jobs/store.js', () => ({
  jobForWorktreePath: (cwd: string) =>
    cwd === JOB_WT ? { projectCwd: ALPHA, branch: 'job/y', worktreePath: JOB_WT } : null,
}));

const { projectCwdFor } = await import('../src/server/projects/worktree-owner.js');

describe('projectCwdFor', () => {
  it("maps a track or job worktree to its project's main checkout", () => {
    expect(projectCwdFor(TRACK_WT)).toBe(ALPHA);
    expect(projectCwdFor(JOB_WT)).toBe(ALPHA);
  });

  it('leaves any other folder, and no folder, as it is', () => {
    expect(projectCwdFor(ALPHA)).toBe(ALPHA);
    expect(projectCwdFor('D:\\elsewhere')).toBe('D:\\elsewhere');
    expect(projectCwdFor(undefined)).toBeUndefined();
  });
});
