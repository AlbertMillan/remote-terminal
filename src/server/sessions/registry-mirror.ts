/**
 * Cross-account messaging (project/cross-account-messaging.md, docs/accounts.md): each
 * `claude` finds the peers it can `SendMessage` in its own config folder's live registry
 * (`<configDir>/sessions/<pid>.json` + `<pid>.<hash>.key`), so with
 * `sessions.crossAccountMessaging` on, every live entry is copied into every other
 * account's folder. The messaging socket is a machine-local pipe, so the copy is all a
 * Claude on another login needs.
 *
 * The folders belong to Claude Code, which writes its own entries there: this module only
 * ever replaces or deletes a file it wrote, and only while the file still holds what it
 * wrote (the manifest keeps a hash). A pid that a Claude of the target account reuses
 * overwrites our copy, and that file is then theirs. Every failure degrades to "no copy",
 * never a throw.
 */
import { createHash } from 'crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'fs';
import { basename, dirname, join, resolve } from 'path';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('registry-mirror');

/** Copy path → where it came from and the hash of what was written. */
export type MirrorManifest = Record<string, { source: string; hash: string }>;

export interface MirrorDeps {
  /** Every account's registry folder, each once. */
  dirs: string[];
  enabled: boolean;
  isAlive: (pid: number) => boolean;
  manifest: MirrorManifest;
}

const ENTRY = /^(\d+)\.(json|[^.]+\.key)$/;

function hashOf(data: Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

function readOrNull(path: string): Buffer | null {
  try {
    return readFileSync(path);
  } catch {
    return null;
  }
}

/** Path comparison that ignores Windows' case and separator differences. */
function keyOf(path: string): string {
  const full = resolve(path);
  return process.platform === 'win32' ? full.toLowerCase() : full;
}

/** Our copy is still what we wrote: anything else is someone else's file now. */
function stillOurs(path: string, hash: string): boolean {
  const data = readOrNull(path);
  return data !== null && hashOf(data) === hash;
}

function writeAtomically(path: string, data: Buffer): void {
  // A dot-name Claude never parses as an entry; rename makes the copy appear whole.
  const tmp = join(dirname(path), `.${basename(path)}.cr-mirror`);
  writeFileSync(tmp, data);
  renameSync(tmp, path);
}

/**
 * One pass: copy every live original into every other folder, refresh copies whose source
 * changed, and delete copies whose source is gone, whose pid is dead, or all of them when
 * `enabled` is off. Mutates and returns `manifest`; `changed` says whether to save it.
 */
export function syncRegistryMirrors(deps: MirrorDeps): { manifest: MirrorManifest; changed: boolean } {
  const { manifest, isAlive } = deps;
  const dirs = [...new Map(deps.dirs.map((d) => [keyOf(d), d])).values()];
  let changed = false;
  const ours = new Set(Object.keys(manifest).map(keyOf));

  // Copy path → source path, for every copy that should exist.
  const wanted = new Map<string, { target: string; source: string }>();
  if (deps.enabled && dirs.length > 1) {
    for (const dir of dirs) {
      let files: string[];
      try {
        files = readdirSync(dir);
      } catch {
        continue;
      }
      const alive = new Map<number, boolean>();
      for (const file of files) {
        const match = ENTRY.exec(file);
        if (!match) continue;
        const source = join(dir, file);
        if (ours.has(keyOf(source))) continue; // a copy is never copied on
        const pid = Number(match[1]);
        if (!alive.has(pid)) alive.set(pid, isAlive(pid));
        if (!alive.get(pid)) continue;
        for (const other of dirs) {
          if (other === dir) continue;
          const target = join(other, file);
          wanted.set(keyOf(target), { target, source });
        }
      }
    }
  }

  // Drop copies no longer wanted, or no longer ours.
  for (const [target, record] of Object.entries(manifest)) {
    const want = wanted.get(keyOf(target));
    if (want && keyOf(want.source) === keyOf(record.source)) continue;
    if (stillOurs(target, record.hash)) {
      try {
        unlinkSync(target);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
          logger.warn({ error, target }, 'registry-mirror: could not remove a copy; will retry');
          continue;
        }
      }
    }
    delete manifest[target];
    changed = true;
  }

  // Make or refresh the wanted ones.
  const recorded = new Map(Object.keys(manifest).map((t) => [keyOf(t), t]));
  for (const { target, source } of wanted.values()) {
    const data = readOrNull(source);
    if (!data) continue; // the source went between the listing and now
    const hash = hashOf(data);
    const known = recorded.get(keyOf(target));
    if (known !== undefined) {
      const record = manifest[known];
      if (record.hash === hash && existsSync(target)) continue;
      if (existsSync(target) && !stillOurs(target, record.hash)) {
        // Rewritten by someone else (a Claude reusing the pid): theirs now.
        delete manifest[known];
        changed = true;
        continue;
      }
    } else if (existsSync(target)) {
      continue; // a file we didn't write: never overwrite it
    }
    try {
      mkdirSync(dirname(target), { recursive: true });
      writeAtomically(target, data);
      if (known !== undefined && known !== target) delete manifest[known];
      manifest[target] = { source, hash };
      changed = true;
    } catch (error) {
      logger.warn({ error, target }, 'registry-mirror: could not copy an entry');
    }
  }
  return { manifest, changed };
}

/** Every copy's path, to skip when reading names. */
export function mirrorTargets(manifest: MirrorManifest): Set<string> {
  return new Set(Object.keys(manifest).map(keyOf));
}

export function isMirrorTarget(targets: Set<string>, path: string): boolean {
  return targets.has(keyOf(path));
}

export function loadMirrorManifest(path: string): MirrorManifest {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const manifest: MirrorManifest = {};
    for (const [target, record] of Object.entries(parsed as Record<string, unknown>)) {
      const r = record as { source?: unknown; hash?: unknown } | null;
      if (r && typeof r.source === 'string' && typeof r.hash === 'string') manifest[target] = { source: r.source, hash: r.hash };
    }
    return manifest;
  } catch {
    return {};
  }
}

export function saveMirrorManifest(path: string, manifest: MirrorManifest): void {
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeAtomically(path, Buffer.from(JSON.stringify(manifest, null, 2)));
  } catch (error) {
    // Unsaved, a crash would leave copies the next boot can't name; they go stale with
    // their pid and Claude ignores dead entries.
    logger.warn({ error, path }, 'registry-mirror: could not save the manifest');
  }
}
