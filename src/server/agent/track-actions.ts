import { createLogger } from '../utils/logger.js';
import { isInside, pathKey } from '../utils/paths.js';
import { sessionManager } from '../sessions/manager.js';
import type { SessionMetadata } from '../sessions/types.js';
import { getSession as getSessionFromDb } from '../db/queries.js';
import { pushLandResult } from '../push/wire.js';
import { broadcastLandResult } from '../websocket/connections.js';
import type { LandNotificationPayload } from '../websocket/protocol.js';
import type { RegistryProject } from '../projects/registry.js';
import { landPreflightForSession, updateAndInstall } from '../projects/track-land.js';
import { mergeQueueBusy, queueLand } from '../factory/merge-queue.js';
import type { UpdateResult } from '../projects/track-update.js';
import { trackBranchContaining, type TrackBranch } from '../projects/track-store.js';
import type { InstallResult } from '../projects/project-deps.js';
import { AgentSessionError, projectForCwd } from './agent-common.js';

/**
 * A session's Land and Update from main of its own track, or of one a session it started
 * works in (docs/session-orchestration.md). Routes: sessions-api.ts.
 */

const logger = createLogger('agent-sessions');

// --- Land ------------------------------------------------------------------

/**
 * What a session's own Land needs. Separate from AgentSessionDeps: none of it
 * starts a session, and Land's side lives in the projects module.
 */
export interface AgentLandDeps {
  getSession(id: string): SessionMetadata | null;
  /** Every session row, live or not: a parent may land a child that has finished. */
  listSessions(): Pick<SessionMetadata, 'id' | 'cwd' | 'spawnedBy'>[];
  /** The unlanded track whose worktree holds `cwd`, or null. */
  trackBranchFor(cwd: string): TrackBranch | null;
  projectForCwd(cwd: string): RegistryProject | null;
  /** Phase 1: every Land refusal that needs no session closed, plus a conflicting merge. */
  preflight(project: RegistryProject, trackName: string): Promise<void>;
  /**
   * Phase 2, through the project's merge queue (factory/merge-queue.ts):
   * close the worktree's sessions, land under the lock, rebuild.
   */
  land(project: RegistryProject, trackName: string): Promise<{ detail: string }>;
  notify(payload: LandNotificationPayload): void;
  /**
   * What the project's merge queue is busy with, or null. A busy queue
   * accepts the Land without phase 1: its preflight would be refused on the
   * project lock the merge holds, and Land runs every check again at its turn.
   */
  queueBusy?(projectCwd: string): string | null;
}

/** What callerTrack needs to tell which track a caller may act on. */
type CallerTrackDeps = Pick<AgentLandDeps, 'getSession' | 'listSessions' | 'trackBranchFor' | 'projectForCwd'>;

export const defaultLandDeps: AgentLandDeps = {
  getSession: getSessionFromDb,
  listSessions: () => sessionManager.getSessionList(),
  trackBranchFor: (cwd) => {
    const branch = trackBranchContaining(cwd);
    return branch && branch.landedAt === null ? branch : null;
  },
  projectForCwd,
  preflight: landPreflightForSession,
  // The queue's land kind runs landAndBuild with the running sessions, as before.
  land: (project, trackName) => queueLand(project, trackName).result,
  notify: (payload) => {
    broadcastLandResult(payload);
    pushLandResult(payload);
  },
  queueBusy: mergeQueueBusy,
};

export interface AcceptedLand {
  project: RegistryProject;
  track: string;
  /** The caller is in the track's worktree, so the Land closes it too. */
  closesCaller: boolean;
  /** What the merge queue was busy with when it was accepted (no phase 1 then), or null. */
  queuedBehind: string | null;
}

/** A land or update request: no track for the caller's own, or one its started session works in. */
export interface TrackBody {
  track?: unknown;
}

// Lands accepted and not yet finished, by project and track. Phase 1 releases
// the project lock before its reply and phase 2 takes it only once the reply
// is out, so without this a second request in that gap (an agent retrying,
// two sessions in one worktree) passes phase 1 too — and its Land, failing
// with "no branch to land", replaces the first one's success on screen.
const landsUnderWay = new Set<string>();
const landKey = (project: RegistryProject, track: string) => `${pathKey(project.cwd)}\0${track}`;

/** Forget an accepted Land that will never run (its request was aborted before the reply). */
export function dropAcceptedLand(accepted: AcceptedLand): void {
  landsUnderWay.delete(landKey(accepted.project, accepted.track));
}

/**
 * The unlanded track a caller may land or update: with no name, the one whose
 * worktree it is in; with a name, that same one or the track a session IT
 * STARTED works in (spawned_by), finished or not. A request can name a track,
 * but never reach one outside the caller's own family: its token says who asks.
 */
function callerTrack(
  deps: CallerTrackDeps,
  caller: SessionMetadata,
  callerId: string,
  named: string | null,
  verb: 'land' | 'update'
): { branch: TrackBranch; closesCaller: boolean } {
  const own = deps.trackBranchFor(caller.cwd);
  if (named === null) {
    if (!own) throw new AgentSessionError(400, "This session isn't in a track's worktree");
    return { branch: own, closesCaller: true };
  }
  const project = deps.projectForCwd(caller.cwd);
  const inProject = (b: TrackBranch | null): b is TrackBranch =>
    b !== null && b.trackName === named && !!project && pathKey(b.projectCwd) === pathKey(project.cwd);
  if (inProject(own)) return { branch: own, closesCaller: true };
  for (const s of deps.listSessions()) {
    if (s.spawnedBy !== callerId) continue;
    const branch = deps.trackBranchFor(s.cwd);
    if (inProject(branch)) return { branch, closesCaller: isInside(branch.worktreePath, caller.cwd) };
  }
  throw new AgentSessionError(
    403,
    `"${named}" is not a track this session or a session it started works in; it can ${verb} only those`
  );
}

/** The caller, the track its body names (or its own), and that track's project, or the refusal. */
function resolveCallerTrack(
  deps: CallerTrackDeps,
  callerId: string,
  body: TrackBody,
  verb: 'land' | 'update'
): { project: RegistryProject; branch: TrackBranch; closesCaller: boolean } {
  const caller = deps.getSession(callerId);
  if (!caller) throw new AgentSessionError(401, 'The calling session no longer exists');
  let named: string | null = null;
  if (body.track !== undefined) {
    if (typeof body.track !== 'string' || !body.track.trim()) throw new AgentSessionError(400, 'track must be a non-empty string');
    named = body.track.trim();
  }
  const { branch, closesCaller } = callerTrack(deps, caller, callerId, named, verb);
  const project = deps.projectForCwd(caller.cwd);
  if (!project || pathKey(project.cwd) !== pathKey(branch.projectCwd)) {
    throw new AgentSessionError(400, `${caller.cwd} is not in a workspace project`);
  }
  return { project, branch, closesCaller };
}

/**
 * Phase 1 of a session's Land, inside the request. Without a track in the
 * body, the track is the one whose worktree the caller is in; a parent names
 * a track one of its started sessions works in (callerTrack). Every refusal
 * reaches the agent while it is still running.
 */
export async function requestLand(deps: AgentLandDeps, callerId: string, body: TrackBody = {}): Promise<AcceptedLand> {
  const { project, branch, closesCaller } = resolveCallerTrack(deps, callerId, body, 'land');
  const key = landKey(project, branch.trackName);
  if (landsUnderWay.has(key)) {
    throw new AgentSessionError(409, `A Land of "${branch.trackName}" is already under way; its result comes as a notification`);
  }
  // A merge in progress holds the project lock, which phase 1 would be
  // refused on: the Land joins the queue instead, and its refusals come as
  // the notification (landTrack checks everything again at its turn).
  const queuedBehind = deps.queueBusy?.(project.cwd) ?? null;
  if (queuedBehind === null) await deps.preflight(project, branch.trackName);
  // Again after the await, in case another request was accepted meanwhile.
  if (landsUnderWay.has(key)) {
    throw new AgentSessionError(409, `A Land of "${branch.trackName}" is already under way; its result comes as a notification`);
  }
  landsUnderWay.add(key);
  return { project, track: branch.trackName, closesCaller, queuedBehind };
}

/**
 * Phase 2, after the 202 has gone out: Land (which closes the worktree's
 * sessions, the caller included, before it merges) and say how it went. It
 * never throws — the caller is gone, so the notification is the answer.
 */
export async function runRequestedLand(deps: AgentLandDeps, accepted: AcceptedLand): Promise<void> {
  const { project, track } = accepted;
  let ok = false;
  let detail: string;
  try {
    detail = (await deps.land(project, track)).detail;
    ok = true;
    logger.info({ cwd: project.cwd, track }, 'agent-sessions: session-requested land done');
  } catch (error) {
    detail = `Landing "${track}" failed: ${error instanceof Error ? error.message : String(error)}`;
    logger.warn({ cwd: project.cwd, track, error: detail }, 'agent-sessions: session-requested land failed');
  } finally {
    dropAcceptedLand(accepted);
  }
  try {
    deps.notify({ kind: 'land', projectCwd: project.cwd, track, ok, detail, timestamp: new Date().toISOString() });
  } catch (error) {
    logger.warn({ error }, 'agent-sessions: could not send the land result');
  }
}

// --- Update from main ------------------------------------------------------

/**
 * What a session's Update from main needs: who may update which track, as for
 * Land, and the Update the board's button runs. One phase: nothing closes, so
 * the agent gets the outcome as the reply.
 */
export interface AgentUpdateDeps extends CallerTrackDeps {
  update(project: RegistryProject, trackName: string): Promise<UpdateResult & { install: InstallResult | null }>;
}

export const defaultUpdateDeps: AgentUpdateDeps = {
  getSession: defaultLandDeps.getSession,
  listSessions: defaultLandDeps.listSessions,
  trackBranchFor: defaultLandDeps.trackBranchFor,
  projectForCwd,
  update: (project, trackName) => updateAndInstall(project, trackName),
};

export interface UpdateReply {
  track: string;
  mergeSha: string | null;
  install: InstallResult | null;
  detail: string;
}

/** A session's Update from main of its own track, or one a session it started works in. */
export async function requestUpdate(deps: AgentUpdateDeps, callerId: string, body: TrackBody = {}): Promise<UpdateReply> {
  const { project, branch } = resolveCallerTrack(deps, callerId, body, 'update');
  const result = await deps.update(project, branch.trackName);
  logger.info({ callerId, track: branch.trackName, mergeSha: result.mergeSha }, 'agent-sessions: session-requested update');
  return { track: branch.trackName, mergeSha: result.mergeSha, install: result.install, detail: result.detail };
}
