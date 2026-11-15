import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, unlinkSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  loadMirrorManifest,
  mirrorTargets,
  saveMirrorManifest,
  syncRegistryMirrors,
  type MirrorManifest,
} from '../src/server/sessions/registry-mirror.js';
import { readClaudeNames } from '../src/server/sessions/claude-registry.js';

describe('syncRegistryMirrors', () => {
  let root: string;
  let work: string;
  let personal: string;
  let manifest: MirrorManifest;
  let alive: Set<number>;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'cr-registry-mirror-'));
    work = join(root, 'work', 'sessions');
    personal = join(root, 'personal', 'sessions');
    mkdirSync(work, { recursive: true });
    mkdirSync(personal, { recursive: true });
    manifest = {};
    alive = new Set();
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  const entry = (dir: string, pid: number, name: string) => {
    writeFileSync(join(dir, `${pid}.json`), JSON.stringify({ pid, sessionId: `s-${pid}`, name }));
    writeFileSync(join(dir, `${pid}.abc${pid}.key`), `key-${pid}`);
    alive.add(pid);
  };
  const sync = (enabled = true) =>
    syncRegistryMirrors({ dirs: [work, personal], enabled, isAlive: (pid) => alive.has(pid), manifest });
  const list = (dir: string) => readdirSync(dir).sort();

  it('copies each live entry, json and key, into the other folder both ways', () => {
    entry(work, 10, 'work-a');
    entry(personal, 20, 'personal-a');
    const { changed } = sync();
    expect(changed).toBe(true);
    expect(list(work)).toEqual(['10.abc10.key', '10.json', '20.abc20.key', '20.json']);
    expect(list(personal)).toEqual(list(work));
    expect(readFileSync(join(personal, '10.abc10.key'), 'utf8')).toBe('key-10');
    expect(Object.keys(manifest)).toHaveLength(4);
  });

  it('never copies a copy on, and a second pass changes nothing', () => {
    entry(work, 10, 'work-a');
    sync();
    expect(sync().changed).toBe(false);
    expect(list(work)).toEqual(['10.abc10.key', '10.json']);
  });

  it('refreshes a copy when its source changes', () => {
    entry(work, 10, 'old');
    sync();
    writeFileSync(join(work, '10.json'), JSON.stringify({ pid: 10, sessionId: 's-10', name: 'renamed' }));
    expect(sync().changed).toBe(true);
    expect(JSON.parse(readFileSync(join(personal, '10.json'), 'utf8')).name).toBe('renamed');
  });

  it('removes copies when the source goes, the pid dies, or the setting is off', () => {
    entry(work, 10, 'a');
    entry(work, 11, 'b');
    entry(work, 12, 'c');
    sync();
    unlinkSync(join(work, '10.json'));
    unlinkSync(join(work, '10.abc10.key'));
    alive.delete(11);
    sync();
    expect(list(personal)).toEqual(['12.abc12.key', '12.json']);
    sync(false);
    expect(list(personal)).toEqual([]);
    expect(manifest).toEqual({});
    expect(list(work)).toEqual(['11.abc11.key', '11.json', '12.abc12.key', '12.json']); // originals untouched
  });

  it('never overwrites a file it did not write', () => {
    entry(work, 10, 'work-a');
    writeFileSync(join(personal, '10.json'), 'a stale entry of the personal login');
    sync();
    expect(readFileSync(join(personal, '10.json'), 'utf8')).toBe('a stale entry of the personal login');
    sync(false);
    expect(existsSync(join(personal, '10.json'))).toBe(true);
  });

  it('leaves a copy alone once someone else rewrote it (a reused pid)', () => {
    entry(work, 10, 'work-a');
    sync();
    writeFileSync(join(personal, '10.json'), JSON.stringify({ pid: 10, sessionId: 'theirs', name: 'personal-b' }));
    sync(false);
    expect(JSON.parse(readFileSync(join(personal, '10.json'), 'utf8')).name).toBe('personal-b');
    expect(Object.keys(manifest).some((t) => t.endsWith('10.json'))).toBe(false);
  });

  it('copies again a copy Claude deleted', () => {
    entry(work, 10, 'work-a');
    sync();
    unlinkSync(join(personal, '10.json'));
    sync();
    expect(existsSync(join(personal, '10.json'))).toBe(true);
  });

  it('does nothing with a single folder, and ignores files that are not entries', () => {
    entry(work, 10, 'a');
    writeFileSync(join(work, 'notes.txt'), 'x');
    syncRegistryMirrors({ dirs: [work, work], enabled: true, isAlive: () => true, manifest });
    expect(manifest).toEqual({});
    sync();
    expect(existsSync(join(personal, 'notes.txt'))).toBe(false);
  });

  it('round-trips the manifest, and a crash-left copy is removed on the next boot', () => {
    entry(work, 10, 'a');
    sync();
    const path = join(root, 'registry-mirrors.json');
    saveMirrorManifest(path, manifest);
    manifest = loadMirrorManifest(path);
    expect(Object.keys(manifest)).toHaveLength(2);
    sync(false);
    expect(list(personal)).toEqual([]);
    expect(loadMirrorManifest(join(root, 'missing.json'))).toEqual({});
  });

  it('reading names skips the copies', () => {
    entry(work, 10, 'work-a');
    sync();
    writeFileSync(join(work, '10.json'), JSON.stringify({ pid: 10, sessionId: 's-10', name: 'renamed' }));
    const names = readClaudeNames([personal, work], () => true, mirrorTargets(manifest));
    expect(Object.fromEntries(names)).toEqual({ 's-10': 'renamed' });
  });
});
