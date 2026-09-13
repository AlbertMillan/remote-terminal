import { existsSync, readdirSync } from 'fs';
import { join } from 'path';

/**
 * Which version-control system backs a project directory. This decides how much
 * of the job pipeline a project can support:
 *
 *  - `git`     — full pipeline: worktree isolation, diff review, merge, push.
 *  - `none`    — no VCS at all. Dispatch git-inits the folder first so work is
 *                still isolated and revertible; nothing is ever pushed.
 *  - `plastic` — Plastic SCM workspace. `git worktree` has no equivalent here and
 *                laying a git repo over the workspace would have both systems
 *                tracking one tree, so dispatch is disabled until handled properly.
 */
export type VcsKind = 'git' | 'plastic' | 'none';

/** Marker files/dirs a Plastic SCM workspace keeps at its root. */
const PLASTIC_MARKERS = ['.plastic', 'plastic.workspace', '.plasticignore'];

function hasPlasticMarker(dir: string): boolean {
  if (PLASTIC_MARKERS.some((m) => existsSync(join(dir, m)))) return true;
  // Older/derived workspaces carry loose `*.conf` control files instead of a
  // single well-known marker (e.g. hidden_changes.conf, ignore.conf).
  try {
    const entries = readdirSync(dir);
    const confs = entries.filter((e) => e.endsWith('.conf'));
    return (
      confs.includes('hidden_changes.conf') ||
      (confs.includes('ignore.conf') && !entries.includes('.git'))
    );
  } catch {
    return false;
  }
}

/**
 * Detect the VCS backing `cwd`. Git wins when both are present: a git repo is
 * something we can isolate and revert, which is what the pipeline needs.
 */
export function detectVcs(cwd: string): VcsKind {
  try {
    if (existsSync(join(cwd, '.git'))) return 'git';
    if (hasPlasticMarker(cwd)) return 'plastic';
    return 'none';
  } catch {
    return 'none';
  }
}

/** What a project of this VCS kind is allowed to do. */
export interface VcsCapabilities {
  kind: VcsKind;
  canDispatch: boolean; // may run code-writing pipeline stages at all
  needsInit: boolean; // requires `git init` before the first dispatch
  canPush: boolean; // has (or can have) a remote to push to
  /** Human-readable reason shown as a board badge; null when fully capable. */
  note: string | null;
}

export function capabilitiesFor(kind: VcsKind): VcsCapabilities {
  switch (kind) {
    case 'git':
      return { kind, canDispatch: true, needsInit: false, canPush: true, note: null };
    case 'none':
      return {
        kind,
        canDispatch: true,
        needsInit: true,
        canPush: false,
        note: 'No repo — work is committed locally and never pushed.',
      };
    case 'plastic':
      return {
        kind,
        canDispatch: false,
        needsInit: false,
        canPush: false,
        note: 'Plastic SCM workspace — dispatch is not supported yet.',
      };
  }
}
