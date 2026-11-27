import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import { execFileSync } from 'child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

// Real repositories: git spawns are slow on Windows, more so under a loaded run.
vi.setConfig({ testTimeout: 60_000 });

/**
 * Land and Update of a track wait for the factory (factory/track-work.ts): refused (409,
 * naming the unit) while an item of the track runs under an agent's claim or a factory
 * merge of it is queued, holding or running; let through when the unit is parked,
 * cancelled, done or held by a terminal session, and for the queue's own entry.
 */

const dataDir = mkdtempSync(join(tmpdir(), 'cr-track-fwork-data-'));
const configPath = join(dataDir, 'config.json');
writeFileSync(configPath, JSON.stringify({ persistence: { dataDir } }));
process.env.CLAUDE_REMOTE_CONFIG = configPath;

const { loadConfig } = await import('../src/server/config.js');
const { initDatabase, closeDatabase, getDatabase } = await import('../src/server/db/schema.js');
const tracks = {
  ...(await import('../src/server/projects/track-branches.js')),
  ...(await import('../src/server/projects/track-land-core.js')),
  ...(await import('../src/server/projects/track-update.js')),
};
const store = await import('../src/server/factory/store.js');
const mergeStore = await import('../src/server/factory/merge-queue-store.js');
const { sessionOwner } = await import('../src/server/factory/session-claims.js');

const DOC = `## Track: Alpha
- [ ] \`f-aaaaaa\` First step → project/alpha.md
- [ ] \`f-bbbbbb\` Second step → project/alpha.md
`;

let repo: string;
const project = () => ({ cwd: repo });
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf-8' }).trim();
const NO_SESSIONS = { sessions: [], terminateSession: async () => true, removeSessions: async () => undefined };

beforeAll(() => {
  loadConfig();
  initDatabase();
});
afterAll(() => {
  closeDatabase();
  rmSync(dataDir, { recursive: true, force: true });
});

beforeEach(() => {
  getDatabase().exec('DELETE FROM track_branches; DELETE FROM factory_merges; DELETE FROM factory_runs; DELETE FROM factory_items');
  repo = mkdtempSync(join(tmpdir(), 'cr-track-fwork-repo-'));
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'config', 'user.email', 'test@example.com');
  git(repo, 'config', 'user.name', 'Test');
  git(repo, 'config', 'commit.gpgsign', 'false');
  writeFileSync(join(repo, 'PROJECT.md'), DOC);
  mkdirSync(join(repo, 'project'));
  writeFileSync(join(repo, 'project', 'alpha.md'), '# Alpha\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-q', '-m', 'plan');
});
afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
});

/** The track branched, with Alpha's two features in the factory as one track unit. */
async function branchedWithUnit() {
  const t = await tracks.ensureTrackBranch(project(), 'Alpha');
  store.createItem({ projectCwd: repo, featureId: 'f-aaaaaa', trackName: 'Alpha', workflow: 'track' });
  store.createItem({ projectCwd: repo, featureId: 'f-bbbbbb', trackName: 'Alpha', workflow: 'track' });
  return t;
}

const running = () => {
  const claim = store.claimItem(repo, 'f-aaaaaa', { owner: 'run:boot:1', kind: 'run' });
  expect(claim.ok).toBe(true);
  store.updateItem(repo, 'f-bbbbbb', { step: 'track-features' });
};

const queuedMerge = (t: { branch: string; worktreePath: string }) =>
  mergeStore.insertMerge({ projectCwd: repo, kind: 'track', branch: t.branch, worktreePath: t.worktreePath, baseBranch: 'main', featureIds: ['f-aaaaaa', 'f-bbbbbb'], trackName: 'Alpha' });

describe('Land waits for the factory', () => {
  it('is refused while an agent runs a unit of the track, naming it, and nothing is closed', async () => {
    await branchedWithUnit();
    running();
    const terminateSession = vi.fn(async () => true);
    await expect(tracks.landTrack(project(), 'Alpha', { ...NO_SESSIONS, terminateSession })).rejects.toMatchObject({
      status: 409,
      message: expect.stringContaining('f-aaaaaa (an agent is running'),
    });
    expect(terminateSession).not.toHaveBeenCalled();
    expect(tracks.listTrackBranches(repo)[0].landedAt).toBeNull();
  });

  it('is refused while a factory merge of the track is queued, holding or running', async () => {
    const t = await branchedWithUnit();
    const entry = queuedMerge(t);
    for (const status of ['queued', 'holding', 'running'] as const) {
      mergeStore.updateMerge(entry.id, { status });
      await expect(tracks.landPreflight(project(), 'Alpha')).rejects.toMatchObject({
        status: 409,
        message: expect.stringContaining(`(${status} in the merge queue)`),
      });
    }
  });

  it("never refuses the queue's own entry, the one whose Land is asking", async () => {
    const t = await branchedWithUnit();
    const entry = queuedMerge(t);
    mergeStore.updateMerge(entry.id, { status: 'running' });
    await expect(tracks.landPreflight(project(), 'Alpha', { ownMerge: entry.id })).resolves.toMatchObject({ track: { trackName: 'Alpha' } });
  });

  it('lets a parked, cancelled, done or session-held unit through, and a parked or merged merge entry', async () => {
    const t = await branchedWithUnit();
    const entry = queuedMerge(t);
    mergeStore.updateMerge(entry.id, { status: 'parked' });
    store.updateItem(repo, 'f-aaaaaa', { status: 'parked', step: 'review' });
    store.updateItem(repo, 'f-bbbbbb', { status: 'parked', step: 'review' });
    await expect(tracks.landPreflight(project(), 'Alpha')).resolves.toBeDefined();

    store.updateItem(repo, 'f-aaaaaa', { status: 'cancelled' });
    store.updateItem(repo, 'f-bbbbbb', { status: 'done' });
    mergeStore.updateMerge(entry.id, { status: 'merged' });
    await expect(tracks.landPreflight(project(), 'Alpha')).resolves.toBeDefined();

    store.updateItem(repo, 'f-aaaaaa', { status: 'open' });
    expect(store.claimForSession(repo, ['f-aaaaaa'], sessionOwner('s-1')).ok).toBe(true);
    await expect(tracks.landPreflight(project(), 'Alpha')).resolves.toBeDefined();
  });

  it("is not held back by another track's factory work", async () => {
    await branchedWithUnit();
    store.createItem({ projectCwd: repo, featureId: 'f-cccccc', trackName: 'Beta', workflow: 'track' });
    expect(store.claimItem(repo, 'f-cccccc', { owner: 'run:boot:2', kind: 'run' }).ok).toBe(true);
    await expect(tracks.landPreflight(project(), 'Alpha')).resolves.toBeDefined();
  });
});

describe('Update from main waits for the factory', () => {
  it('is refused while an agent runs a unit of the track, and while its merge is queued', async () => {
    const t = await branchedWithUnit();
    running();
    await expect(tracks.updateTrackFromMain(project(), 'Alpha')).rejects.toMatchObject({
      status: 409,
      message: expect.stringContaining('before you update the track'),
    });
    store.updateItem(repo, 'f-aaaaaa', { status: 'parked', step: 'review' });
    queuedMerge(t);
    await expect(tracks.updateTrackFromMain(project(), 'Alpha')).rejects.toMatchObject({
      status: 409,
      message: expect.stringContaining('queued in the merge queue'),
    });
  });

  it('goes ahead when the unit is parked, cancelled, done or held by a session', async () => {
    await branchedWithUnit();
    git(repo, 'commit', '-q', '--allow-empty', '-m', 'main moved');
    store.updateItem(repo, 'f-aaaaaa', { status: 'parked', step: 'review' });
    store.updateItem(repo, 'f-bbbbbb', { status: 'cancelled' });
    await expect(tracks.updateTrackFromMain(project(), 'Alpha')).resolves.toMatchObject({ mergeSha: expect.any(String) });

    store.updateItem(repo, 'f-aaaaaa', { status: 'done' });
    store.updateItem(repo, 'f-bbbbbb', { status: 'open' });
    expect(store.claimForSession(repo, ['f-bbbbbb'], sessionOwner('s-1')).ok).toBe(true);
    git(repo, 'commit', '-q', '--allow-empty', '-m', 'main moved again');
    await expect(tracks.updateTrackFromMain(project(), 'Alpha')).resolves.toMatchObject({ mergeSha: expect.any(String) });
  });
});
