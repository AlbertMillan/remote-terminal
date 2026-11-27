import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import { execFileSync } from 'child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

// Real repositories: every git spawn costs ~50-100ms on Windows, and the
// suites run in parallel, so the 5s default is too tight under load.
vi.setConfig({ testTimeout: 30_000 });

/**
 * Delete track against a real repository and database.
 *
 * What has to hold is a property of git: the revert commit's tree, a conflict
 * leaving HEAD, index and working tree exactly as they were, a worktree and
 * branch actually gone. The job verbs are stubbed to their effect on the
 * table — the runner has its own tests.
 */

const dataDir = mkdtempSync(join(tmpdir(), 'cr-tdel-data-'));
const configPath = join(dataDir, 'config.json');
writeFileSync(configPath, JSON.stringify({ persistence: { dataDir } }));
process.env.CLAUDE_REMOTE_CONFIG = configPath;

const { loadConfig } = await import('../src/server/config.js');
const { initDatabase, closeDatabase, getDatabase } = await import('../src/server/db/schema.js');
// Track branches, Land's git half and Update from main: one namespace, as before the split.
const tracks = {
  ...(await import('../src/server/projects/track-branches.js')),
  ...(await import('../src/server/projects/track-land-core.js')),
  ...(await import('../src/server/projects/track-update.js')),
};
/** Land with no running sessions anywhere. */
const NO_SESSIONS = { sessions: [], terminateSession: async () => true, removeSessions: async () => undefined };
const { planTrackDelete, executeTrackDelete } = await import('../src/server/projects/track-delete.js');
const factory = await import('../src/server/factory/store.js');
const { peerNotesDirFor } = await import('../src/server/sessions/prompt-file.js');
const { jobMergeMessageArgs, multiFeatureMergeMessageArgs } = await import('../src/server/projects/merge-trailers.js');

const DOC = `## Track: Alpha
- [ ] \`f-aaaaaa\` First step → project/alpha.md
- [ ] \`f-bbbbbb\` Second step → project/alpha.md

## Track: Beta
- [ ] \`f-cccccc\` Unrelated
`;

let repo: string;
const project = () => ({ cwd: repo });

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8' }).trim();
}

function commitFile(cwd: string, rel: string, content: string, message: string): void {
  mkdirSync(join(cwd, rel, '..'), { recursive: true });
  writeFileSync(join(cwd, rel), content);
  git(cwd, 'add', '--', rel);
  git(cwd, 'commit', '-q', '-m', message);
}

/**
 * An old job-style merge straight into main: a branch, one commit, `merge --no-ff`.
 * With `ids`, the message is the old merge stage's own, trailers included; without,
 * it is a merge from before trailers existed.
 */
function mergeLikeAJob(
  title: string,
  file: string,
  ids?: { jobId: string; featureId: string | null },
  cwd = repo
): string {
  const branch = `job/${Math.random().toString(36).slice(2, 8)}`;
  const base = git(cwd, 'rev-parse', '--abbrev-ref', 'HEAD');
  git(cwd, 'checkout', '-q', '-b', branch);
  commitFile(cwd, file, `export const x = '${title}';\n`, `implement ${title}`);
  git(cwd, 'checkout', '-q', base);
  const message = ids ? jobMergeMessageArgs(title, ids) : ['-m', `Merge job: ${title}`];
  git(cwd, 'merge', '-q', '--no-ff', branch, ...message);
  git(cwd, 'branch', '-q', '-D', branch);
  return git(cwd, 'rev-parse', 'HEAD');
}

/**
 * A row the retired job pipeline left behind (projects/job-history.ts reads them,
 * read-only): written straight into the kept `jobs` / `job_stages` tables.
 */
function oldJob(row: { id: string; featureId: string | null; title: string; mergeSha?: string | null }): void {
  const at = new Date().toISOString();
  getDatabase()
    .prepare(
      `INSERT INTO jobs (id, project_cwd, feature_id, title, status, base_branch, merge_sha, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'done', 'main', ?, ?, ?)`
    )
    .run(row.id, repo, row.featureId, row.title, row.mergeSha ?? null, at, at);
  getDatabase().prepare(`INSERT INTO job_stages (job_id, name, status) VALUES (?, 'merge', 'passed')`).run(row.id);
}

const deps = (refusal: string | null = null) => ({
  liveSessions: () => [] as { id: string; cwd: string }[],
  terminateSession: vi.fn(async () => true),
  removeSessions: vi.fn(async () => undefined),
  factoryCancelRefusal: vi.fn((_cwd: string, _featureId: string) => refusal),
  cancelFactoryUnit: vi.fn(async (cwd: string, featureId: string) => {
    const track = factory.getItem(cwd, featureId)?.trackName;
    for (const i of factory.listItems({ projectCwd: cwd }).filter((x) => x.trackName === track)) {
      factory.updateItem(cwd, i.featureId, { status: 'cancelled' });
    }
  }),
});

async function planAndRun(choices: { revert?: string[]; deleteSpecs?: string[] } = {}, d = deps()) {
  const plan = await planTrackDelete(project(), 'Alpha', []);
  const result = await executeTrackDelete(
    project(),
    'Alpha',
    {
      token: plan.token,
      revert: choices.revert ?? plan.merges.map((m) => m.sha),
      deleteSpecs: choices.deleteSpecs ?? plan.specs.filter((s) => s.defaultDelete).map((s) => s.path),
    },
    d
  );
  return { plan, result, deps: d };
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
  getDatabase().exec('DELETE FROM track_branches; DELETE FROM job_stages; DELETE FROM jobs; DELETE FROM factory_items;');
  repo = mkdtempSync(join(tmpdir(), 'cr-tdel-repo-'));
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'config', 'user.email', 'test@example.com');
  git(repo, 'config', 'user.name', 'Test');
  git(repo, 'config', 'commit.gpgsign', 'false');
  writeFileSync(join(repo, 'PROJECT.md'), DOC);
  mkdirSync(join(repo, 'project'));
  writeFileSync(join(repo, 'project', 'alpha.md'), '# Alpha\n');
  writeFileSync(join(repo, 'shared.ts'), 'line 1\nline 2\nline 3\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-q', '-m', 'plan');
});

afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
});

describe('a track that was branched but never landed', () => {
  it('removes the branch, worktree and uncommitted edits, and leaves main untouched', async () => {
    const t = await tracks.ensureTrackBranch(project(), 'Alpha');
    commitFile(t.worktreePath, 'src/a.ts', 'export const a = 1;\n', 'work');
    writeFileSync(join(t.worktreePath, 'wip.ts'), 'unsaved\n');
    const headBefore = git(repo, 'rev-parse', 'HEAD');

    const { plan, result } = await planAndRun({ deleteSpecs: [] });

    expect(plan.branch).toMatchObject({ name: t.branch, uncommittedFiles: 1 });
    expect(plan.merges).toEqual([]);
    expect(existsSync(t.worktreePath)).toBe(false);
    expect(git(repo, 'branch', '--list', t.branch)).toBe('');
    expect(tracks.listTrackBranches(repo)).toEqual([]);
    expect(git(repo, 'rev-parse', 'HEAD')).toBe(headBefore);
    expect(result.committed).toBeNull();
    expect(readFileSync(join(repo, 'PROJECT.md'), 'utf-8')).not.toContain('Alpha');
    expect(readFileSync(join(repo, 'PROJECT.md'), 'utf-8')).toContain('## Track: Beta');
  });

  it("removes the track's peer notes folder with it", async () => {
    const t = await tracks.ensureTrackBranch(project(), 'Alpha');
    const notes = peerNotesDirFor(t.id);
    mkdirSync(notes, { recursive: true });
    writeFileSync(join(notes, 'ledger.md'), 'F1 open\n');
    await planAndRun({ deleteSpecs: [] });
    expect(existsSync(notes)).toBe(false);
  });
});

describe('a landed track', () => {
  it('reverts the land in one commit and keeps later unrelated work', async () => {
    const t = await tracks.ensureTrackBranch(project(), 'Alpha');
    commitFile(t.worktreePath, 'src/a.ts', 'export const a = 1;\n', 'work');
    const landed = await tracks.landTrack(project(), 'Alpha', NO_SESSIONS);
    commitFile(repo, 'later.ts', 'unrelated\n', 'later work');
    const beforeDelete = git(repo, 'rev-parse', 'HEAD');

    const { plan, result } = await planAndRun();

    expect(plan.merges.map((m) => [m.sha, m.via])).toEqual([[landed.mergeSha, 'track']]);
    expect(result.committed).not.toBeNull();
    expect(git(repo, 'log', '-1', '--format=%s')).toBe('Delete track: Alpha');
    expect(git(repo, 'rev-parse', 'HEAD~1')).toBe(beforeDelete);
    expect(existsSync(join(repo, 'src', 'a.ts'))).toBe(false);
    expect(existsSync(join(repo, 'later.ts'))).toBe(true);
    expect(existsSync(join(repo, 'project', 'alpha.md'))).toBe(false);
    expect(readFileSync(join(repo, 'PROJECT.md'), 'utf-8')).not.toContain('Alpha');
    expect(git(repo, 'status', '--porcelain')).toBe('');
  });

  it('reverts only the land, not a job merged into the track branch before it', async () => {
    const t = await tracks.ensureTrackBranch(project(), 'Alpha');
    mergeLikeAJob('First step', 'src/first.ts', { jobId: 'job-in-track', featureId: 'f-aaaaaa' }, t.worktreePath);
    const landed = await tracks.landTrack(project(), 'Alpha', NO_SESSIONS);

    const { plan, result } = await planAndRun();

    expect(plan.merges.map((m) => [m.sha, m.via])).toEqual([[landed.mergeSha, 'track']]);
    expect(existsSync(join(repo, 'src', 'first.ts'))).toBe(false);
    expect(result.reverted).toEqual([landed.mergeSha]);
  });

  it('changes nothing when the revert conflicts, and names the file', async () => {
    const t = await tracks.ensureTrackBranch(project(), 'Alpha');
    commitFile(t.worktreePath, 'shared.ts', 'line 1\nline 2 by the track\nline 3\n', 'work');
    await tracks.landTrack(project(), 'Alpha', NO_SESSIONS);
    commitFile(repo, 'shared.ts', 'line 1\nline 2 rewritten later\nline 3\n', 'later edit');
    const head = git(repo, 'rev-parse', 'HEAD');
    const docBefore = readFileSync(join(repo, 'PROJECT.md'), 'utf-8');
    const d = deps();

    await expect(planAndRun({}, d)).rejects.toMatchObject({ status: 409, conflicts: ['shared.ts'] });

    expect(git(repo, 'rev-parse', 'HEAD')).toBe(head);
    expect(git(repo, 'status', '--porcelain')).toBe('');
    expect(readFileSync(join(repo, 'PROJECT.md'), 'utf-8')).toBe(docBefore);
    expect(tracks.listTrackBranches(repo)).toHaveLength(1);
  });
});

describe('factory units of the track', () => {
  it('cancels the track unit before the revert, and leaves other tracks alone', async () => {
    factory.createItem({ projectCwd: repo, featureId: 'f-aaaaaa', trackName: 'Alpha', workflow: 'track' });
    factory.createItem({ projectCwd: repo, featureId: 'f-bbbbbb', trackName: 'Alpha', workflow: 'track' });
    factory.createItem({ projectCwd: repo, featureId: 'f-cccccc', trackName: 'Beta', workflow: 'track' });

    const { plan, result, deps: d } = await planAndRun();

    expect(plan.cancel.map((u) => u.unitId)).toEqual(['track:Alpha']);
    expect(d.cancelFactoryUnit).toHaveBeenCalledTimes(1);
    expect(result.cancelled).toBe(1);
    expect(factory.getItem(repo, 'f-bbbbbb')?.status).toBe('cancelled');
    expect(factory.getItem(repo, 'f-cccccc')?.status).toBe('open');
  });

  it('refuses before cancelling or reverting anything when a unit cannot be cancelled', async () => {
    const sha = mergeLikeAJob('First step', 'src/first.ts', { jobId: 'job-1', featureId: 'f-aaaaaa' });
    factory.createItem({ projectCwd: repo, featureId: 'f-bbbbbb', trackName: 'Alpha', workflow: 'track' });
    const d = deps('the terminal session "x" (s-1) holds "Alpha"');

    await expect(planAndRun({}, d)).rejects.toMatchObject({ status: 409 });
    expect(d.cancelFactoryUnit).not.toHaveBeenCalled();
    expect(git(repo, 'rev-parse', 'HEAD')).toBe(sha);
  });

  it('reverts a factory merge, found by its Feature trailers', async () => {
    git(repo, 'checkout', '-q', '-b', 'factory/alpha');
    commitFile(repo, 'src/alpha.ts', 'export const a = 1;\n', 'feature work');
    git(repo, 'checkout', '-q', 'main');
    git(
      repo,
      'merge',
      '-q',
      '--no-ff',
      'factory/alpha',
      ...multiFeatureMergeMessageArgs('Alpha', { jobId: 'mq-1', featureIds: ['f-aaaaaa', 'f-bbbbbb'] })
    );
    const sha = git(repo, 'rev-parse', 'HEAD');

    const { plan, result } = await planAndRun();

    expect(plan.merges.map((m) => [m.sha, m.via])).toEqual([[sha, 'trailer']]);
    expect(result.reverted).toEqual([sha]);
    expect(existsSync(join(repo, 'src', 'alpha.ts'))).toBe(false);
  });
});

describe('old jobs merged straight into main', () => {
  it('reverts an old job by its recorded merge sha', async () => {
    const sha = mergeLikeAJob('First step', 'src/first.ts');
    oldJob({ id: 'job-done', featureId: 'f-aaaaaa', title: 'First step', mergeSha: sha });

    const { plan, result } = await planAndRun();

    expect(plan.merges).toMatchObject([{ sha, via: 'job' }]);
    expect(existsSync(join(repo, 'src', 'first.ts'))).toBe(false);
    expect(result.reverted).toEqual([sha]);
  });

  it('finds a discarded job’s merge by its exact message, newest first', async () => {
    const first = mergeLikeAJob('First step', 'src/first.ts');
    const second = mergeLikeAJob('Second step', 'src/second.ts');

    const plan = await planTrackDelete(project(), 'Alpha', []);

    expect(plan.merges.map((m) => [m.sha, m.via])).toEqual([
      [second, 'message'],
      [first, 'message'],
    ]);
  });

  it('refuses to guess when two merges share a message', async () => {
    mergeLikeAJob('First step', 'src/one.ts');
    mergeLikeAJob('First step', 'src/two.ts');

    const plan = await planTrackDelete(project(), 'Alpha', []);

    expect(plan.merges).toEqual([]);
    expect(plan.unresolved).toMatchObject([{ title: 'First step' }]);
  });

  it('finds a discarded job’s merge by its feature trailer, even when another track’s job shares the title', async () => {
    const ours = mergeLikeAJob('First step', 'src/ours.ts', { jobId: 'job-gone', featureId: 'f-aaaaaa' });
    mergeLikeAJob('First step', 'src/theirs.ts', { jobId: 'job-other', featureId: 'f-cccccc' });

    const plan = await planTrackDelete(project(), 'Alpha', []);

    expect(plan.merges.map((m) => [m.sha, m.via])).toEqual([[ours, 'trailer']]);
    expect(plan.unresolved).toEqual([]);
  });

  it('finds an old job whose row has no sha by its job id trailer', async () => {
    oldJob({ id: 'job-nosha', featureId: 'f-aaaaaa', title: 'First step' });
    const sha = mergeLikeAJob('First step', 'src/first.ts', { jobId: 'job-nosha', featureId: 'f-aaaaaa' });

    const plan = await planTrackDelete(project(), 'Alpha', []);

    expect(plan.merges.map((m) => [m.sha, m.via])).toEqual([[sha, 'trailer']]);
  });

  it('never matches a merge that carries a trailer by its message alone', async () => {
    // Beta's feature, same title as Alpha's: its trailer says whose it is.
    mergeLikeAJob('First step', 'src/beta.ts', { jobId: 'job-beta', featureId: 'f-cccccc' });

    const plan = await planTrackDelete(project(), 'Alpha', []);

    expect(plan.merges).toEqual([]);
    expect(plan.unresolved).toEqual([]);
  });

  it('refuses before touching anything when a revert meets a dirty checkout', async () => {
    mergeLikeAJob('First step', 'src/first.ts');
    factory.createItem({ projectCwd: repo, featureId: 'f-bbbbbb', trackName: 'Alpha', workflow: 'track' });
    writeFileSync(join(repo, 'dirty.ts'), 'wip\n');
    const d = deps();

    await expect(planAndRun({}, d)).rejects.toMatchObject({ status: 409 });
    expect(d.cancelFactoryUnit).not.toHaveBeenCalled();
    expect(existsSync(join(repo, 'src', 'first.ts'))).toBe(true);
  });
});

describe('the spec rule', () => {
  const specOf = async () => (await planTrackDelete(project(), 'Alpha', [])).specs[0];

  it('deletes a committed, clean spec by default', async () => {
    expect(await specOf()).toMatchObject({ state: 'committed', defaultDelete: true, offered: true });
  });

  it('keeps a committed spec with local edits, offered unticked', async () => {
    writeFileSync(join(repo, 'project', 'alpha.md'), '# Alpha\n\nedited\n');
    expect(await specOf()).toMatchObject({ state: 'edited', defaultDelete: false, offered: true });
  });

  it('deletes a never-committed spec when the whole plan is a draft', async () => {
    git(repo, 'rm', '-q', '--cached', 'project/alpha.md');
    writeFileSync(join(repo, 'PROJECT.md'), '## Track: Beta\n- [ ] `f-cccccc` Unrelated\n');
    git(repo, 'commit', '-q', '-am', 'plan without Alpha');
    writeFileSync(join(repo, 'PROJECT.md'), DOC);
    expect(await specOf()).toMatchObject({ state: 'draft', defaultDelete: true });
  });

  it('keeps a never-committed spec written after the committed lines', async () => {
    git(repo, 'rm', '-q', '--cached', 'project/alpha.md');
    git(repo, 'commit', '-q', '-m', 'untrack the spec');
    expect(await specOf()).toMatchObject({ state: 'late-draft', defaultDelete: false, offered: true });
  });

  it('never offers a spec another track still references', async () => {
    writeFileSync(
      join(repo, 'PROJECT.md'),
      DOC.replace('- [ ] `f-cccccc` Unrelated', '- [ ] `f-cccccc` Unrelated → project/alpha.md')
    );
    const spec = await specOf();
    expect(spec).toMatchObject({ offered: false, defaultDelete: false });
    expect(spec.referencedBy).toEqual(['f-cccccc in "Beta"']);
  });
});

describe('staleness and the session log', () => {
  it('refuses a stale plan and changes nothing', async () => {
    const plan = await planTrackDelete(project(), 'Alpha', []);
    commitFile(repo, 'moved.ts', 'x\n', 'HEAD moved');

    await expect(
      executeTrackDelete(project(), 'Alpha', { token: plan.token, revert: [], deleteSpecs: [] }, deps())
    ).rejects.toMatchObject({ status: 409 });
    expect(readFileSync(join(repo, 'PROJECT.md'), 'utf-8')).toContain('Alpha');
  });

  it('removes the track’s SESSION-LOG phase group and no other', async () => {
    writeFileSync(
      join(repo, 'SESSION-LOG.md'),
      [
        '# Session Log',
        '',
        '<!-- claude-remote-phases',
        '[',
        '  { "group": "Alpha", "source": "PROJECT.md", "items": [',
        '    { "id": "f-aaaaaa", "title": "First step", "status": "pending", "sessionIds": [] }',
        '  ]},',
        '  { "group": "Beta", "source": "PROJECT.md", "items": [',
        '    { "id": "f-cccccc", "title": "Unrelated", "status": "pending", "sessionIds": [] }',
        '  ]}',
        ']',
        '-->',
        '',
      ].join('\n')
    );

    const { plan } = await planAndRun({ deleteSpecs: [] });

    expect(plan.sessionLogGroup).toBe(true);
    const log = readFileSync(join(repo, 'SESSION-LOG.md'), 'utf-8');
    expect(log).not.toContain('"Alpha"');
    expect(log).toContain('"Beta"');
  });

  it('says code on main is not attributed for a track that never had a branch', async () => {
    writeFileSync(join(repo, 'src.ts'), 'written on main\n');
    const plan = await planTrackDelete(project(), 'Alpha', []);
    expect(plan.unattributed).toEqual({ dirtyFiles: 1 });
  });
});
