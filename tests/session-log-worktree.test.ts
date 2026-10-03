import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { execFileSync } from 'child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

vi.setConfig({ testTimeout: 30_000 });

/**
 * Where a worktree session's SESSION-LOG.md entry goes (f-wycv03).
 *
 * A real repository, real track branch and real database, so the lookup runs
 * against actual records; only the `claude -p` run is faked. It records where
 * it ran and with which write globs, and writes an entry as the model would.
 */

const dataDir = mkdtempSync(join(tmpdir(), 'cr-slog-data-'));
const configPath = join(dataDir, 'config.json');
writeFileSync(configPath, JSON.stringify({ persistence: { dataDir } }));
process.env.CLAUDE_REMOTE_CONFIG = configPath;

const SESSION_START = '2026-09-13T12:00:00.000Z';
const transcriptPath = join(dataDir, 'transcript.jsonl');
writeFileSync(
  transcriptPath,
  [
    JSON.stringify({ timestamp: '2026-09-13T12:01:00.000Z', type: 'user' }),
    JSON.stringify({ timestamp: '2026-09-13T12:02:00.000Z', type: 'assistant', message: { content: [{ name: 'Edit' }] } }),
    JSON.stringify({ timestamp: '2026-09-13T12:03:00.000Z', type: 'user' }),
  ].join('\n')
);

interface FakeRun {
  cwd: string;
  prompt: string;
  globs: string[];
  tagCwd: string | undefined;
}
const runs: FakeRun[] = [];

vi.mock('../src/server/sessions/transcript.js', async (importActual) => ({
  ...(await importActual<typeof import('../src/server/sessions/transcript.js')>()),
  tryGetTranscriptPath: () => transcriptPath,
}));

vi.mock('../src/server/agent/claude-run.js', async (importActual) => ({
  ...(await importActual<typeof import('../src/server/agent/claude-run.js')>()),
  runClaude: async (cwd: string, prompt: string, globs: string[], opts: { tag?: { projectCwd?: string } } = {}) => {
    runs.push({ cwd, prompt, globs, tagCwd: opts.tag?.projectCwd });
    writeFileSync(join(cwd, 'SESSION-LOG.md'), '# Session Log\n\nentry\n');
    return { isError: false, result: '', permissionDenials: 0, sessionId: null };
  },
}));

const { loadConfig } = await import('../src/server/config.js');
const { initDatabase, closeDatabase, getDatabase } = await import('../src/server/db/schema.js');
const tracks = await import('../src/server/projects/track-branches.js');
/** Land with no running sessions anywhere. */
const NO_SESSIONS = { sessions: [], terminateSession: async () => true };
const { generateSessionLogForced } = await import('../src/server/sessions/project-log.js');
const { worktreeOwner } = await import('../src/server/projects/worktree-owner.js');
const { createJob, updateJob } = await import('../src/server/jobs/store.js');

let repo: string;

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8' }).trim();
}

const ctx = (cwd: string) => ({
  sessionId: 'sess-1',
  name: 'Worktree work',
  cwd,
  claudeSessionId: '11111111-2222-3333-4444-555555555555',
  createdAt: SESSION_START,
});

beforeAll(() => {
  loadConfig();
  initDatabase();
});

afterAll(() => {
  closeDatabase();
  rmSync(dataDir, { recursive: true, force: true });
});

beforeEach(() => {
  runs.length = 0;
  getDatabase().exec('DELETE FROM track_branches');
  getDatabase().exec('DELETE FROM jobs');
  repo = mkdtempSync(join(tmpdir(), 'cr-slog-repo-'));
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'config', 'user.email', 'test@example.com');
  git(repo, 'config', 'user.name', 'Test');
  git(repo, 'config', 'commit.gpgsign', 'false');
  writeFileSync(join(repo, 'PROJECT.md'), '## Track: Alpha\n- [ ] `f-aaaaaa` First step\n');
  writeFileSync(join(repo, '.gitignore'), 'SESSION-LOG.md\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-q', '-m', 'plan');
});

describe('worktreeOwner', () => {
  it('resolves a track worktree, and a folder inside it, to the project from the record', async () => {
    const t = await tracks.ensureTrackBranch({ cwd: repo }, 'Alpha');
    expect(worktreeOwner(t.worktreePath)).toMatchObject({ projectCwd: repo, kind: 'track', branch: t.branch });
    expect(worktreeOwner(join(t.worktreePath, 'src'))?.projectCwd).toBe(repo);
  });

  it('resolves a job worktree from the job row', () => {
    const job = createJob({ projectCwd: repo, featureId: null, title: 'J' });
    const wt = join(dataDir, 'worktrees', 'job-x');
    updateJob(job.id, { worktreePath: wt, branch: 'job/j' });
    expect(worktreeOwner(wt)).toMatchObject({ projectCwd: repo, kind: 'job', branch: 'job/j' });
  });

  it('is null for the main checkout and for an unrecorded folder', () => {
    expect(worktreeOwner(repo)).toBeNull();
    expect(worktreeOwner(mkdtempSync(join(tmpdir(), 'cr-slog-other-')))).toBeNull();
  });
});

describe('generateSessionLog for a worktree session', () => {
  it('writes the entry into the main checkout, runs there, and reads git from the worktree', async () => {
    const t = await tracks.ensureTrackBranch({ cwd: repo }, 'Alpha');
    writeFileSync(join(t.worktreePath, 'feature.ts'), 'export const x = 1;\n');
    git(t.worktreePath, 'add', 'feature.ts');
    git(t.worktreePath, 'commit', '-q', '-m', 'worktree-only commit');

    const recent = new Date(Date.now() - 60_000).toISOString();
    expect(await generateSessionLogForced({ ...ctx(t.worktreePath), createdAt: recent })).toBe('generated');

    expect(runs).toHaveLength(1);
    expect(runs[0].cwd).toBe(repo);
    expect(runs[0].tagCwd).toBe(repo);
    // Plan ticking is off for worktree sessions: only the log may be written.
    expect(runs[0].globs).toEqual(['SESSION-LOG.md']);
    expect(runs[0].prompt).toContain('Do not modify plan or design files.');
    expect(runs[0].prompt).toContain(`Branch: ${t.branch}`);
    expect(runs[0].prompt).toContain(`the track worktree ${t.worktreePath}`);
    // The evidence is the worktree's, and the plan docs are read from there too.
    expect(runs[0].prompt).toContain('worktree-only commit');
    // Only the worktree's plan file and specs, not every plan glob a second time.
    expect(runs[0].prompt).toContain(join(t.worktreePath, 'PROJECT.md'));
    expect(runs[0].prompt).toContain('Glob "project/*.md" with that');
    expect(runs[0].prompt).not.toContain('Glob the same patterns');

    expect(existsSync(join(repo, 'SESSION-LOG.md'))).toBe(true);
    expect(existsSync(join(t.worktreePath, 'SESSION-LOG.md'))).toBe(false);
  });

  it('still logs to main once the worktree is gone, from the transcript alone', async () => {
    const t = await tracks.ensureTrackBranch({ cwd: repo }, 'Alpha');
    await tracks.landTrack({ cwd: repo }, 'Alpha', NO_SESSIONS);
    expect(existsSync(t.worktreePath)).toBe(false);

    expect(await generateSessionLogForced(ctx(t.worktreePath))).toBe('generated');
    expect(runs[0].cwd).toBe(repo);
    expect(runs[0].prompt).toContain(`Branch: ${t.branch}`);
  });

  it('logs a session on main in place, ticking plans as before', async () => {
    writeFileSync(join(repo, 'main.ts'), 'x\n');
    expect(await generateSessionLogForced({ ...ctx(repo), createdAt: new Date(Date.now() - 60_000).toISOString() })).toBe(
      'generated'
    );
    expect(runs[0].cwd).toBe(repo);
    expect(runs[0].globs.length).toBeGreaterThan(1);
    expect(runs[0].prompt).not.toContain('Worked in:');
  });

  it('logs an unrecorded worktree in place', async () => {
    const wt = join(dataDir, 'loose-wt');
    git(repo, 'worktree', 'add', '-q', '-b', 'loose', wt);
    writeFileSync(join(wt, 'loose.ts'), 'x\n');
    expect(await generateSessionLogForced({ ...ctx(wt), createdAt: new Date(Date.now() - 60_000).toISOString() })).toBe(
      'generated'
    );
    expect(runs[0].cwd).toBe(wt);
    git(repo, 'worktree', 'remove', '--force', wt);
  });

  it('skips, and does not retry forever, a worktree that is gone and that nothing records', async () => {
    expect(await generateSessionLogForced(ctx(join(dataDir, 'worktrees', 'tracks', 'deadbeef')))).toBe('skipped');
    expect(runs).toHaveLength(0);
  });

  it('leaves any other missing folder unstamped, to retry later (an unmounted drive, say)', async () => {
    expect(await generateSessionLogForced(ctx(join(dataDir, 'unmounted')))).not.toBe('skipped');
  });
});

describe('landTrack with a tracked SESSION-LOG.md', () => {
  it('lets main’s dirty session log through, and leaves it uncommitted', async () => {
    writeFileSync(join(repo, '.gitignore'), '');
    writeFileSync(join(repo, 'SESSION-LOG.md'), '# Session Log\n');
    git(repo, 'add', '.');
    git(repo, 'commit', '-q', '-m', 'track the log');
    const t = await tracks.ensureTrackBranch({ cwd: repo }, 'Alpha');
    writeFileSync(join(repo, 'SESSION-LOG.md'), '# Session Log\n\nan entry for the worktree session\n');

    const landed = await tracks.landTrack({ cwd: repo }, 'Alpha', NO_SESSIONS);
    expect(landed.mergeSha).toBeTruthy();
    expect(existsSync(t.worktreePath)).toBe(false);
    expect(git(repo, 'status', '--porcelain')).toBe('M SESSION-LOG.md');
    expect(readFileSync(join(repo, 'SESSION-LOG.md'), 'utf-8')).toContain('an entry for the worktree session');
  });
});
