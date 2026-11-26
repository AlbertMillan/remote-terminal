import { existsSync } from 'fs';
import { createLogger } from '../utils/logger.js';
import { AccountRefusedError, findTranscript, preflight, projectAccount, type PreflightResult } from '../accounts.js';
import { commitAll } from '../jobs/worktree.js';
import { git } from '../utils/git.js';
import { getActiveTrackBranch } from '../projects/track-store.js';
import { clearParkedProgress, getDispatcher } from './dispatcher.js';
import { defaultEngineDeps, unitJobId, type UnitFeature } from './deps.js';
import { ensureRunState, getRunState, saveRunState, unitIdFor, unitKey, type RunState } from './run-state.js';
import { HANDBACK_NOTE, workStepIds } from './runner.js';
import {

  openClaimRecord,
  recordClaimEnd,
  recordClaimStart,
  sessionOfOwner,
  sessionOwner,
  type ClaimEnd,
} from './session-claims.js';
import { claimForSession, getItem, listItems, releaseClaim } from './store.js';
import { isTrackWorkflow, templateFor, type Progress, type WorkflowTemplate } from './templates.js';
import { CLOSED_STATUSES, type FactoryItem } from './types.js';

const logger = createLogger('factory-takeover');

/**
 * A terminal session takes a factory unit, and gives it back (project/code-factory.md,
 * "Sessions and the factory share one model of work (phase 2)"):
 *
 * - **Take over** (board drawer, `cr factory take`): a new session opens in the
 *   unit's worktree, resuming the factory's own Claude conversation for the unit
 *   (else a fresh one briefed with its spec and progress), under the project's
 *   account. The claim MOVES from the run to the session in one transaction,
 *   then the run is stopped and awaited; its partial work stays in the tree.
 * - **Return to factory**: the session's leftover edits are committed (with
 *   `Feature:` trailers), the claim is released, and the dispatcher resumes the
 *   unit from that commit and its conversation, as after a reclaim.
 * - **Done**: the same, but the unit's building steps count as done, so the
 *   factory goes straight to verify → self-review → summary → review → merge
 *   queue. Never a direct merge.
 * - A **spawned session** started on a track (`cr start --track`) claims the
 *   track's factory items (claimTrackForSession).
 *
 * A session claim has no lease: closing the terminal pauses the unit, still
 * claimed (session-claims.ts). Every claim leaves a record for attribution.
 */

export class ClaimError extends Error {
  constructor(
    public readonly status: number,
    message: string
  ) {
    super(message);
    this.name = 'ClaimError';
  }
}

/** A plain shell the take-over types its `claude` into (sessionEnv, account env: the manager's). */
export interface OpenedShell {
  id: string;
  name: string;
  type(line: string): void;
}

export interface TakeoverDeps {
  projectAccount(projectCwd: string): string;
  preflight(account: string): PreflightResult;
  /** A new shell session in `cwd` under `account`; throws when none can be opened. */
  openShell(options: { name: string; cwd: string; account: string; ownerId?: string }): Promise<OpenedShell>;
  deleteSession(id: string): Promise<unknown>;
  /** Stop the unit's run in this process and settle once it unwound; false when none runs here. */
  stopUnit(key: string): Promise<boolean>;
  /** Wake the dispatcher (a returned unit is claimable now). */
  tick(): void;
  /** Is this transcript where a `claude --resume` in `cwd` under `account` finds it? */
  transcriptExists(cwd: string, claudeSessionId: string, account: string): boolean;
  lastSessionOf(jobId: string, steps: string[]): string | null;
  /** Ledger tokens of a unit: a runaway park's allowance restarts from here. */
  tokensUsed(jobId: string): number;
  features(projectCwd: string, featureIds: string[]): UnitFeature[];
  /** The track's worktree, for a track unit that never ran. */
  trackWorktree(projectCwd: string, trackName: string): { path: string; branch: string; baseBranch: string } | null;
  headCommit(path: string): Promise<string | null>;
  commitAll(path: string, message: string): Promise<boolean>;
  /** Writes the fresh session's brief under `<dataDir>/prompts/<id>/`; returns its path. */
  writePromptFile(sessionId: string, text: string): string;
  /** The session's row: its current Claude transcript. */
  claudeSessionOf(sessionId: string): string | null;
  /** The session's display name, or null when its row is gone. */
  sessionName(sessionId: string): string | null;
  isSessionRunning(sessionId: string): boolean;
  /** Stop (park, revivable) a running session, awaiting its shell. */
  stopSession(sessionId: string): Promise<void>;
  /** Tell the sidebars a session was added. */
  announce(sessionId: string): void;
  now(): number;
}

// ---------------------------------------------------------------------------
// Units

export interface UnitOf {
  lead: FactoryItem;
  unitId: string;
  isTrack: boolean;
  /** Every live item of the unit (a track's open, running and parked features). */
  items: FactoryItem[];
  template: WorkflowTemplate | null;
}

const LIVE = (i: FactoryItem) => !CLOSED_STATUSES.includes(i.status) && i.status !== 'triage';

/** The unit a feature belongs to, with its live items; null for an item the factory does not have. */
export function unitOf(projectCwd: string, featureId: string): UnitOf | null {
  const lead = getItem(projectCwd, featureId);
  if (!lead) return null;
  const isTrack = isTrackWorkflow(lead.workflow);
  const items = isTrack
    ? listItems({ projectCwd }).filter((i) => i.trackName === lead.trackName && isTrackWorkflow(i.workflow) && LIVE(i))
    : LIVE(lead)
      ? [lead]
      : [];
  return { lead, unitId: unitIdFor(lead, isTrack), isTrack, items, template: templateFor(lead.workflow) };
}

/** A track's unit by name: its first live item. */
export function trackUnit(projectCwd: string, trackName: string): UnitOf | null {
  const first = listItems({ projectCwd }).find((i) => i.trackName === trackName && isTrackWorkflow(i.workflow) && LIVE(i));
  return first ? unitOf(projectCwd, first.featureId) : null;
}

/** Who holds the unit: a session's id, or null. */
export function unitSessionHolder(unit: UnitOf): string | null {
  for (const i of unit.items) {
    const id = i.claimKind === 'session' ? sessionOfOwner(i.claimOwner) : null;
    if (id) return id;
  }
  return null;
}

function worktreeOf(unit: UnitOf, state: RunState | null, deps: TakeoverDeps): { path: string; branch: string | null; baseBranch: string | null } | null {
  if (state?.worktreePath) return { path: state.worktreePath, branch: state.branch, baseBranch: state.baseBranch };
  if (unit.isTrack) {
    const t = deps.trackWorktree(unit.lead.projectCwd, unit.lead.trackName);
    if (t) return { path: t.path, branch: t.branch, baseBranch: t.baseBranch };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Take over

export interface TakeOverInput {
  projectCwd: string;
  featureId: string;
  /** The browser user's id, for the new session's row. */
  ownerId?: string;
}

export interface TakeOverResult {
  sessionId: string;
  name: string;
  unitId: string;
  featureIds: string[];
  worktreePath: string;
  /** The factory conversation it resumes, or null when it was briefed fresh. */
  resumed: string | null;
  /** The run it stopped, if one ran here. */
  stoppedRun: boolean;
}

/** The brief a fresh take-over session starts from, when the factory has no conversation to resume. */
export function freshBrief(unit: UnitOf, features: UnitFeature[], progress: Progress | null, worktreePath: string): string {
  const done = new Set(progress?.featuresDone ?? []);
  const lines = features.map((f) => `- ${f.id} ${f.title}${done.has(f.id) ? ' (done)' : ''}${f.spec ? ` — spec: ${f.spec}` : ''}`);
  const steps = progress
    ? Object.entries(progress.outcomes)
        .map(([s, o]) => `${s}: ${o}`)
        .join(', ') || 'none yet'
    : 'none yet';
  return `You are taking over factory work in this worktree (${worktreePath.replace(/\\/g, '/')}) from the
code factory's agent. ${unit.isTrack ? `It is the track "${unit.lead.trackName}"; its features, in order:` : 'The item:'}
${lines.join('\n')}

Steps the factory already finished: ${steps}.
Its commits are on this branch (\`git log\`), and any edits since its last commit are still in the
working tree: read both and carry on from there rather than starting over.

When you are finished, run \`node "$CLAUDE_REMOTE_CLI" factory done\`: the factory then checks,
summarizes and reviews the work and sends it to the merge queue. To hand it back unfinished, run
\`node "$CLAUDE_REMOTE_CLI" factory return\`. Either way, stop editing once it answers: the
factory works in this worktree next. Never merge it yourself.
`;
}

/**
 * Take a running, parked or ready unit into a new terminal session.
 *
 * Order matters: every refusal and the account's preflight first (a refused
 * take-over stops nothing); then the shell is opened, so its id can own the
 * claim; then the claim moves in one transaction (a run that holds it is
 * displaced, so its owner-checked release touches nothing and a refilled seat
 * cannot claim it back); only then is the run stopped and awaited, and `claude`
 * typed in once it unwound, so two processes never share the conversation.
 */
export async function takeOver(input: TakeOverInput, deps: TakeoverDeps): Promise<TakeOverResult> {
  const { projectCwd, featureId } = input;
  const unit = unitOf(projectCwd, featureId);
  if (!unit || unit.items.length === 0) throw new ClaimError(404, `${featureId} is not live factory work`);
  const holder = unitSessionHolder(unit);
  if (holder) throw new ClaimError(409, `A terminal session (${holder}) already holds this unit`);
  const state = getRunState(projectCwd, unit.unitId);
  if (state?.handedOffAt) throw new ClaimError(409, 'This unit is in the merge queue; it can no longer be taken over');
  const worktree = worktreeOf(unit, state, deps);
  if (!worktree) throw new ClaimError(409, 'This unit has not started yet, so it has no worktree to work in');
  if (!existsSync(worktree.path)) throw new ClaimError(409, `The unit's worktree ${worktree.path} is gone`);

  const account = deps.projectAccount(projectCwd);
  const ready = deps.preflight(account);
  if (!ready.ok) throw new AccountRefusedError(ready);

  const jobId = unitJobId(projectCwd, unit.unitId);
  const known = (unit.template ? deps.lastSessionOf(jobId, workStepIds(unit.template)) : null) ?? state?.sessionId ?? null;
  const resumeId = known && deps.transcriptExists(worktree.path, known, account) ? known : null;

  const features = deps.features(projectCwd, unit.items.map((i) => i.featureId));
  const title = unit.isTrack ? unit.lead.trackName : (features[0]?.title ?? featureId);
  const shell = await deps.openShell({ name: title, cwd: worktree.path, account, ownerId: input.ownerId });

  const ids = unit.items.map((i) => i.featureId);
  const claimed = claimForSession(projectCwd, ids, sessionOwner(shell.id), deps.now());
  if (!claimed.ok) {
    await deps.deleteSession(shell.id).catch(() => {});
    const why =
      claimed.reason === 'held'
        ? `a terminal session (${sessionOfOwner(claimed.holder?.owner)}) took it first`
        : claimed.reason === 'closed'
          ? `${claimed.featureId} closed meanwhile`
          : `${claimed.featureId} is gone`;
    throw new ClaimError(409, `Could not take it over: ${why}`);
  }
  let stoppedRun = false;
  try {
    if (unit.items.some((i) => i.status === 'parked')) clearParkedProgress(unit.lead, {}, deps);

    // The claim is the session's: the run unwinds without touching the unit.
    stoppedRun = claimed.displacedRuns.length > 0 ? await deps.stopUnit(unitKey(projectCwd, unit.unitId)) : false;

    const base = await deps.headCommit(worktree.path);
    recordClaimStart(
      {
        projectCwd,
        unitId: unit.unitId,
        trackName: unit.lead.trackName,
        featureIds: ids,
        sessionId: shell.id,
        worktreePath: worktree.path,
        baseCommit: base,
        transcriptId: resumeId,
      },
      deps.now()
    );

    if (resumeId) {
      shell.type(`claude --resume ${resumeId}${nameFlag(shell.name)}`);
    } else {
      const run = getRunState(projectCwd, unit.unitId);
      const path = deps.writePromptFile(shell.id, freshBrief(unit, features, run?.progress ?? null, worktree.path)).replace(/\\/g, '/');
      const dir = path.slice(0, path.lastIndexOf('/'));
      shell.type(`claude --add-dir "${dir}"${nameFlag(shell.name)} -- "Read ${path} and follow it."`);
    }
  } catch (error) {
    // Never a claim held by a bare shell with no `claude` in it: give the unit back to
    // the factory (which resumes it as after a reclaim) and drop the shell.
    for (const id of ids) releaseClaim(projectCwd, id, { owner: sessionOwner(shell.id), kind: 'session' }, deps.now());
    await deps.deleteSession(shell.id).catch(() => {});
    deps.tick();
    throw error;
  }
  deps.announce(shell.id);
  logger.info({ cwd: projectCwd, unit: unit.unitId, session: shell.id, resumed: resumeId, stoppedRun }, 'factory: unit taken over');
  return { sessionId: shell.id, name: shell.name, unitId: unit.unitId, featureIds: ids, worktreePath: worktree.path, resumed: resumeId, stoppedRun };
}

// `--name` only for a name no shell misreads (session-open.ts claudeNameFlag's rule).
function nameFlag(name: string): string {
  const trimmed = name.trim();
  return trimmed && !/["%$`!\\]/.test(trimmed) ? ` --name "${trimmed}"` : '';
}

// ---------------------------------------------------------------------------
// Spawned sessions on a track

export interface TrackClaim {
  /** Feature ids the session now holds. */
  claimed: string[];
  /** Why it holds none of them, when the track has factory items it could not take. */
  note?: string;
}

/**
 * A session started on a track (`cr start --track`) claims the track's factory
 * items, so the dispatcher skips them and the board shows the unit as yours. A
 * run working the track is displaced and stopped exactly as by Take over. Never
 * throws into the start: a track with no factory items claims nothing, and one
 * the session cannot take (in the merge queue, held by another session) is
 * reported in `note`.
 */
export async function claimTrackForSession(
  projectCwd: string,
  trackName: string,
  sessionId: string,
  worktreePath: string,
  deps: Pick<TakeoverDeps, 'stopUnit' | 'headCommit' | 'now' | 'tokensUsed'>
): Promise<TrackClaim> {
  try {
    const unit = trackUnit(projectCwd, trackName);
    if (!unit) return { claimed: [] };
    const state = getRunState(projectCwd, unit.unitId);
    if (state?.handedOffAt) return { claimed: [], note: 'the track is in the factory\'s merge queue; it was not claimed' };
    const holder = unitSessionHolder(unit);
    if (holder && holder !== sessionId) return { claimed: [], note: `another session (${holder}) holds the track's factory work` };
    const ids = unit.items.map((i) => i.featureId);
    const claimed = claimForSession(projectCwd, ids, sessionOwner(sessionId), deps.now());
    if (!claimed.ok) return { claimed: [], note: `the track's factory work could not be claimed (${claimed.featureId}: ${claimed.reason})` };
    if (unit.items.some((i) => i.status === 'parked')) {
      clearParkedProgress(unit.lead, {}, deps);
    }
    if (claimed.displacedRuns.length > 0) await deps.stopUnit(unitKey(projectCwd, unit.unitId));
    recordClaimStart(
      {
        projectCwd,
        unitId: unit.unitId,
        trackName,
        featureIds: ids,
        sessionId,
        worktreePath,
        baseCommit: await deps.headCommit(worktreePath),
      },
      deps.now()
    );
    logger.info({ cwd: projectCwd, track: trackName, session: sessionId, items: ids }, 'factory: a started session claimed its track');
    return { claimed: ids };
  } catch (error) {
    logger.warn({ cwd: projectCwd, track: trackName, error: (error as Error).message }, 'factory: claiming a track for a session failed');
    return { claimed: [], note: 'the track\'s factory work could not be claimed (see the server log)' };
  }
}

// ---------------------------------------------------------------------------
// Return to factory, and Done

export interface ReleaseInput {
  projectCwd: string;
  featureId: string;
  /** When set, only this session's claim is released (a CLI caller, or the session header). */
  sessionId?: string;
  /** The session that asked (a CLI caller); it is never stopped by its own request. */
  callerId?: string;
}

export interface ReleaseResult {
  unitId: string;
  featureIds: string[];
  sessionId: string;
  /** The commit the factory resumes from (the session's leftovers committed onto it). */
  head: string | null;
  committed: boolean;
}

/**
 * The building steps of a template are settled (a session built the work), and
 * every step after them is cleared, so the factory re-checks the session's
 * work: verify, self-review, fix loops, summary, review, merge. For a track,
 * every feature counts as built and committed, reviewed together.
 */
export function markWorkDone(template: WorkflowTemplate, progress: Progress, featureIds: string[]): void {
  const BUILD = new Set(['implement', 'track-features', 'track-features-reviewed']);
  const last = template.steps.findIndex((s) => BUILD.has(s.handler));
  if (last < 0) return;
  for (const [i, step] of template.steps.entries()) {
    if (i <= last) {
      if (BUILD.has(step.handler)) {
        progress.outcomes[step.id] = 'done';
        progress.skipped = progress.skipped.filter((s) => s !== step.id);
      } else if (!(step.id in progress.outcomes) && !progress.skipped.includes(step.id)) {
        // An unshaped item a session built: the session was its shaping.
        progress.skipped.push(step.id);
      }
    } else {
      delete progress.outcomes[step.id];
      progress.skipped = progress.skipped.filter((s) => s !== step.id);
    }
  }
  progress.loops = {};
  for (const note of ['verify', 'self-review', 'review', 'review-feature', 'review-base']) delete progress.notes[note];
  progress.featuresDone = [...new Set([...progress.featuresDone, ...featureIds])];
  progress.featuresBuilt = [];
  progress.current = null;
  progress.parked = null;
}

function handbackNote(sessionName: string, base: string | null, head: string | null, done: boolean): string {
  const range = base && head && base !== head ? `${base.slice(0, 10)}..${head.slice(0, 10)}` : null;
  return `A person worked on this unit in the terminal session "${sessionName}"${range ? ` (commits ${range})` : ''} and ${
    done ? 'marked it done: the building is finished. Check and review what is on the branch.' : 'handed it back to you unfinished.'
  } Read \`git log\` and the working tree before you go on, and keep what they did.`;
}

/**
 * Return to factory (`end: 'returned'`) or Done (`end: 'done'`): commit the
 * session's leftover edits with the unit's `Feature:` trailers, record the
 * claim's end, and release it. The dispatcher claims the unit again and
 * resumes it from that commit: after Done at verify, never a direct merge.
 */
export async function releaseSessionClaim(input: ReleaseInput, end: ClaimEnd, deps: TakeoverDeps): Promise<ReleaseResult> {
  const { projectCwd, featureId } = input;
  const unit = unitOf(projectCwd, featureId);
  if (!unit || unit.items.length === 0) throw new ClaimError(404, `${featureId} is not live factory work`);
  const holder = unitSessionHolder(unit);
  if (!holder) throw new ClaimError(409, 'No terminal session holds this unit');
  if (input.sessionId && input.sessionId !== holder) throw new ClaimError(403, 'Another session holds this unit');
  const owner = sessionOwner(holder);
  const held = unit.items.filter((i) => i.claimOwner === owner);

  // The factory resumes in this worktree, in the conversation the terminal may still be
  // running: a live holder is stopped first (parked, revivable), or two agents edit one
  // tree and write one transcript. Not when the holder itself asked (`cr factory return`
  // from its own terminal): its agent needs the answer, and its brief says to stop.
  if (input.callerId !== holder && deps.isSessionRunning(holder)) await deps.stopSession(holder);

  const state = getRunState(projectCwd, unit.unitId) ?? ensureRunState(projectCwd, unit.unitId, [], deps.now());
  const record = openClaimRecord(projectCwd, unit.unitId, holder);
  const worktree = worktreeOf(unit, state, deps) ?? (record?.worktreePath ? { path: record.worktreePath, branch: null, baseBranch: null } : null);

  let committed = false;
  let head: string | null = null;
  if (worktree && existsSync(worktree.path)) {
    const trailers = held.map((i) => `Feature: ${i.featureId}`).join('\n');
    committed = await deps.commitAll(
      worktree.path,
      `${end === 'done' ? 'Session work' : 'Session work in progress'} on ${unit.isTrack ? unit.lead.trackName : featureId}\n\n${trailers}\nFactory-Session: ${holder}`
    );
    head = await deps.headCommit(worktree.path);
  }

  const progress = state.progress;
  if (end === 'done' && unit.template) markWorkDone(unit.template, progress, held.map((i) => i.featureId));
  // The session's edits are on the branch now: the next run is told, not "interrupted".
  progress.current = null;
  progress.notes[HANDBACK_NOTE] = handbackNote(deps.sessionName(holder) ?? holder, record?.baseCommit ?? null, head, end === 'done');
  saveRunState(
    projectCwd,
    unit.unitId,
    {
      progress,
      parkReason: null,
      ...(head ? { lastCommit: head } : {}),
      // A track unit that never ran: the runner fills the rest from prepareWorktree.
      ...(!state.worktreePath && worktree ? { worktreePath: worktree.path } : {}),
    },
    deps.now()
  );
  if (record) recordClaimEnd(record.id, { endCommit: head, endedBy: end, transcriptId: deps.claudeSessionOf(holder) }, deps.now());

  for (const i of held) releaseClaim(projectCwd, i.featureId, { owner, kind: 'session' }, deps.now());
  deps.tick();
  logger.info({ cwd: projectCwd, unit: unit.unitId, session: holder, end, head }, 'factory: session gave the unit back');
  return { unitId: unit.unitId, featureIds: held.map((i) => i.featureId), sessionId: holder, head, committed };
}

// ---------------------------------------------------------------------------

/** The real wiring, minus the session manager (session-routes.ts adds it, to keep PTYs out of this module's imports). */
export function baseTakeoverDeps(): Omit<TakeoverDeps, 'openShell' | 'deleteSession' | 'writePromptFile' | 'claudeSessionOf' | 'sessionName' | 'isSessionRunning' | 'stopSession' | 'announce'> {
  const engine = defaultEngineDeps();
  return {
    projectAccount,
    preflight: (account) => preflight(account),
    stopUnit: async (key) => (await getDispatcher()?.stopUnit(key)) ?? false,
    tick: () => void getDispatcher()?.tick(),
    transcriptExists: (cwd, id, account) => findTranscript(cwd, id, account) !== null,
    lastSessionOf: engine.lastSessionOf,
    tokensUsed: engine.tokensUsed,
    features: engine.features,
    trackWorktree: (projectCwd, trackName) => {
      const t = getActiveTrackBranch(projectCwd, trackName);
      return t ? { path: t.worktreePath, branch: t.branch, baseBranch: t.baseBranch } : null;
    },
    headCommit: async (path) => (await git(path, ['rev-parse', 'HEAD']))?.trim() || null,
    commitAll,
    now: () => Date.now(),
  };
}
