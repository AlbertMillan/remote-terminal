import { RunAbortedError, type ClaudeRunResult } from '../agent/claude-run.js';
import { createLogger } from '../utils/logger.js';
import { ProjectBusyError } from '../projects/project-lock.js';
import { getItem, heartbeat, releaseClaim, updateItem } from './store.js';
import { LEASE_RENEW_MS, type Claimant } from './types.js';
import { unitJobId, type EngineDeps, type UnitRef, type UnitWorktree } from './deps.js';
import { DEFAULT_FACTORY_LIMITS, type FactoryLimits } from './limits.js';
import { ensureRunState, saveRunState } from './run-state.js';
import { stepHandler, type AgentRequest, type StepContext } from './steps.js';
import { parseDiscovered, type DiscoveredWork } from './triage.js';
// Registers the reviewer's step handlers (review, review-fix, per-feature track steps).
import './review-step.js';
// Registers the shaping pass (shape).
import './shape-step.js';
import { nextStep, recordOutcome, templateFor, type Progress, type WorkflowTemplate } from './templates.js';

const logger = createLogger('factory-runner');

/**
 * Runs one claimed unit of work through its workflow template.
 *
 * - Holds the claim by heartbeat every LEASE_RENEW_MS; a heartbeat the store
 *   refuses means the unit was reclaimed, and the run stops without touching it.
 * - Persists progress after every step (and before, as `current`), so a run
 *   that dies is resumed by the next claimer from its last commit and its
 *   Claude session (`--resume`), skipping every step already recorded.
 * - The runaway guard parks a unit whose runs pass `runawayTokens` in the
 *   usage ledger, checked between steps and on every heartbeat.
 */

export interface ClaimedUnit {
  ref: UnitRef;
  workflow: string;
  /** The claim owner every item of the unit is held under. */
  owner: string;
  modelTier: string | null;
}

export type RunEnd =
  | { kind: 'handed-off' }
  | { kind: 'parked'; reason: string }
  /** Reclaimed under us: someone else has it now. */
  | { kind: 'lost' }
  /** Stopped by the dispatcher (shutdown); the claim was given back. */
  | { kind: 'stopped' }
  /** Stepped aside (the project lock was busy); claim given back, retry after a cool-down. */
  | { kind: 'deferred'; reason: string }
  | { kind: 'finished' };

/** Handlers that continue the unit's working conversation; its session is theirs. */
const WORK_HANDLERS = new Set(['implement', 'track-features', 'track-features-reviewed', 'fix', 'review-fix', 'summary']);

const WRITE_TOOLS = ['Read', 'Glob', 'Grep', 'Edit', 'Write', 'Bash'];
const READ_TOOLS = ['Read', 'Glob', 'Grep', 'Bash'];

const INTERRUPTED = `Your previous attempt at this step was interrupted before it finished (the run was
lost or the server restarted). Your edits since the last commit are still in the working
tree: check what is there and carry on from it rather than starting over.

`;

export async function runUnit(
  unit: ClaimedUnit,
  deps: EngineDeps,
  opts: { signal: AbortSignal; limits?: FactoryLimits }
): Promise<RunEnd> {
  const limits = opts.limits ?? DEFAULT_FACTORY_LIMITS;
  const { ref } = unit;
  const cwd = ref.projectCwd;
  const claimant: Claimant = { owner: unit.owner, kind: 'run' };
  const jobId = unitJobId(cwd, ref.unitId);
  const state = ensureRunState(cwd, ref.unitId, [], deps.now());
  const progress: Progress = state.progress;
  const save = () => saveRunState(cwd, ref.unitId, { progress }, deps.now());

  const park = (reason: string, step: string | null): RunEnd => {
    progress.parked = step;
    progress.current = null;
    saveRunState(cwd, ref.unitId, { progress, parkReason: reason }, deps.now());
    // The board shows the step it waits at, including one it never started (a loop cap).
    const patch = step ? { status: 'parked' as const, step } : { status: 'parked' as const };
    for (const id of ref.featureIds) updateItem(cwd, id, patch, deps.now());
    deps.notify({ kind: 'parked', projectCwd: cwd, unitId: ref.unitId, reason });
    logger.info({ cwd, unit: ref.unitId, reason }, 'factory: parked');
    return { kind: 'parked', reason };
  };

  const template: WorkflowTemplate | null = templateFor(unit.workflow);
  if (!template) return park(`unknown workflow "${unit.workflow}"`, null);

  // One signal for every reason to stop: the dispatcher's, a lost claim, the guard.
  const ac = new AbortController();
  let stopReason: 'stopped' | 'lost' | 'runaway' | null = null;
  const stop = (why: 'stopped' | 'lost' | 'runaway') => {
    if (!stopReason) stopReason = why;
    ac.abort();
  };
  if (opts.signal.aborted) stop('stopped');
  else opts.signal.addEventListener('abort', () => stop('stopped'), { once: true });

  const overBudget = () => deps.tokensUsed(jobId) - progress.tokenBase > limits.runawayTokens;
  const beat = setInterval(() => {
    const now = deps.now();
    for (const id of ref.featureIds) {
      if (!heartbeat(cwd, id, unit.owner, now)) return stop('lost');
    }
    if (overBudget()) stop('runaway');
  }, LEASE_RENEW_MS);

  // The step the previous run died inside, if any: its first agent call is told so.
  let interruptedStep: string | null = progress.current;
  const workSteps = template.steps.filter((s) => WORK_HANDLERS.has(s.handler)).map((s) => s.id);
  // The newest working session: recorded in agent_runs before each spawn, so it
  // survives a run killed before its envelope (and so before state.sessionId) existed.
  let sessionId: string | null = deps.lastSessionOf(jobId, workSteps) ?? state.sessionId;
  let currentStep: string | null = null;

  try {
    const features = deps.features(cwd, ref.featureIds);
    const title = ref.isTrack ? ref.trackName : features[0]?.title ?? ref.unitId;
    const worktree: UnitWorktree = await deps.prepareWorktree(ref, title, ac.signal);

    // A track's worktree is usually where the session that planned it works.
    // Its first commit is `git add -A`, so a tree that is already dirty when the
    // factory first takes the track would sweep that session's edits into a
    // feature commit. Refuse until they are committed or stashed. Only a fresh
    // unit: on a resume, the dirt is the factory's own unfinished step.
    const fresh =
      !state.lastCommit &&
      Object.keys(progress.outcomes).length === 0 &&
      progress.featuresDone.length === 0 &&
      progress.featuresBuilt.length === 0 &&
      progress.current === null &&
      !sessionId;
    if (ref.isTrack && fresh) {
      const dirty = await deps.dirtyFiles(worktree.path);
      if (dirty.length > 0) {
        const shown = dirty.slice(0, 5).join(', ') + (dirty.length > 5 ? `, … (${dirty.length} files)` : '');
        return park(`the track worktree has uncommitted changes (${shown}); commit or stash them first`, null);
      }
    }

    saveRunState(
      cwd,
      ref.unitId,
      { worktreePath: worktree.path, branch: worktree.branch, baseBranch: worktree.baseBranch, parkReason: null },
      deps.now()
    );

    // Work the current step's agent replies listed as discovered (triage.ts).
    let discovered: DiscoveredWork[] = [];

    const agent = async (stepId: string, req: AgentRequest): Promise<ClaudeRunResult> => {
      const note = stepId === interruptedStep ? INTERRUPTED : '';
      if (note) interruptedStep = null;
      // Read per call: shaping sets a loose item's tier mid-run (a sender's choice stays).
      const tier = (ref.isTrack ? null : getItem(cwd, ref.featureIds[0])?.modelTier) ?? unit.modelTier;
      const base = {
        allowedTools: req.access === 'write' ? WRITE_TOOLS : READ_TOOLS,
        timeoutMs: deps.stepTimeoutMs(),
        signal: ac.signal,
        failOnDenial: false,
        laneKey: cwd,
        tag: { projectCwd: cwd, kind: 'factory' as const, jobId, stage: stepId },
        ...(tier ? { model: tier } : {}),
      };
      // `read` access reverts every edit; `write` may change the whole worktree.
      const globs = req.access === 'write' ? ['**'] : [];
      let result: ClaudeRunResult;
      if (req.work && sessionId) {
        try {
          result = await deps.runClaude(worktree.path, note + (req.resumePrompt ?? req.prompt), globs, {
            ...base,
            resumeSessionId: sessionId,
          });
        } catch (error) {
          if (error instanceof RunAbortedError || ac.signal.aborted) throw error;
          logger.warn({ cwd, unit: ref.unitId, step: stepId, error: (error as Error).message }, 'factory: resume failed, running fresh');
          result = await deps.runClaude(worktree.path, note + req.prompt, globs, base);
        }
      } else {
        result = await deps.runClaude(worktree.path, note + req.prompt, globs, base);
      }
      if (req.work && result.sessionId) {
        sessionId = result.sessionId;
        saveRunState(cwd, ref.unitId, { sessionId }, deps.now());
      }
      discovered.push(...parseDiscovered(result.result));
      return result;
    };

    const commit = async (message: string, featureId?: string) => {
      const full = featureId ? `${message}\n\nFeature: ${featureId}` : message;
      await deps.commit(worktree.path, full);
      const head = await deps.headCommit(worktree.path);
      if (head) saveRunState(cwd, ref.unitId, { lastCommit: head }, deps.now());
    };

    for (;;) {
      if (ac.signal.aborted) throw new RunAbortedError();
      if (overBudget()) stop('runaway');
      if (ac.signal.aborted) throw new RunAbortedError();

      const next = nextStep(template, progress);
      if (next.kind === 'finished') {
        save();
        releaseAll(cwd, ref.featureIds, claimant, deps.now());
        return { kind: 'finished' };
      }
      if (next.kind === 'park') return park(next.reason, next.step.id);

      const step = next.step;
      const handler = stepHandler(step.handler);
      if (!handler) return park(`no handler "${step.handler}" for step ${step.id}`, step.id);
      currentStep = step.id;
      for (const id of ref.featureIds) updateItem(cwd, id, { step: step.id }, deps.now());
      progress.current = step.id;
      save();

      const ctx: StepContext = {
        unit: ref,
        features,
        worktree,
        progress,
        step,
        signal: ac.signal,
        deps,
        agent: (req) => agent(step.id, req),
        commit,
        saveProgress: save,
      };
      discovered = [];
      const result = await handler(ctx);
      progress.current = null;

      // Filed whatever the step ended in: work seen before a park is still worth triaging.
      const found = [...discovered, ...('outcome' in result ? (result.discovered ?? []) : [])];
      if (found.length > 0 && deps.fileDiscovered) {
        const from = ref.featureIds.find((id) => !progress.featuresDone.includes(id)) ?? ref.featureIds[ref.featureIds.length - 1];
        await deps.fileDiscovered(cwd, from, found);
      }

      if ('outcome' in result) {
        recordOutcome(template, progress, step.id, result.outcome);
        save();
        if (result.requeue) {
          // It waits on something now (an overlapping item): back to the queue,
          // which claims it again once nothing blocks it.
          releaseAll(cwd, ref.featureIds, claimant, deps.now());
          logger.info({ cwd, unit: ref.unitId, reason: result.requeue }, 'factory: requeued');
          return { kind: 'deferred', reason: result.requeue };
        }
        continue;
      }
      if ('park' in result) return park(result.park, step.id);

      // Handed to the merge queue: the unit stays open at step `merge`, unclaimed,
      // and dispatch leaves it alone until the queue closes its items. Enqueued
      // first: a sink that throws parks the unit (below) instead of stranding it.
      deps.mergeSink().enqueue(result.handoff);
      save();
      saveRunState(cwd, ref.unitId, { handedOffAt: new Date(deps.now()).toISOString() }, deps.now());
      releaseAll(cwd, ref.featureIds, claimant, deps.now());
      deps.notify({ kind: 'handed-off', projectCwd: cwd, unitId: ref.unitId });
      return { kind: 'handed-off' };
    }
  } catch (error) {
    if (stopReason === 'lost') {
      // Give back whatever this run still holds (a track's other features, when
      // one was cancelled or reclaimed), or each keeps a seat until its lease
      // expires. releaseClaim is owner-checked: a new holder is never touched.
      releaseAll(cwd, ref.featureIds, claimant, deps.now());
      logger.warn({ cwd, unit: ref.unitId }, 'factory: lost the claim; stopping without touching the unit');
      return { kind: 'lost' };
    }
    if (stopReason === 'stopped') {
      // `current` stays set, so the next claimer knows the step was cut short.
      releaseAll(cwd, ref.featureIds, claimant, deps.now());
      return { kind: 'stopped' };
    }
    if (stopReason === 'runaway') {
      const tokens = deps.tokensUsed(jobId);
      deps.notify({ kind: 'runaway', projectCwd: cwd, unitId: ref.unitId, tokens });
      return park(`runaway: ${tokens.toLocaleString('en-US')} tokens (guard ${limits.runawayTokens.toLocaleString('en-US')})`, currentStep);
    }
    if (error instanceof ProjectBusyError) {
      // The project lock is try-only and never waited on. Nothing is half-done:
      // the step records what it finished (a built feature) before taking it.
      progress.current = null;
      save();
      releaseAll(cwd, ref.featureIds, claimant, deps.now());
      logger.info({ cwd, unit: ref.unitId, step: currentStep }, 'factory: project busy; stepping aside');
      return { kind: 'deferred', reason: error.message };
    }
    const message = error instanceof Error ? error.message : String(error);
    logger.warn({ cwd, unit: ref.unitId, step: currentStep, error: message }, 'factory: step failed');
    return park(`${currentStep ?? 'setup'} failed: ${message}`, currentStep);
  } finally {
    clearInterval(beat);
  }
}

function releaseAll(cwd: string, featureIds: string[], claimant: Claimant, now: number): void {
  for (const id of featureIds) releaseClaim(cwd, id, claimant, now);
}
