import { spawn } from 'child_process';
import { createHash } from 'crypto';
import { existsSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { getConfig } from '../config.js';
import { getDatabase } from '../db/schema.js';
import { createLogger } from '../utils/logger.js';
import { git } from '../utils/git.js';
import { pathKey } from '../utils/paths.js';
import { killTree, runClaude } from '../agent/claude-run.js';
import { projectAccount } from '../accounts.js';
import { getSnapshot, type PlanUsageSnapshot } from '../usage/plan-limits.js';
import { commitAll, createWorktree, worktreePathFor } from '../jobs/worktree.js';
import { loadRegistry, type RegistryProject } from '../projects/registry.js';
import { readProjectPlan, worktreeProject } from '../projects/project-plan.js';
import { mutateProjectDoc, readProjectDoc } from '../projects/project-store.js';
import { featuresOf, findFeature, updateFeature } from '../projects/project-doc-format.js';
import { ProjectBusyError, withProjectLock } from '../projects/project-lock.js';
import { getActiveTrackBranch } from '../projects/track-store.js';
import { reattachIfMissing } from '../projects/track-branches.js';
import { getMergeSink, type MergeSink } from './merge-sink.js';

const logger = createLogger('factory');

/**
 * Everything the engine touches outside its own tables, behind one interface so
 * the runner and dispatcher are tested with fakes (no git, no claude, no plan).
 * `defaultEngineDeps()` wires the real modules.
 */

export interface UnitFeature {
  id: string;
  title: string;
  /** Spec path relative to the project (`project/x.md`), when the line links one. */
  spec: string | null;
}

/** Where a unit's work happens. */
export interface UnitWorktree {
  path: string;
  branch: string;
  baseBranch: string;
}

export interface UnitRef {
  projectCwd: string;
  unitId: string;
  trackName: string;
  isTrack: boolean;
  /** The unit's features in PROJECT.md order (a loose item has one). */
  featureIds: string[];
}

export type FactoryEvent =
  | { kind: 'parked'; projectCwd: string; unitId: string; reason: string }
  | { kind: 'runaway'; projectCwd: string; unitId: string; tokens: number }
  | { kind: 'handed-off'; projectCwd: string; unitId: string };

export interface EngineDeps {
  runClaude: typeof runClaude;
  /** The unit's worktree: created for a loose item, the track's own for a track. Throws when there is none. */
  prepareWorktree(unit: UnitRef, title: string): Promise<UnitWorktree>;
  commit(worktreePath: string, message: string): Promise<boolean>;
  headCommit(worktreePath: string): Promise<string | null>;
  /** Titles and specs of these features, from the plan (a track's worktree copy included), in plan order. */
  features(projectCwd: string, featureIds: string[]): UnitFeature[];
  /** The `verify:` commands of the PROJECT.md in this folder. */
  verifyCommands(worktreePath: string): string[];
  runCommand(cwd: string, command: string, opts: { timeoutMs: number; signal: AbortSignal }): Promise<{ ok: boolean; output: string }>;
  /** Tick a feature done in the track worktree's PROJECT.md (the commit is the caller's). */
  tickFeature(projectCwd: string, worktreePath: string, featureId: string): Promise<void>;
  /** Tokens the unit's runs have processed so far, from the usage ledger. */
  tokensUsed(jobId: string): number;
  /** The newest session one of these steps ran in, recorded before its spawn. */
  lastSessionOf(jobId: string, steps: string[]): string | null;
  writeSummary(projectCwd: string, unitId: string, markdown: string): string;
  planUsage(projectCwd: string): PlanUsageSnapshot | null;
  mergeSink(): MergeSink;
  notify(event: FactoryEvent): void;
  stepTimeoutMs(): number;
  now(): number;
}

const projectHash = (projectCwd: string) => createHash('sha1').update(pathKey(projectCwd)).digest('hex').slice(0, 8);

/**
 * The id a unit's runs are tagged with in `agent_runs.job_id`, which is what
 * the usage ledger groups spend by. Project-qualified: feature ids are only
 * unique within a project.
 */
export function unitJobId(projectCwd: string, unitId: string): string {
  return `factory:${projectHash(projectCwd)}:${unitId}`;
}

function registryProject(projectCwd: string): RegistryProject {
  try {
    const key = pathKey(projectCwd);
    const found = loadRegistry().projects.find((p) => pathKey(p.cwd) === key);
    if (found) return found;
  } catch {
    // No registry yet: the project is addressed by its folder alone.
  }
  return { cwd: projectCwd };
}

const slug = (title: string) =>
  title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'feature';

const OUTPUT_TAIL = 4000;

function runCommand(
  cwd: string,
  command: string,
  opts: { timeoutMs: number; signal: AbortSignal }
): Promise<{ ok: boolean; output: string }> {
  return new Promise((resolve) => {
    if (opts.signal.aborted) return resolve({ ok: false, output: 'aborted' });
    const child = spawn(command, { cwd, shell: true, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    const keep = (d: unknown) => {
      output = (output + String(d)).slice(-OUTPUT_TAIL);
    };
    child.stdout?.on('data', keep);
    child.stderr?.on('data', keep);
    let settled = false;
    const finish = (ok: boolean, extra = '') => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      opts.signal.removeEventListener('abort', onAbort);
      resolve({ ok, output: (output + extra).slice(-OUTPUT_TAIL) });
    };
    const onAbort = () => {
      void killTree(child);
      finish(false, '\n[aborted]');
    };
    opts.signal.addEventListener('abort', onAbort, { once: true });
    const timer = setTimeout(() => {
      void killTree(child);
      finish(false, `\n[timed out after ${Math.round(opts.timeoutMs / 1000)}s]`);
    }, opts.timeoutMs);
    child.on('error', (err) => finish(false, `\n${err.message}`));
    child.on('close', (code) => finish(code === 0));
  });
}

const TICK_ATTEMPTS = 3;
const TICK_RETRY_MS = 2000;

export function defaultEngineDeps(): EngineDeps {
  return {
    runClaude,

    async prepareWorktree(unit, title) {
      if (unit.isTrack) {
        const track = getActiveTrackBranch(unit.projectCwd, unit.trackName);
        if (!track) throw new Error(`Track "${unit.trackName}" has no branch yet; branch it before sending it to the factory`);
        if (!existsSync(track.worktreePath)) await reattachIfMissing(registryProject(unit.projectCwd), track);
        return { path: track.worktreePath, branch: track.branch, baseBranch: track.baseBranch };
      }
      const featureId = unit.featureIds[0];
      const created = await createWorktree(unit.projectCwd, featureId, title, {
        path: worktreePathFor(`factory-${featureId}`),
        branch: `factory/${slug(title)}-${featureId}`,
      });
      return { path: created.path, branch: created.branch, baseBranch: created.baseBranch };
    },

    commit: commitAll,

    async headCommit(worktreePath) {
      return (await git(worktreePath, ['rev-parse', 'HEAD']))?.trim() || null;
    },

    features(projectCwd, featureIds) {
      const doc = readProjectPlan(registryProject(projectCwd)).doc;
      const wanted = new Set(featureIds);
      const inOrder = doc.tracks.flatMap(featuresOf).filter((f) => wanted.has(f.id));
      const found = new Set(inOrder.map((f) => f.id));
      // An item whose line is gone from the plan still runs under its id.
      const missing = featureIds.filter((id) => !found.has(id)).map((id) => ({ id, title: id, spec: null }));
      return [...inOrder.map((f) => ({ id: f.id, title: f.title, spec: f.spec })), ...missing];
    },

    verifyCommands(worktreePath) {
      const state = readProjectDoc({ cwd: worktreePath });
      return state.exists ? state.doc.frontmatter.verify : [];
    },

    runCommand,

    async tickFeature(projectCwd, worktreePath, featureId) {
      const wt = worktreeProject(registryProject(projectCwd), worktreePath);
      // Worktree-file writes take the project lock (docs/track-branches.md). It is a
      // try-lock, never a wait; a Land or merge holding it finishes in seconds.
      for (let attempt = 1; ; attempt++) {
        try {
          await withProjectLock(projectCwd, 'factory: ticking a feature', async () => {
            mutateProjectDoc(wt, null, (doc) => {
              if (findFeature(doc, featureId)) updateFeature(doc, featureId, { status: 'done' });
            });
          });
          return;
        } catch (error) {
          if (!(error instanceof ProjectBusyError) || attempt >= TICK_ATTEMPTS) throw error;
          await new Promise((r) => setTimeout(r, TICK_RETRY_MS));
        }
      }
    },

    tokensUsed(jobId) {
      try {
        const row = getDatabase()
          .prepare(
            `SELECT COALESCE(SUM(input_tokens + output_tokens + cache_read_tokens
                                 + cache_write_5m_tokens + cache_write_1h_tokens), 0) AS tokens
               FROM usage_messages WHERE job_id = ?`
          )
          .get(jobId) as { tokens: number };
        return row.tokens;
      } catch (error) {
        logger.warn({ error, jobId }, 'factory: could not read the ledger');
        return 0;
      }
    },

    lastSessionOf(jobId, steps) {
      if (steps.length === 0) return null;
      const row = getDatabase()
        .prepare(
          `SELECT session_id FROM agent_runs WHERE job_id = ? AND stage IN (${steps.map(() => '?').join(', ')})
            ORDER BY id DESC LIMIT 1`
        )
        .get(jobId, ...steps) as { session_id: string } | undefined;
      return row?.session_id ?? null;
    },

    writeSummary(projectCwd, unitId, markdown) {
      const dir = join(getConfig().persistence.dataDir, 'factory', projectHash(projectCwd), unitId.replace(/[^A-Za-z0-9_-]+/g, '-'));
      mkdirSync(dir, { recursive: true });
      const path = join(dir, 'summary.md');
      writeFileSync(path, markdown, 'utf-8');
      return path;
    },

    planUsage(projectCwd) {
      return getSnapshot(projectAccount(projectCwd));
    },

    mergeSink: getMergeSink,

    notify(event) {
      logger.info({ ...event }, `factory: ${event.kind}`);
    },

    stepTimeoutMs: () => getConfig().jobs.stageTimeoutMs,
    now: () => Date.now(),
  };
}
