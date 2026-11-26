import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import { execFileSync } from 'child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

// Real repositories: every git spawn costs ~50-100ms on Windows.
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

/**
 * Intake of loose work and triage (project/code-factory.md, f-wlr5dc): the
 * intake reply's strict parsing (bullets as requirements, mixed asks, the
 * mockup flag, garbage refused), Inbox lines with server-generated ids
 * committed through a temporary index, order hints as inferred edges, and
 * discovered work through triage. The intake model is a fake; no claude runs.
 */

const dataDir = mkdtempSync(join(tmpdir(), 'cr-factory-intake-data-'));
const configPath = join(dataDir, 'config.json');
writeFileSync(configPath, JSON.stringify({ persistence: { dataDir } }));
process.env.CLAUDE_REMOTE_CONFIG = configPath;

const { loadConfig } = await import('../src/server/config.js');
const { initDatabase, closeDatabase, getDatabase } = await import('../src/server/db/schema.js');
const intake = await import('../src/server/factory/intake.js');
const triage = await import('../src/server/factory/triage.js');
const store = await import('../src/server/factory/store.js');
const { getIntake } = await import('../src/server/factory/intake-store.js');
const { parseProjectDoc, findFeature } = await import('../src/server/projects/project-doc-format.js');

const DOC = `## Track: Alpha
- [ ] \`f-aaaaaa\` Existing work
`;

let repo: string;

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8' }).trim();
}

const headDoc = () => parseProjectDoc(git(repo, 'show', 'HEAD:PROJECT.md'));
const workingDoc = () => parseProjectDoc(readFileSync(join(repo, 'PROJECT.md'), 'utf-8'));
const project = () => ({ cwd: repo });

/** A fake intake model answering `reply`, recording what it was asked. */
function model(reply: string) {
  const asked: string[] = [];
  return { asked, deps: { ask: async (_cwd: string, prompt: string) => (asked.push(prompt), reply) } };
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
  getDatabase().exec('DELETE FROM track_branches; DELETE FROM factory_intake; DELETE FROM factory_deps; DELETE FROM factory_items');
  repo = mkdtempSync(join(tmpdir(), 'cr-factory-intake-repo-'));
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'config', 'user.email', 'test@example.com');
  git(repo, 'config', 'user.name', 'Test');
  git(repo, 'config', 'commit.gpgsign', 'false');
  writeFileSync(join(repo, 'PROJECT.md'), DOC);
  writeFileSync(join(repo, 'code.ts'), 'one\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-q', '-m', 'plan');
});

afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
});

describe('parseIntakeReply', () => {
  it('keeps bullets as requirements of their ask, not features', () => {
    const reply = JSON.stringify({
      features: [{ title: 'Dark mode toggle', requirements: ['remember per device', 'follow the OS by default'], mockupFirst: false }],
    });
    expect(intake.parseIntakeReply(reply)).toEqual([
      {
        title: 'Dark mode toggle',
        requirements: ['remember per device', 'follow the OS by default'],
        mockupFirst: false,
        priority: null,
        after: [],
      },
    ]);
  });

  it('splits mixed asks, carries the mockup flag and the order, and accepts a closing json fence', () => {
    const body = {
      features: [
        { title: 'Settings page', requirements: [], mockupFirst: true, priority: 1 },
        { title: '  Sort  sessions\nby activity ', requirements: ['newest first'], mockupFirst: false, after: [0] },
      ],
    };
    const parsed = intake.parseIntakeReply(`Here it is:\n\`\`\`json\n${JSON.stringify(body)}\n\`\`\``);
    expect(parsed).toHaveLength(2);
    expect(parsed?.[0]).toMatchObject({ title: 'Settings page', mockupFirst: true, priority: 1 });
    expect(parsed?.[1]).toMatchObject({ title: 'Sort sessions by activity', requirements: ['newest first'], after: [0] });
  });

  it('refuses garbage, an empty list and every malformed field', () => {
    const bad = [
      'Sure! I would add a dark mode.',
      '{"features": []}',
      '{"features": [{"title": ""}]}',
      '{"features": [{"title": "x", "requirements": "one"}]}',
      '{"features": [{"title": "x", "mockupFirst": "yes"}]}',
      '{"features": [{"title": "x", "priority": 7}]}',
      '{"features": [{"title": "x", "after": [0]}]}',
      '{"features": [{"title": "x", "after": [3]}]}',
      // A sample shape quoted mid-reply is not the answer.
      '```json\n{"features": [{"title": "x"}]}\n```\nand then some prose',
    ];
    for (const reply of bad) expect(intake.parseIntakeReply(reply), reply).toBeNull();
  });
});

describe('addWork', () => {
  it('files each feature as an Inbox line with a fresh id, committed through a temporary index', async () => {
    // Something the user staged must stay staged and out of the commit.
    writeFileSync(join(repo, 'code.ts'), 'two\n');
    git(repo, 'add', 'code.ts');
    const { deps, asked } = model(
      JSON.stringify({
        features: [
          { title: 'Dark mode toggle', requirements: ['remember per device'], mockupFirst: true },
          { title: 'Sort sessions by activity', requirements: [], mockupFirst: false },
        ],
      })
    );
    const result = await intake.addWork({ project: project(), text: 'dark mode (mockup first)\n- remember per device\nsort sessions' }, deps);

    expect(asked[0]).toContain('=== REQUEST ===\ndark mode (mockup first)');
    expect(result.features.map((f) => f.title)).toEqual(['Dark mode toggle', 'Sort sessions by activity']);
    expect(result.features[0]).toMatchObject({ requirements: ['remember per device'], mockupFirst: true });
    const ids = result.features.map((f) => f.featureId);
    for (const id of ids) expect(id).toMatch(/^f-[a-z0-9]{6}$/);
    expect(new Set([...ids, 'f-aaaaaa']).size).toBe(3);

    for (const doc of [headDoc(), workingDoc()]) {
      const inbox = doc.tracks.find((t) => t.name === 'Inbox');
      expect(inbox, 'Inbox section').toBeTruthy();
      expect(findFeature(doc, ids[0])?.feature.title).toBe('Dark mode toggle');
      expect(findFeature(doc, 'f-aaaaaa')).toBeTruthy();
    }
    expect(git(repo, 'log', '-1', '--format=%s')).toBe('plan: file 2 features in Inbox');
    expect(git(repo, 'show', '--name-only', '--format=', 'HEAD')).toBe('PROJECT.md');
    expect(git(repo, 'diff', '--cached', '--name-only')).toBe('code.ts');

    const items = ids.map((id) => store.getItem(repo, id));
    expect(items.map((i) => [i?.status, i?.workflow, i?.trackName])).toEqual([
      ['open', 'item', 'Inbox'],
      ['open', 'item', 'Inbox'],
    ]);
    expect(getIntake(repo, ids[0])).toMatchObject({ source: 'intake', requirements: ['remember per device'], mockupFirst: true });
    expect(result.order).toEqual([]);
  });

  it('keeps uncommitted edits of the working copy beside the new lines', async () => {
    writeFileSync(join(repo, 'PROJECT.md'), `${DOC}- [ ] \`f-bbbbbb\` Written by hand, not committed\n`);
    const { deps } = model(JSON.stringify({ features: [{ title: 'One thing' }] }));
    const { features } = await intake.addWork({ project: project(), text: 'one thing' }, deps);
    expect(findFeature(workingDoc(), 'f-bbbbbb')).toBeTruthy();
    expect(findFeature(workingDoc(), features[0].featureId)).toBeTruthy();
    expect(findFeature(headDoc(), 'f-bbbbbb')).toBeNull();
    expect(findFeature(headDoc(), features[0].featureId)).toBeTruthy();
  });

  it('turns the order the text gives into inferred blocks edges', async () => {
    const { deps } = model(JSON.stringify({ features: [{ title: 'Schema' }, { title: 'API on it', after: [0] }] }));
    const { features, order } = await intake.addWork({ project: project(), text: 'schema, then the API' }, deps);
    const [a, b] = features.map((f) => f.featureId);
    expect(order).toEqual([{ waits: b, for: a, reason: 'the request puts it after "Schema"' }]);
    expect(store.listDependencies(repo)).toMatchObject([{ fromFeature: b, toFeature: a, type: 'blocks', inferred: true }]);
    expect(store.readyItems(repo).map((i) => i.featureId)).toEqual([a]);
  });

  it('files into a named track instead of the Inbox', async () => {
    const { deps } = model(JSON.stringify({ features: [{ title: 'More alpha' }] }));
    const { features } = await intake.addWork({ project: project(), text: 'more alpha', track: 'Alpha' }, deps);
    expect(findFeature(headDoc(), features[0].featureId)?.track.name).toBe('Alpha');
    expect(store.getItem(repo, features[0].featureId)?.trackName).toBe('Alpha');
  });

  it('refuses text with no work in it without writing anything', async () => {
    const before = git(repo, 'rev-parse', 'HEAD');
    for (const reply of ['{"features": []}', 'I am not sure what you mean.']) {
      const { deps } = model(reply);
      await expect(intake.addWork({ project: project(), text: 'hello?' }, deps)).rejects.toMatchObject({ status: 422 });
    }
    expect(git(repo, 'rev-parse', 'HEAD')).toBe(before);
    expect(readFileSync(join(repo, 'PROJECT.md'), 'utf-8')).toBe(DOC);
    expect(store.listItems({ projectCwd: repo })).toEqual([]);
  });

  it('checks the text and the track before asking the model', async () => {
    const { deps, asked } = model('{}');
    await expect(intake.addWork({ project: project(), text: '  ' }, deps)).rejects.toMatchObject({ status: 400 });
    await expect(intake.addWork({ project: project(), text: 'x'.repeat(intake.MAX_INTAKE_CHARS + 1) }, deps)).rejects.toMatchObject({ status: 400 });
    await expect(intake.addWork({ project: project(), text: 'x', track: 'a\nb' }, deps)).rejects.toMatchObject({ status: 400 });
    await expect(intake.addWork({ project: project(), text: 'x', discoveredFrom: ['f-zzzzzz'] }, deps)).rejects.toMatchObject({ status: 404 });
    expect(asked).toEqual([]);
  });

  it('files work a session discovered into triage, with discovered-from edges', async () => {
    store.createItem({ projectCwd: repo, featureId: 'f-aaaaaa', trackName: 'Alpha', workflow: 'item' });
    const { deps } = model(JSON.stringify({ features: [{ title: 'Flaky test in sessions' }] }));
    const { features } = await intake.addWork({ project: project(), text: 'the sessions test is flaky', discoveredFrom: ['f-aaaaaa'] }, deps);
    const id = features[0].featureId;
    expect(store.getItem(repo, id)).toMatchObject({ status: 'triage', step: 'triage' });
    expect(getIntake(repo, id)?.source).toBe('discovered');
    expect(store.listDependencies(repo, id)).toMatchObject([{ fromFeature: id, toFeature: 'f-aaaaaa', type: 'discovered-from' }]);
    // Never ready until accepted.
    expect(store.readyItems(repo).map((i) => i.featureId)).toEqual(['f-aaaaaa']);
  });
});

describe('discovered work and triage', () => {
  it('parses fenced discovered blocks, dropping invalid entries and duplicates', () => {
    const text = `Done.\n\`\`\`discovered\n[{"title": "Fix the  footer", "detail": "seen in app.ts"}, {"title": ""}, 7, {"title": "fix the footer"}]\n\`\`\`\n\`\`\`discovered\nnot json\n\`\`\``;
    expect(triage.parseDiscovered(text)).toEqual([{ title: 'Fix the footer', detail: 'seen in app.ts' }]);
    expect(triage.parseDiscovered('no blocks here')).toEqual([]);
  });

  it('files discovered work as triage items once, then accept / backlog / dismiss settle them', async () => {
    store.createItem({ projectCwd: repo, featureId: 'f-aaaaaa', trackName: 'Alpha', workflow: 'item' });
    const work = [
      { title: 'Footer overlaps', detail: 'app.ts:12' },
      { title: 'Missing test', detail: null },
      { title: 'Dead code', detail: null },
    ];
    const ids = await triage.fileDiscovered(project(), 'f-aaaaaa', work);
    expect(ids).toHaveLength(3);
    // A step that re-runs files nothing twice.
    expect(await triage.fileDiscovered(project(), 'f-aaaaaa', work)).toEqual([]);
    for (const id of ids) {
      expect(store.getItem(repo, id)).toMatchObject({ status: 'triage', step: 'triage' });
      expect(findFeature(headDoc(), id)?.track.name).toBe('Inbox');
    }
    expect(getIntake(repo, ids[0])?.detail).toBe('app.ts:12');

    const accepted = await triage.triageItem(project(), ids[0], 'accept');
    expect(accepted.item).toMatchObject({ status: 'open', step: null });
    expect(store.readyItems(repo).map((i) => i.featureId)).toContain(ids[0]);

    await triage.triageItem(project(), ids[1], 'backlog');
    expect(store.getItem(repo, ids[1])).toBeNull();
    expect(findFeature(headDoc(), ids[1])).toBeTruthy();

    await triage.triageItem(project(), ids[2], 'dismiss');
    expect(store.getItem(repo, ids[2])?.status).toBe('cancelled');
    expect(findFeature(headDoc(), ids[2])).toBeNull();
    expect(findFeature(workingDoc(), ids[2])).toBeNull();

    await expect(triage.triageItem(project(), ids[0], 'accept')).rejects.toMatchObject({ status: 409 });
    await expect(triage.triageItem(project(), 'f-nonexist', 'accept')).rejects.toMatchObject({ status: 404 });
    await expect(triage.triageItem(project(), ids[0], 'maybe')).rejects.toMatchObject({ status: 400 });
  });

  it('caps what one step files', async () => {
    const work = Array.from({ length: 8 }, (_, i) => ({ title: `Thing ${i}`, detail: null }));
    expect(await triage.fileDiscovered(project(), 'f-aaaaaa', work)).toHaveLength(triage.MAX_DISCOVERED_PER_STEP);
  });
});
