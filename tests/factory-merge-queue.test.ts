import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import { execFileSync } from 'child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import Fastify, { type FastifyInstance } from 'fastify';

// Real repositories: every git spawn costs ~50-100ms on Windows.
vi.setConfig({ testTimeout: 120_000, hookTimeout: 60_000 });

/**
 * The factory's merge queue (project/code-factory.md, f-f8x9yu) against real
 * repositories: one slot per project, the merge with its trailers and sha,
 * the PROJECT.md tick, conflict -> resolver -> re-verify, a parked entry with
 * both sides named, the dirty-main hold, and a session's Land queueing behind
 * a factory merge. Verification, the resolver agent and the session manager
 * are fakes; no claude is ever spawned.
 */

const dataDir = mkdtempSync(join(tmpdir(), 'cr-merge-queue-data-'));
const configPath = join(dataDir, 'config.json');
writeFileSync(configPath, JSON.stringify({ persistence: { dataDir } }));
process.env.CLAUDE_REMOTE_CONFIG = configPath;

const { loadConfig } = await import('../src/server/config.js');
const { initDatabase, closeDatabase, getDatabase } = await import('../src/server/db/schema.js');
const queue = await import('../src/server/factory/merge-queue.js');
const { getMerge } = await import('../src/server/factory/merge-queue-store.js');
const factory = await import('../src/server/factory/store.js');
const { ensureTrackBranch } = await import('../src/server/projects/track-branches.js');
const { landTrack } = await import('../src/server/projects/track-land-core.js');
const { withProjectLock } = await import('../src/server/projects/project-lock.js');
const api = await import('../src/server/agent/sessions-api.js');
const { sessionEnv, sessionForToken } = await import('../src/server/sessions/session-env.js');
type MergeConflict = import('../src/server/projects/track-update.js').MergeConflict;
type LandNotificationPayload = import('../src/server/websocket/protocol.js').LandNotificationPayload;
type SessionMetadata = import('../src/server/sessions/types.js').SessionMetadata;

const DOC = `## Track: Alpha
- [ ] \`f-aaaaaa\` First step
- [ ] \`f-bbbbbb\` Second step

## Track: Beta
- [ ] \`f-cccccc\` Unrelated
`;

let repo: string;
let scratch: string;
/** What verification saw, in order. */
let verified: string[];
let verify: (cwd: string) => Promise<{ ok: boolean; detail: string }>;
let resolve: (conflict: MergeConflict) => Promise<void>;
let resolved: MergeConflict[];

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8' }).trim();
}

/** A file's text with line endings as committed (a checkout may write CRLF). */
function text(path: string): string {
  return readFileSync(path, 'utf-8').replace(/\r\n/g, '\n');
}

/** Real git on a loaded machine: far past waitFor's 1s default. */
function waitFor(check: () => void): Promise<void> {
  return vi.waitFor(check, { timeout: 30_000, interval: 50 });
}

function commitFile(cwd: string, rel: string, content: string, message: string): void {
  mkdirSync(join(cwd, rel, '..'), { recursive: true });
  writeFileSync(join(cwd, rel), content);
  git(cwd, 'add', '--', rel);
  git(cwd, 'commit', '-q', '-m', message);
}

/** A factory item's branch and worktree, branched from main, with one commit. */
function itemWorktree(name: string, file: string, content: string): { branch: string; worktreePath: string } {
  const branch = `factory/${name}`;
  const worktreePath = join(scratch, name);
  git(repo, 'worktree', 'add', '-q', '-b', branch, worktreePath, 'main');
  commitFile(worktreePath, file, content, `work on ${name}`);
  return { branch, worktreePath };
}

function entry(item: { branch: string; worktreePath: string }, featureIds: string[]) {
  return {
    projectCwd: repo,
    kind: 'item' as const,
    branch: item.branch,
    worktreePath: item.worktreePath,
    baseBranch: 'main',
    featureIds,
    trackName: 'Alpha',
  };
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
  getDatabase().exec('DELETE FROM track_branches; DELETE FROM factory_merges; DELETE FROM factory_deps; DELETE FROM factory_items');
  repo = mkdtempSync(join(tmpdir(), 'cr-merge-queue-repo-'));
  scratch = mkdtempSync(join(tmpdir(), 'cr-merge-queue-wt-'));
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'config', 'user.email', 'test@example.com');
  git(repo, 'config', 'user.name', 'Test');
  git(repo, 'config', 'commit.gpgsign', 'false');
  writeFileSync(join(repo, 'PROJECT.md'), DOC);
  writeFileSync(join(repo, 'shared.ts'), 'one\ntwo\nthree\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-q', '-m', 'plan');

  verified = [];
  resolved = [];
  verify = async (cwd) => {
    verified.push(cwd);
    return { ok: true, detail: 'fake checks passed' };
  };
  resolve = async () => {};
  queue.configureMergeQueue({
    verify: (cwd) => verify(cwd),
    resolve: async (conflict) => {
      resolved.push(conflict);
      await resolve(conflict);
    },
    build: async () => ({ ran: false, ok: true, detail: 'no build script' }),
    project: (cwd) => ({ cwd }),
    holdPollMs: 50,
    busyRetryMs: 50,
  });
});

afterEach(async () => {
  // A test that failed mid-merge leaves its entry running: let it finish
  // before the repository goes, so it never writes into the next test's rows.
  await waitFor(() => expect(queue.mergeQueueBusy(repo)).toBeNull()).catch(() => undefined);
  queue.resetMergeQueue();
  rmSync(repo, { recursive: true, force: true });
  rmSync(scratch, { recursive: true, force: true });
});

const mainLog = () => git(repo, 'log', '--first-parent', '--format=%s', 'main').split('\n');

describe('one slot per project', () => {
  it('never runs two entries at once, and merges them in order', async () => {
    const a = itemWorktree('a', 'a.ts', 'a\n');
    const b = itemWorktree('b', 'b.ts', 'b\n');
    let inFlight = 0;
    let maxInFlight = 0;
    let releaseA!: () => void;
    const gateA = new Promise<void>((r) => (releaseA = r));
    verify = async (cwd) => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      verified.push(cwd);
      if (cwd === a.worktreePath) await gateA;
      inFlight--;
      return { ok: true, detail: 'ok' };
    };

    const first = queue.enqueueMerge(entry(a, ['f-aaaaaa']));
    const second = queue.enqueueMerge(entry(b, ['f-bbbbbb']));
    expect(first.position).toBe(0);
    expect(second.position).toBe(1);
    expect(queue.mergeQueueBusy(repo)).toMatch(/2 merges in the merge queue/);

    await waitFor(() => expect(verified).toEqual([a.worktreePath]));
    // A is held in verification: B has not started.
    await new Promise((r) => setTimeout(r, 200));
    expect(verified).toEqual([a.worktreePath]);
    expect(getMerge(second.id)?.status).toBe('queued');
    releaseA();

    const [oa, ob] = await Promise.all([first.done, second.done]);
    expect(oa.status).toBe('merged');
    expect(ob.status).toBe('merged');
    expect(maxInFlight).toBe(1);
    // B updated onto main after A merged, so it was verified against A's merge.
    expect(verified).toEqual([a.worktreePath, b.worktreePath]);
    const merges = mainLog().filter((s) => s.startsWith('Merge job:'));
    expect(merges).toEqual(['Merge job: Second step', 'Merge job: First step']);
    expect(queue.mergeQueueBusy(repo)).toBeNull();
  });
});

describe('enqueueMerge is idempotent per (project, branch)', () => {
  const rows = () => getDatabase().prepare('SELECT id, status FROM factory_merges').all() as { id: string; status: string }[];

  it('a second enqueue while queued or merging returns the same ticket, and merges once', async () => {
    const a = itemWorktree('a', 'a.ts', 'a\n');
    const first = queue.enqueueMerge(entry(a, ['f-aaaaaa']));
    const again = queue.enqueueMerge(entry(a, ['f-aaaaaa']));
    expect(again.id).toBe(first.id);
    expect(again.done).toBe(first.done);
    expect(rows()).toHaveLength(1);
    expect((await first.done).status).toBe('merged');
    // Merged: still the same entry, never a second merge.
    const later = queue.enqueueMerge(entry(a, ['f-aaaaaa']));
    expect(later.id).toBe(first.id);
    expect((await later.done).status).toBe('merged');
    expect(rows()).toHaveLength(1);
    expect(mainLog().filter((s) => s.startsWith('Merge job:'))).toEqual(['Merge job: First step']);
  });

  it('a parked entry answers with its outcome, even after a restart, and runs again only through requeueMerge', async () => {
    const a = itemWorktree('a', 'a.ts', 'a\n');
    verify = async () => ({ ok: false, detail: 'red' });
    const first = queue.enqueueMerge(entry(a, ['f-aaaaaa']));
    expect((await first.done).status).toBe('parked');

    queue.resetMergeQueue(); // the server restarts: nothing in memory
    queue.configureMergeQueue({ verify: (cwd) => verify(cwd), project: (cwd) => ({ cwd }), holdPollMs: 50, busyRetryMs: 50 });
    const again = queue.enqueueMerge(entry(a, ['f-aaaaaa']));
    expect(again.id).toBe(first.id);
    const outcome = await again.done;
    expect(outcome.status).toBe('parked');
    expect(outcome.detail).toMatch(/Verification failed.*red/);
    expect(rows()).toHaveLength(1);

    verify = async () => ({ ok: true, detail: 'green' });
    const retried = queue.requeueMerge(first.id)!;
    expect(retried.id).toBe(first.id);
    expect((await retried.done).status).toBe('merged');
    expect(rows()).toEqual([{ id: first.id, status: 'merged' }]);
  });

  it('an entry a restart left queued runs again under its own row', async () => {
    const a = itemWorktree('a', 'a.ts', 'a\n');
    const { insertMerge } = await import('../src/server/factory/merge-queue-store.js');
    const orphan = insertMerge(entry(a, ['f-aaaaaa']));
    const ticket = queue.enqueueMerge(entry(a, ['f-aaaaaa']));
    expect(ticket.id).toBe(orphan.id);
    expect((await ticket.done).status).toBe('merged');
    expect(rows()).toEqual([{ id: orphan.id, status: 'merged' }]);
  });

  it('never dedupes a Land: a refused Land can be landed again', async () => {
    await ensureTrackBranch({ cwd: repo }, 'Alpha');
    let refuse = true;
    queue.configureMergeQueue({
      land: async (project, name) => {
        if (refuse) throw new (await import('../src/server/projects/track-branches.js')).TrackBranchError('not yet', 409);
        return {
          ...(await landTrack(project, name, { sessions: [], terminateSession: async () => {}, removeSessions: async () => {} })),
          build: { ran: false, ok: true, detail: 'no build script' },
        };
      },
    });
    await expect(queue.queueLand({ cwd: repo }, 'Alpha').result).rejects.toMatchObject({ status: 409, message: 'not yet' });
    refuse = false;
    expect((await queue.queueLand({ cwd: repo }, 'Alpha').result).mergeSha).toBeTruthy();
    expect(rows()).toHaveLength(2);
  });
});

describe('a merge', () => {
  it('carries the Job-Id/Feature trailers, records merge_sha, ticks PROJECT.md without git add, and marks items done', async () => {
    for (const id of ['f-aaaaaa', 'f-bbbbbb']) {
      factory.createItem({ projectCwd: repo, featureId: id, trackName: 'Alpha', workflow: 'track' });
    }
    const a = itemWorktree('a', 'a.ts', 'a\n');
    // The user's uncommitted backlog edit on main, and a staged-elsewhere-free index.
    writeFileSync(join(repo, 'PROJECT.md'), `${DOC}\n## Track: Backlog\n- [ ] Someday\n`);

    const ticket = queue.enqueueMerge(entry(a, ['f-aaaaaa', 'f-bbbbbb']));
    const outcome = await ticket.done;
    expect(outcome.status).toBe('merged');

    const record = getMerge(ticket.id)!;
    expect(record.status).toBe('merged');
    expect(record.mergeSha).toBe(outcome.mergeSha);
    const body = git(repo, 'log', '-1', '--format=%B', outcome.mergeSha!);
    expect(body).toMatch(/^Merge job: First step \(\+1 more\)/);
    expect(body).toContain(`Job-Id: ${ticket.id}`);
    expect(body).toContain('Feature: f-aaaaaa');
    expect(body).toContain('Feature: f-bbbbbb');
    expect(git(repo, 'rev-list', '--parents', '-n', '1', outcome.mergeSha!).split(' ')).toHaveLength(3);

    // The tick is its own commit on top of the merge, and the working copy keeps the user's edit.
    expect(git(repo, 'rev-parse', 'HEAD~1')).toBe(outcome.mergeSha);
    const committed = git(repo, 'show', 'HEAD:PROJECT.md');
    expect(committed).toContain('- [x] `f-aaaaaa` First step');
    expect(committed).toContain('- [x] `f-bbbbbb` Second step');
    expect(committed).not.toContain('Someday');
    const working = text(join(repo, 'PROJECT.md'));
    expect(working).toContain('- [x] `f-aaaaaa` First step');
    expect(working).toContain('Someday');
    // Nothing was staged: the backlog edit is still only in the working copy.
    expect(git(repo, 'diff', '--cached', '--name-only')).toBe('');
    expect(git(repo, 'status', '--porcelain')).toBe('M PROJECT.md');

    expect(factory.getItem(repo, 'f-aaaaaa')?.status).toBe('done');
    expect(factory.getItem(repo, 'f-bbbbbb')?.status).toBe('done');
    expect(existsSync(join(repo, 'a.ts'))).toBe(true);
  });

  it('parks on failed verification and never merges a red result', async () => {
    factory.createItem({ projectCwd: repo, featureId: 'f-aaaaaa', trackName: 'Alpha', workflow: 'track' });
    const a = itemWorktree('a', 'a.ts', 'a\n');
    const head = git(repo, 'rev-parse', 'HEAD');
    verify = async () => ({ ok: false, detail: 'npm test: 1 failed' });

    const outcome = await queue.enqueueMerge(entry(a, ['f-aaaaaa'])).done;
    expect(outcome.status).toBe('parked');
    expect(outcome.detail).toMatch(/Verification failed.*npm test: 1 failed/);
    expect(git(repo, 'rev-parse', 'HEAD')).toBe(head);
    expect(factory.getItem(repo, 'f-aaaaaa')?.status).toBe('parked');
  });
});

describe('conflicts', () => {
  /** An item and main that both changed shared.ts's middle line. */
  function conflicting() {
    const a = itemWorktree('a', 'shared.ts', 'one\nTWO from the item\nthree\n');
    commitFile(repo, 'shared.ts', 'one\nTWO from main\nthree\n', 'main moves on');
    return a;
  }

  it('go to the resolver in the item worktree, then are re-verified before the merge', async () => {
    const a = conflicting();
    const events: string[] = [];
    resolve = async (c) => {
      events.push('resolve');
      writeFileSync(join(c.cwd, 'shared.ts'), 'one\nTWO from both\nthree\n');
    };
    verify = async (cwd) => {
      events.push('verify');
      // Verification sees the resolved merge.
      expect(text(join(cwd, 'shared.ts'))).toBe('one\nTWO from both\nthree\n');
      return { ok: true, detail: 'ok' };
    };

    const outcome = await queue.enqueueMerge(entry(a, ['f-aaaaaa'])).done;
    expect(outcome.status, outcome.detail).toBe('merged');
    expect(events).toEqual(['resolve', 'verify']);
    expect(resolved[0]).toMatchObject({
      cwd: a.worktreePath,
      paths: ['shared.ts'],
      ours: { branch: 'factory/a' },
      theirs: { branch: 'main' },
    });
    expect(text(join(repo, 'shared.ts'))).toBe('one\nTWO from both\nthree\n');
  });

  it('the resolver cannot settle park the entry with both sides named and the worktree as it was', async () => {
    factory.createItem({ projectCwd: repo, featureId: 'f-aaaaaa', trackName: 'Alpha', workflow: 'track' });
    const a = conflicting();
    const itemHead = git(a.worktreePath, 'rev-parse', 'HEAD');
    const mainHead = git(repo, 'rev-parse', 'HEAD');
    // The resolver gives up: the markers stay.

    const ticket = queue.enqueueMerge(entry(a, ['f-aaaaaa']));
    const outcome = await ticket.done;
    expect(outcome.status).toBe('parked');
    expect(verified).toEqual([]);
    expect(outcome.conflict).toEqual({
      paths: ['shared.ts'],
      ours: { branch: 'factory/a', sha: itemHead },
      theirs: { branch: 'main', sha: mainHead },
    });
    expect(outcome.detail).toContain(`Merging main (${mainHead.slice(0, 7)}) into factory/a (${itemHead.slice(0, 7)})`);
    expect(outcome.detail).toMatch(/conflicts in shared\.ts/);
    expect(getMerge(ticket.id)?.conflict?.paths).toEqual(['shared.ts']);
    // Nothing merged, the item worktree back where it was, not mid-merge.
    expect(git(repo, 'rev-parse', 'HEAD')).toBe(mainHead);
    expect(git(a.worktreePath, 'rev-parse', 'HEAD')).toBe(itemHead);
    expect(git(a.worktreePath, 'status', '--porcelain')).toBe('');
    expect(factory.getItem(repo, 'f-aaaaaa')?.status).toBe('parked');
  });

  it('a session Land that would conflict is updated from main through the resolver, verified, then landed', async () => {
    const track = await ensureTrackBranch({ cwd: repo }, 'Alpha');
    commitFile(track.worktreePath, 'shared.ts', 'one\nTWO from the track\nthree\n', 'track work');
    commitFile(repo, 'shared.ts', 'one\nTWO from main\nthree\n', 'main moves on');
    resolve = async (c) => writeFileSync(join(c.cwd, 'shared.ts'), 'one\nTWO from both\nthree\n');
    queue.configureMergeQueue({
      land: async (project, name) => ({
        ...(await landTrack(project, name, { sessions: [], terminateSession: async () => {}, removeSessions: async () => {} })),
        build: { ran: false, ok: true, detail: 'no build script' },
      }),
    });

    const landed = await queue.queueLand({ cwd: repo }, 'Alpha').result;
    expect(landed.mergeSha).toBeTruthy();
    expect(resolved).toHaveLength(1);
    expect(resolved[0]).toMatchObject({ paths: ['shared.ts'], ours: { branch: track.branch }, theirs: { branch: 'main' } });
    expect(verified).toEqual([track.worktreePath]);
    expect(text(join(repo, 'shared.ts'))).toBe('one\nTWO from both\nthree\n');
    expect(mainLog()[0]).toBe('Merge track: Alpha');
  });
});

describe('the resolver never holds the project lock', () => {
  it('another track operation takes the lock while a track’s conflict is being resolved, and the track worktree stays untouched', async () => {
    const track = await ensureTrackBranch({ cwd: repo }, 'Alpha');
    commitFile(track.worktreePath, 'shared.ts', 'one\nTWO from the track\nthree\n', 'track work');
    commitFile(repo, 'shared.ts', 'one\nTWO from main\nthree\n', 'main moves on');
    const trackHead = git(track.worktreePath, 'rev-parse', 'HEAD');
    let started!: () => void;
    const resolving = new Promise<void>((r) => (started = r));
    let finish!: () => void;
    const gate = new Promise<void>((r) => (finish = r));
    resolve = async (c) => {
      started();
      await gate;
      writeFileSync(join(c.cwd, 'shared.ts'), 'one\nTWO from both\nthree\n');
    };
    queue.configureMergeQueue({
      land: async (project, name) => ({
        ...(await landTrack(project, name, { sessions: [], terminateSession: async () => {}, removeSessions: async () => {} })),
        build: { ran: false, ok: true, detail: 'no build script' },
      }),
    });

    const landing = queue.queueLand({ cwd: repo }, 'Alpha').result;
    await resolving;
    // A Delete or Branch now right now is not refused with "This project is busy".
    await expect(withProjectLock(repo, 'Branch now', async () => 'took it')).resolves.toBe('took it');
    // The resolver works in a scratch checkout: the track's worktree is not mid-merge.
    expect(resolved[0].cwd).not.toBe(track.worktreePath);
    expect(git(track.worktreePath, 'rev-parse', 'HEAD')).toBe(trackHead);
    expect(existsSync(join(track.worktreePath, '.git'))).toBe(true);
    expect(() => git(track.worktreePath, 'rev-parse', '-q', '--verify', 'MERGE_HEAD')).toThrow();
    expect(git(track.worktreePath, 'status', '--porcelain')).toBe('');

    finish();
    const landed = await landing;
    expect(landed.mergeSha).toBeTruthy();
    expect(text(join(repo, 'shared.ts'))).toBe('one\nTWO from both\nthree\n');
    // The scratch checkout is gone.
    expect(existsSync(resolved[0].cwd)).toBe(false);
    expect(git(repo, 'worktree', 'list').split('\n')).toHaveLength(1);
  });

  it('an item’s conflict is resolved in its own worktree with the lock free', async () => {
    const a = itemWorktree('a', 'shared.ts', 'one\nTWO from the item\nthree\n');
    commitFile(repo, 'shared.ts', 'one\nTWO from main\nthree\n', 'main moves on');
    let started!: () => void;
    const resolving = new Promise<void>((r) => (started = r));
    let finish!: () => void;
    const gate = new Promise<void>((r) => (finish = r));
    resolve = async (c) => {
      started();
      await gate;
      writeFileSync(join(c.cwd, 'shared.ts'), 'one\nTWO from both\nthree\n');
    };
    const ticket = queue.enqueueMerge(entry(a, ['f-aaaaaa']));
    await resolving;
    await expect(withProjectLock(repo, 'Delete track', async () => 'took it')).resolves.toBe('took it');
    finish();
    expect((await ticket.done).status).toBe('merged');
  });
});

describe('resume at boot', () => {
  it('re-runs entries a stopped server left queued or running, in order, a Land included, under their rows', async () => {
    const { insertMerge, updateMerge } = await import('../src/server/factory/merge-queue-store.js');
    const notifiedLands: LandNotificationPayload[] = [];
    queue.configureMergeQueue({
      notifyLand: (p) => notifiedLands.push(p),
      land: async (project, name) => ({
        ...(await landTrack(project, name, { sessions: [], terminateSession: async () => {}, removeSessions: async () => {} })),
        build: { ran: false, ok: true, detail: 'no build script' },
      }),
    });
    const track = await ensureTrackBranch({ cwd: repo }, 'Alpha');
    commitFile(track.worktreePath, 'alpha.ts', 'alpha\n', 'track work');
    // An item the last server was merging: its worktree was left mid-merge.
    const a = itemWorktree('a', 'shared.ts', 'one\nTWO from the item\nthree\n');
    commitFile(repo, 'shared.ts', 'one\nTWO from main\nthree\n', 'main moves on');
    expect(() => git(a.worktreePath, 'merge', '--no-commit', 'main')).toThrow(); // stops on the conflict
    expect(git(a.worktreePath, 'rev-parse', '-q', '--verify', 'MERGE_HEAD')).toBeTruthy();
    const item = insertMerge({ ...entry(a, ['f-cccccc']), trackName: 'Beta' });
    updateMerge(item.id, { status: 'running' });
    // A session's Land answered "queued" behind it.
    const land = insertMerge({
      projectCwd: repo,
      kind: 'session-land',
      branch: track.branch,
      worktreePath: track.worktreePath,
      baseBranch: 'main',
      featureIds: [],
      trackName: 'Alpha',
    });
    resolve = async (c) => writeFileSync(join(c.cwd, 'shared.ts'), 'one\nTWO from both\nthree\n');

    // Never on an isolated boot or under vitest.
    expect(await queue.resumeMergeQueues({ CLAUDE_REMOTE_CONFIG: 'x' })).toEqual([]);
    expect(await queue.resumeMergeQueues()).toEqual([]);
    expect(await queue.resumeMergeQueues({})).toEqual([item.id, land.id]);

    await waitFor(() => expect(notifiedLands).toHaveLength(1));
    expect(notifiedLands[0]).toMatchObject({ kind: 'land', track: 'Alpha', ok: true });
    expect(getMerge(item.id)?.status).toBe('merged');
    expect(getMerge(land.id)?.status).toBe('merged');
    const log = mainLog();
    expect(log.indexOf('Merge track: Alpha')).toBeLessThan(log.indexOf('Merge job: Unrelated'));
    expect(text(join(repo, 'shared.ts'))).toBe('one\nTWO from both\nthree\n');
  });
});

describe('the dirty-main hold', () => {
  it('holds while main has uncommitted code and merges once it is clean', async () => {
    const a = itemWorktree('a', 'a.ts', 'a\n');
    writeFileSync(join(repo, 'wip.ts'), 'the user is typing\n');
    const head = git(repo, 'rev-parse', 'HEAD');

    const ticket = queue.enqueueMerge(entry(a, ['f-aaaaaa']));
    await waitFor(() => expect(getMerge(ticket.id)?.status).toBe('holding'));
    expect(getMerge(ticket.id)?.detail ?? '').toMatch(/uncommitted changes \(wip\.ts\)/);
    await new Promise((r) => setTimeout(r, 200));
    expect(getMerge(ticket.id)?.status).toBe('holding');
    expect(git(repo, 'rev-parse', 'HEAD')).toBe(head);
    expect(verified).toEqual([]);

    rmSync(join(repo, 'wip.ts'));
    queue.kickMergeQueue(repo);
    const outcome = await ticket.done;
    expect(outcome.status).toBe('merged');
    expect(mainLog()).toContain('Merge job: First step');
  });

  it('holds while main has a staged file, even a planning one', async () => {
    const a = itemWorktree('a', 'a.ts', 'a\n');
    writeFileSync(join(repo, 'PROJECT.md'), `${DOC}\n`);
    git(repo, 'add', 'PROJECT.md');
    const ticket = queue.enqueueMerge(entry(a, ['f-aaaaaa']));
    await waitFor(() => expect(getMerge(ticket.id)?.detail ?? '').toMatch(/staged files \(PROJECT\.md\)/));
    git(repo, 'reset', '-q');
    expect((await ticket.done).status).toBe('merged');
  });

  it('waits for a busy project lock instead of failing', async () => {
    const a = itemWorktree('a', 'a.ts', 'a\n');
    let release!: () => void;
    const held = withProjectLock(repo, 'deleting "Beta"', () => new Promise<void>((r) => (release = r)));
    const ticket = queue.enqueueMerge(entry(a, ['f-aaaaaa']));
    await waitFor(() => expect(getMerge(ticket.id)?.detail ?? '').toMatch(/busy \(deleting "Beta"\)/));
    release();
    await held;
    expect((await ticket.done).status).toBe('merged');
  });
});

describe('a session’s Land joins the queue', () => {
  const CALLER = '22222222-2222-4222-8222-222222222222';
  let app: FastifyInstance;
  let notified: LandNotificationPayload[];
  let sessions: Map<string, Partial<SessionMetadata> & { id: string; cwd: string }>;
  let events: string[];

  beforeEach(async () => {
    notified = [];
    events = [];
    sessions = new Map();
    queue.configureMergeQueue({
      land: async (project, name) => {
        events.push('land');
        return {
          ...(await landTrack(project, name, {
            sessions: [...sessions.values()].map((s) => ({ id: s.id, cwd: s.cwd })),
            terminateSession: async (id) => {
              sessions.delete(id);
            },
            removeSessions: async () => undefined,
          })),
          build: { ran: false, ok: true, detail: 'no build script' },
        };
      },
    });
    // The real phase 1 and the real queue (defaultLandDeps.land is queueLand);
    // only the session table and the notifier are fakes.
    const landDeps: import('../src/server/agent/sessions-api.js').AgentLandDeps = {
      ...api.defaultLandDeps,
      getSession: (id) => (sessions.get(id) as SessionMetadata | undefined) ?? null,
      listSessions: () => [...sessions.values()].map((s) => ({ id: s.id, cwd: s.cwd, spawnedBy: s.spawnedBy ?? null })),
      projectForCwd: () => ({ cwd: repo }),
      notify: (payload) => notified.push(payload),
    };
    app = Fastify({ logger: false });
    api.registerAgentSessionRoutes(app, { ...api.defaultDeps, sessionForToken }, landDeps);
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
  });

  it('is accepted (202) behind a factory merge in progress, instead of a 409, and lands after it', async () => {
    const track = await ensureTrackBranch({ cwd: repo }, 'Alpha');
    commitFile(track.worktreePath, 'alpha.ts', 'alpha\n', 'track work');
    sessions.set(CALLER, { id: CALLER, cwd: track.worktreePath, spawnedBy: null });
    const item = itemWorktree('c', 'c.ts', 'c\n');
    let releaseItem!: () => void;
    const gate = new Promise<void>((r) => (releaseItem = r));
    verify = async (cwd) => {
      events.push(`verify ${cwd === item.worktreePath ? 'item' : 'track'}`);
      if (cwd === item.worktreePath) await gate;
      return { ok: true, detail: 'ok' };
    };
    const factoryMerge = queue.enqueueMerge({ ...entry(item, ['f-cccccc']), trackName: 'Beta' });
    await waitFor(() => expect(events).toEqual(['verify item']));

    const res = await app.inject({
      method: 'POST',
      url: '/api/agent/land',
      remoteAddress: '127.0.0.1',
      headers: { authorization: `Bearer ${sessionEnv(CALLER).CLAUDE_REMOTE_TOKEN}` },
    });
    expect(res.statusCode, res.body).toBe(202);
    expect(res.json().queuedBehind).toMatch(/1 merge in the merge queue \(now: factory\/c into main\)/);
    expect(res.json().detail).toMatch(/queued behind/);
    // Nothing lands while the factory merge holds the slot.
    await new Promise((r) => setTimeout(r, 300));
    expect(events).toEqual(['verify item']);
    expect(notified).toEqual([]);

    releaseItem();
    expect((await factoryMerge.done).status).toBe('merged');
    await vi.waitFor(() => expect(notified).toHaveLength(1), { timeout: 20_000, interval: 100 });
    expect(notified[0]).toMatchObject({ kind: 'land', track: 'Alpha', ok: true });
    // The session's Land had nothing to resolve, so no re-verification.
    expect(events).toEqual(['verify item', 'land']);
    const log = mainLog();
    expect(log.indexOf('Merge track: Alpha')).toBeLessThan(log.indexOf('Merge job: Unrelated'));
    expect(existsSync(join(repo, 'alpha.ts'))).toBe(true);
    expect(existsSync(join(repo, 'c.ts'))).toBe(true);
  });

  it('keeps Land’s refusals when the queue is idle (409 in phase 1)', async () => {
    const track = await ensureTrackBranch({ cwd: repo }, 'Alpha');
    sessions.set(CALLER, { id: CALLER, cwd: track.worktreePath, spawnedBy: null });
    writeFileSync(join(track.worktreePath, 'loose.ts'), 'uncommitted\n');
    const res = await app.inject({
      method: 'POST',
      url: '/api/agent/land',
      remoteAddress: '127.0.0.1',
      headers: { authorization: `Bearer ${sessionEnv(CALLER).CLAUDE_REMOTE_TOKEN}` },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toMatch(/uncommitted changes.*loose\.ts/);
  });
});
