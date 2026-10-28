import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { existsSync } from 'fs';
import { join } from 'path';
import { createLogger } from '../utils/logger.js';
import { isInside } from '../utils/paths.js';
import { replyWithError, type StatusError } from '../utils/http-errors.js';
import { sessionManager } from '../sessions/manager.js';
import { sessionForToken } from '../sessions/session-env.js';
import { writePromptFile } from '../sessions/prompt-file.js';
import { claudeNameFlag, injectCommand } from '../sessions/session-open.js';
import {
  availableMcpServers,
  launchFlags,
  parseMcpServers,
  type LaunchFlags,
  type LaunchProfile,
} from '../sessions/launch-profile.js';
import { UNSAFE_IN_QUOTES } from '../utils/shell-quote.js';
import type { ActiveSession, SessionCreateOptions, SessionMetadata } from '../sessions/types.js';
import { getSession as getSessionFromDb, setSessionMcpServers } from '../db/queries.js';
import { getConfig } from '../config.js';
import {
  AccountRefusedError,
  accountNames,
  claudeJsonPath,
  isAccount,
  preflight,
  type PreflightResult,
} from '../accounts.js';
import { notificationService, type NotificationType } from '../notifications/service.js';
import {
  broadcastLandResult,
  broadcastPromptMissing,
  broadcastSessionAdded,
  removeWorktreeSessions,
  sessionToInfo,
} from '../websocket/connections.js';
import type { LandNotificationPayload, PromptMissingNotificationPayload, SessionInfo } from '../websocket/protocol.js';
import { loadRegistry, type RegistryProject } from '../projects/registry.js';
import { findWorkspaceProject, listBoardCwds } from '../projects/workspace.js';
import { readProjectPlan } from '../projects/project-plan.js';
import { ensureTrackBranch } from '../projects/track-branches.js';
import { landAndBuild, landPreflightForSession, updateAndInstall } from '../projects/track-land.js';
import type { UpdateResult } from '../projects/track-branches.js';
import { pathKey } from '../sessions/project-discovery.js';
import { listAllTrackBranches, trackBranchContaining, type TrackBranch } from '../projects/track-store.js';
import { isTrackError } from '../projects/routes.js';
import { installDependencies, needsInstall, type InstallResult } from '../projects/project-deps.js';
import { ensureLocalClaudeSettings } from '../projects/local-claude-settings.js';
import { PROMPT_GRACE_MS, promptDelivery, type PromptDelivery } from './prompt-delivery.js';

const logger = createLogger('agent-sessions');

/**
 * Sessions that start sessions (docs/session-orchestration.md).
 *
 * A main session's agent calls these through scripts/cr-session.mjs to start a
 * prompted session on one of its planned tracks, and to list the ones it
 * started; a track's session calls the land and update routes to land its own
 * track or merge main into it, and a parent to do either for a track one of
 * its started sessions worked in.
 * They start a shell and type into it, or close sessions, so unlike the rest of /api/*
 * they authenticate: the request must come from loopback AND carry the
 * calling session's in-memory token (sessionEnv()). Either alone is not
 * enough — the server listens on 0.0.0.0, and any local process can reach
 * loopback.
 */

/**
 * `bypassPermissions` is deliberately absent: the user would have to read the
 * flags to notice it. So is `dontAsk`: it denies whatever isn't pre-allowed, so
 * a session would fail quietly instead of asking. `auto` is the default — a
 * started session exists to run unattended, and auto still asks before risky
 * actions (project/unattended-started-sessions.md).
 */
export const PERMISSION_MODES = ['auto', 'manual', 'acceptEdits', 'plan'] as const;
export type PermissionMode = (typeof PERMISSION_MODES)[number];
export const DEFAULT_PERMISSION_MODE: PermissionMode = 'auto';

/** Older names still sent by a skill copy installed before `manual` existed. */
const MODE_ALIASES: Record<string, PermissionMode> = { default: 'manual' };

/**
 * The typed command. `flags` is the launch profile's (`launchFlags()`): the
 * permission mode — `manual` passes none, since Claude Code has renamed its
 * default (it lists `manual`, no longer `default`) and leaving the flag out gets
 * the default under either name — then `--strict-mcp-config` and any scoped
 * `--mcp-config`, so the session loads only the MCP servers its start named
 * (project/lean-started-sessions.md). `--add-dir` is the session's own
 * prompt folder only, so it reads its prompt without asking and no other's.
 * `--` before the prompt is required: `--add-dir` takes several directories,
 * and without it the prompt is read as one more, so the session starts idle.
 * `--name` makes the session show in `ListAgents` under its claude-remote name.
 */
export function startCommand(flags: string, promptDir: string, promptPath: string, name?: string): string {
  return `claude ${flags}--add-dir "${promptDir}"${claudeNameFlag(name)} -- "Read ${promptPath} and follow it."`;
}

export const MAX_PROMPT_BYTES = 100 * 1024;
const MAX_NAME_LENGTH = 100;

// IPv4-mapped 127.0.0.1 is the same address, seen when the server binds `::`.
const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

export class AgentSessionError extends Error {
  constructor(
    public readonly status: number,
    message: string
  ) {
    super(message);
  }
}

export interface AgentSessionDeps {
  sessionForToken(token: string): string | null;
  getSession(id: string): SessionMetadata | null;
  listSessions(): (SessionMetadata & { attachable: boolean })[];
  projectForCwd(cwd: string): RegistryProject | null;
  trackExists(project: RegistryProject, track: string): boolean;
  /** Every track branch, read once per request to name each child's track. */
  trackBranches(): Pick<TrackBranch, 'worktreePath' | 'trackName'>[];
  ensureTrackBranch(project: RegistryProject, track: string): Promise<{ worktreePath: string }>;
  needsInstall(path: string): boolean;
  installDependencies(path: string): Promise<InstallResult>;
  ensureLocalClaudeSettings(projectCwd: string, worktreePath: string): Promise<unknown>;
  createSession(options: SessionCreateOptions): Promise<ActiveSession>;
  deleteSession(id: string): Promise<unknown>;
  writePromptFile(sessionId: string, prompt: string): string;
  /** MCP servers a session in `cwd` can be given by name (launch-profile.ts). */
  /** The MCP servers `account`'s config defines that a session in `cwd` can be given. */
  mcpServersFor(cwd: string, account: string): string[];
  /** The profile's flags for a launch; writes the scoped MCP config (launch-profile.ts). */
  launchFlags(sessionId: string, cwd: string, profile: LaunchProfile, account: string): LaunchFlags;
  /** Is the account's expected login in its folder (accounts.ts preflight)? */
  preflight(account: string): PreflightResult;
  /** Record the MCP servers a session actually got, when its launch dropped some. */
  setMcpServers(id: string, servers: string[]): void;
  injectCommand(session: ActiveSession, line: string): void;
  lastNotification(id: string): { type: NotificationType; timestamp: Date } | undefined;
  broadcastAdded(session: SessionInfo): void;
  maxPerParent(): number;
  /** Whether a started session's agent got its prompt (agent/prompt-delivery.ts). */
  promptDelivery(session: SessionMetadata): PromptDelivery;
  notifyPromptMissing(payload: PromptMissingNotificationPayload): void;
  /** Run `fn` once after `ms`; never keeps the process alive. */
  schedule(fn: () => void, ms: number): void;
}

/**
 * The workspace project a session's cwd belongs to: its main checkout or one
 * of its track worktrees, or a folder below either. Null for anything else.
 *
 * A project *above* the cwd only counts when it has a plan file. Discovery
 * lists every folder Claude ever ran in — the home folder included — and
 * taking that as the project would answer "no such track" to a session that
 * is simply in no project.
 */
export function projectForCwd(cwd: string): RegistryProject | null {
  const branch = trackBranchContaining(cwd);
  const target = branch ? branch.projectCwd : cwd;
  let candidates: string[];
  try {
    const registry = loadRegistry();
    candidates = [...registry.projects.map((p) => p.cwd), ...listBoardCwds(registry)];
  } catch (error) {
    logger.warn({ error }, 'agent-sessions: could not read the project registry');
    return null;
  }
  // Deepest first: a project nested in another's folder is its own project.
  const containing = candidates.filter((c) => isInside(c, target)).sort((a, b) => b.length - a.length);
  for (const c of containing) {
    const project = findWorkspaceProject(c);
    if (!project) continue;
    if (isInside(target, c) || existsSync(join(project.cwd, project.doc ?? 'PROJECT.md'))) return project;
  }
  return null;
}

/** Still running: a PTY exists and its shell has not exited. */
function isLive(s: { attachable: boolean; status: string }): boolean {
  return s.attachable && s.status !== 'terminated';
}

function trackOf(branches: Pick<TrackBranch, 'worktreePath' | 'trackName'>[], cwd: string): string | null {
  return branches.find((b) => isInside(b.worktreePath, cwd))?.trackName ?? null;
}

export const defaultDeps: AgentSessionDeps = {
  sessionForToken,
  getSession: getSessionFromDb,
  listSessions: () => sessionManager.getSessionList(),
  projectForCwd,
  trackExists: (project, track) => readProjectPlan(project).doc.tracks.some((t) => t.name === track),
  trackBranches: listAllTrackBranches,
  ensureTrackBranch,
  needsInstall,
  installDependencies: (path) => installDependencies(path),
  ensureLocalClaudeSettings,
  createSession: (options) => sessionManager.createSession(options),
  deleteSession: (id) => sessionManager.deleteSession(id),
  writePromptFile,
  mcpServersFor: (cwd, account) => [...availableMcpServers(cwd, claudeJsonPath(account)).keys()],
  launchFlags: (sessionId, cwd, profile, account) => launchFlags(sessionId, cwd, profile, claudeJsonPath(account)),
  preflight: (account) => preflight(account),
  setMcpServers: setSessionMcpServers,
  injectCommand,
  lastNotification: (id) => notificationService.getSessionNotification(id),
  broadcastAdded: broadcastSessionAdded,
  maxPerParent: () => getConfig().agentSessions.maxPerParent,
  promptDelivery: (session) => promptDelivery(session),
  notifyPromptMissing: broadcastPromptMissing,
  schedule: (fn, ms) => {
    setTimeout(fn, ms).unref();
  },
};

/** The calling session's id, or an error naming why the request is refused. */
export function authenticate(
  request: Pick<FastifyRequest, 'headers'> & { socket: { remoteAddress?: string } },
  deps: Pick<AgentSessionDeps, 'sessionForToken'>
): string {
  // The socket's address only: X-Forwarded-For is whatever the client wrote.
  if (!LOOPBACK.has(request.socket.remoteAddress ?? '')) {
    throw new AgentSessionError(403, 'Agent-session routes answer only on loopback');
  }
  const header = request.headers.authorization;
  const match = typeof header === 'string' ? /^Bearer\s+(\S+)$/.exec(header) : null;
  const caller = match ? deps.sessionForToken(match[1]) : null;
  if (!caller) throw new AgentSessionError(401, 'Missing or unknown session token');
  return caller;
}

export interface StartBody {
  track?: unknown;
  prompt?: unknown;
  name?: unknown;
  permissionMode?: unknown;
  mcpServers?: unknown;
  /** Always the caller's Claude login; naming any other is refused (403). */
  account?: unknown;
}

export interface StartResult {
  sessionId: string;
  name: string;
  account: string;
  worktreePath: string;
  install: InstallResult;
  /** The MCP servers it got; `ok` false when the launch couldn't give it every one asked for. */
  mcp: { ok: boolean; servers: string[]; detail?: string };
}

// Starts that have passed the limit check but not yet created their session
// (an install can take minutes). Counted toward the limit, or two concurrent
// starts would both pass it.
const pendingStarts = new Map<string, number>();
// The same, by caller and track: a start the agent gave up on (its Bash call
// timed out) keeps running here, and a retry must not start a second session.
const pendingTracks = new Set<string>();

function liveChildren(deps: AgentSessionDeps, parentId: string) {
  return deps.listSessions().filter((s) => s.spawnedBy === parentId && isLive(s));
}

export async function startAgentSession(
  deps: AgentSessionDeps,
  callerId: string,
  body: StartBody
): Promise<StartResult> {
  const caller = deps.getSession(callerId);
  if (!caller) throw new AgentSessionError(401, 'The calling session no longer exists');
  // One level only: keeps the sidebar to one level of nesting and stops a runaway chain.
  if (caller.spawnedBy) throw new AgentSessionError(403, 'A started session cannot start sessions');

  const children = liveChildren(deps, callerId);
  const limit = deps.maxPerParent();
  if (children.length + (pendingStarts.get(callerId) ?? 0) >= limit) {
    throw new AgentSessionError(429, `This session already has ${limit} started sessions running`);
  }

  const track = typeof body.track === 'string' ? body.track.trim() : '';
  if (!track) throw new AgentSessionError(400, 'track is required');
  if (typeof body.prompt !== 'string' || !body.prompt.trim()) {
    throw new AgentSessionError(400, 'prompt is required');
  }
  const prompt = body.prompt;
  if (Buffer.byteLength(prompt, 'utf-8') > MAX_PROMPT_BYTES) {
    throw new AgentSessionError(413, `prompt is over ${MAX_PROMPT_BYTES / 1024} KB`);
  }
  const asked = body.permissionMode === undefined ? DEFAULT_PERMISSION_MODE : body.permissionMode;
  const mode = typeof asked === 'string' ? (MODE_ALIASES[asked] ?? asked) : asked;
  if (typeof mode !== 'string' || !(PERMISSION_MODES as readonly string[]).includes(mode)) {
    throw new AgentSessionError(400, `permissionMode must be one of: ${PERMISSION_MODES.join(', ')}`);
  }
  const permissionMode = mode as PermissionMode;
  let name = track;
  if (body.name !== undefined) {
    if (typeof body.name !== 'string' || !body.name.trim()) throw new AgentSessionError(400, 'name must be a non-empty string');
    name = body.name.trim().slice(0, MAX_NAME_LENGTH);
  }
  const mcpServers = parseMcpServers(body.mcpServers);
  if (typeof mcpServers === 'string') throw new AgentSessionError(400, mcpServers);

  if (body.account !== undefined && !isAccount(body.account)) {
    throw new AgentSessionError(400, `account must be one of: ${accountNames().join(', ')}`);
  }
  // A started session runs under its caller's login, never another: one token
  // must not reach a second account (personal work on the org's collector, or
  // the reverse). Naming the caller's own account is allowed, any other refused.
  const account = caller.account;
  if (body.account !== undefined && body.account !== account) {
    throw new AgentSessionError(
      403,
      `This session runs under account "${account}"; the sessions it starts run under it too, not "${body.account}"`
    );
  }

  const project = deps.projectForCwd(caller.cwd);
  if (!project) throw new AgentSessionError(400, `${caller.cwd} is not in a workspace project`);
  // Before the branch, worktree and install: a start on the wrong login creates nothing.
  // The message names who is logged in and who is expected.
  const ready = deps.preflight(account);
  if (!ready.ok) throw new AccountRefusedError(ready);
  // The agent can only start work on a track somebody planned, never invent one.
  if (!deps.trackExists(project, track)) {
    throw new AgentSessionError(404, `No track "${track}" in ${project.cwd}'s PROJECT.md`);
  }
  if (mcpServers.length > 0) {
    // Before anything is created: a session missing the server its task needs
    // would fail halfway through. Looked up from the project, where its worktree
    // will be; plugin servers and claude.ai connectors can't be scoped.
    const available = deps.mcpServersFor(project.cwd, account);
    const unknown = mcpServers.filter((n) => !available.includes(n));
    if (unknown.length > 0) {
      throw new AgentSessionError(
        400,
        `No MCP server ${unknown.map((n) => `"${n}"`).join(', ')} in your Claude config. ` +
          (available.length ? `Servers you can pass: ${available.join(', ')}` : 'It defines none that can be passed.')
      );
    }
  }

  // One live session per caller and track. Nothing between the limit check and
  // the bookkeeping below awaits, so concurrent starts cannot both get past it.
  const trackKey = `${callerId}\0${track}`;
  const branches = deps.trackBranches();
  const running = children.find((s) => trackOf(branches, s.cwd) === track);
  if (pendingTracks.has(trackKey) || running) {
    throw new AgentSessionError(
      409,
      running
        ? `This session already started "${running.name}" (${running.id}) on "${track}"; run list`
        : `A start on "${track}" from this session is still in progress; run list in a minute`
    );
  }

  pendingStarts.set(callerId, (pendingStarts.get(callerId) ?? 0) + 1);
  pendingTracks.add(trackKey);
  try {
    // Exactly what the Track picker does: branch, then the worktree's own install.
    const branch = await deps.ensureTrackBranch(project, track);
    const worktreePath = branch.worktreePath;
    let install: InstallResult = { ran: false, ok: true, detail: 'nothing to install' };
    if (deps.needsInstall(worktreePath)) {
      // A failed install still starts the session, as for a track session the
      // user opens; the response carries the failure for the agent to pass on.
      install = await deps.installDependencies(worktreePath);
    }
    // Before the session exists: Claude reads it at startup, and without it
    // the session asks again for every MCP server the user already approved.
    await deps.ensureLocalClaudeSettings(project.cwd, worktreePath);

    let session: ActiveSession;
    try {
      session = await deps.createSession({
        name,
        cwd: worktreePath,
        ownerId: caller.ownerId ?? undefined,
        spawnedBy: callerId,
        permissionMode,
        mcpServers,
        account,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/maximum session limit/i.test(message)) throw new AgentSessionError(429, message);
      throw error;
    }

    let promptPath: string;
    let promptDir: string;
    try {
      // Forward slashes, so neither PowerShell nor bash reads a backslash as an escape.
      promptPath = deps.writePromptFile(session.id, prompt).replace(/\\/g, '/');
      promptDir = promptPath.slice(0, promptPath.lastIndexOf('/'));
      if (UNSAFE_IN_QUOTES.test(promptPath)) {
        // A typed command that read the wrong file would fail silently.
        throw new AgentSessionError(500, `The prompt path ${promptPath} has a character no shell quotes safely`);
      }
    } catch (error) {
      await deps.deleteSession(session.id).catch(() => {});
      throw error;
    }

    const launch = deps.launchFlags(session.id, worktreePath, { permissionMode, mcpServers }, account);
    deps.injectCommand(session, startCommand(launch.flags, promptDir, promptPath, session.name));
    // The check above passed, so this is a config edited since, or a file that couldn't be
    // written. Started anyway, like a failed install: the row and `list` say what it really
    // has, and the response tells the agent, which would otherwise count on the server.
    const loaded = launch.mcpServers ?? [];
    const missing = mcpServers.filter((n) => !loaded.includes(n));
    if (missing.length > 0) deps.setMcpServers(session.id, loaded);
    const mcp = missing.length
      ? { ok: false, servers: loaded, detail: `Started without ${missing.join(', ')}: see the server log` }
      : { ok: true, servers: loaded };

    const metadata = deps.getSession(session.id);
    deps.broadcastAdded(
      sessionToInfo({
        ...session,
        ...(metadata ?? {}),
        attachable: true,
        spawnedBy: callerId,
        permissionMode,
      })
    );

    deps.schedule(() => checkPromptArrived(deps, session.id), PROMPT_GRACE_MS);

    logger.info({ callerId, sessionId: session.id, track, mode: permissionMode, mcpServers, account }, 'agent-sessions: started a session');
    return { sessionId: session.id, name, account, worktreePath, install, mcp };
  } finally {
    const left = (pendingStarts.get(callerId) ?? 1) - 1;
    if (left > 0) pendingStarts.set(callerId, left);
    else pendingStarts.delete(callerId);
    pendingTracks.delete(trackKey);
  }
}

/**
 * Once, a grace period after a start: tell the user when the prompt never
 * reached the agent. Its parent only learns through `list`, and a session
 * that never got its prompt looks just like one that is working. A session
 * already deleted or exited is left alone: somebody has dealt with it.
 */
export function checkPromptArrived(deps: AgentSessionDeps, sessionId: string): void {
  try {
    const session = deps.listSessions().find((s) => s.id === sessionId);
    if (!session || !isLive(session)) return;
    const delivery = deps.promptDelivery(session);
    if (delivery.state !== 'not-received') return;
    logger.warn({ sessionId, detail: delivery.detail }, 'agent-sessions: a started session never got its prompt');
    deps.notifyPromptMissing({
      kind: 'prompt-missing',
      sessionId,
      name: session.name,
      detail: delivery.detail ?? 'The prompt never reached it',
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    logger.warn({ error, sessionId }, 'agent-sessions: could not check whether a started session got its prompt');
  }
}

export interface StartedSessionState {
  id: string;
  name: string;
  track: string | null;
  status: string;
  attachable: boolean;
  permissionMode: string | null;
  /** The MCP servers it loads: `[]` is none, null the user's full roster. */
  mcpServers: string[] | null;
  /** The Claude login it runs under. */
  account: string;
  notification: { type: NotificationType; at: string } | null;
  /** `pending` until the grace period ends; `not-received` is a session that will never start on its own. */
  prompt: PromptDelivery;
}

export function listAgentSessions(deps: AgentSessionDeps, callerId: string): StartedSessionState[] {
  const branches = deps.trackBranches();
  return deps
    .listSessions()
    .filter((s) => s.spawnedBy === callerId)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    .map((s) => {
      const n = deps.lastNotification(s.id);
      return {
        id: s.id,
        name: s.name,
        track: trackOf(branches, s.cwd),
        status: s.status,
        // Live, not merely "has a PTY object": a shell that exited keeps its PTY
        // entry until the user deletes it, and that child is done.
        attachable: isLive(s),
        // Rows started before `manual` existed are stored as `default`.
        permissionMode: s.permissionMode ? (MODE_ALIASES[s.permissionMode] ?? s.permissionMode) : null,
        mcpServers: s.mcpServers ?? null,
        account: s.account,
        notification: n ? { type: n.type, at: n.timestamp.toISOString() } : null,
        prompt: deps.promptDelivery(s),
      };
    });
}

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
  /** Phase 2: close the worktree's sessions, land under the lock, rebuild. */
  land(project: RegistryProject, trackName: string): Promise<{ detail: string }>;
  notify(payload: LandNotificationPayload): void;
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
  land: (project, trackName) =>
    landAndBuild(project, trackName, {
      sessions: sessionManager.getRunningSessions().map((s) => ({ id: s.id, cwd: s.cwd })),
      terminateSession: (id) => sessionManager.terminateSession(id),
      removeSessions: removeWorktreeSessions,
    }),
  notify: broadcastLandResult,
};

export interface AcceptedLand {
  project: RegistryProject;
  track: string;
  /** The caller is in the track's worktree, so the Land closes it too. */
  closesCaller: boolean;
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
  await deps.preflight(project, branch.trackName);
  // Again after the await, in case another request was accepted meanwhile.
  if (landsUnderWay.has(key)) {
    throw new AgentSessionError(409, `A Land of "${branch.trackName}" is already under way; its result comes as a notification`);
  }
  landsUnderWay.add(key);
  return { project, track: branch.trackName, closesCaller };
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

function isKnownError(error: unknown): error is StatusError {
  return error instanceof AgentSessionError || error instanceof AccountRefusedError || isTrackError(error);
}

function sendError(reply: FastifyReply, error: unknown): unknown {
  return replyWithError(reply, error, { known: isKnownError, logger, message: 'agent-sessions: request failed' });
}

export function registerAgentSessionRoutes(
  app: FastifyInstance,
  deps: AgentSessionDeps = defaultDeps,
  landDeps: AgentLandDeps = defaultLandDeps,
  updateDeps: AgentUpdateDeps = defaultUpdateDeps
): void {
  app.post<{ Body?: TrackBody }>('/api/agent/update', async (request, reply) => {
    try {
      const callerId = authenticate(request, deps);
      return await requestUpdate(updateDeps, callerId, (request.body ?? {}) as TrackBody);
    } catch (error) {
      return sendError(reply, error);
    }
  });

  // Phase 2 of each accepted Land, run once its 202 has been sent: the Land
  // closes the session that asked, and its agent must have its answer first.
  const acceptedLands = new WeakMap<FastifyRequest, AcceptedLand>();
  app.post<{ Body?: TrackBody }>(
    '/api/agent/land',
    {
      onResponse: async (request) => {
        const accepted = acceptedLands.get(request);
        if (!accepted) return;
        acceptedLands.delete(request);
        void runRequestedLand(landDeps, accepted);
      },
      // The agent went away before its answer: never land behind its back, and
      // don't leave the track marked as under way.
      onRequestAbort: async (request) => {
        const accepted = acceptedLands.get(request);
        if (!accepted) return;
        acceptedLands.delete(request);
        dropAcceptedLand(accepted);
      },
    },
    async (request, reply) => {
      try {
        const callerId = authenticate(request, deps);
        const accepted = await requestLand(landDeps, callerId, (request.body ?? {}) as TrackBody);
        acceptedLands.set(request, accepted);
        const closing = accepted.closesCaller ? 'this session will close' : "the track's sessions will close";
        return reply.code(202).send({
          accepted: true,
          track: accepted.track,
          closesCaller: accepted.closesCaller,
          detail: `Land of "${accepted.track}" accepted; ${closing}. The result is sent as a notification.`,
        });
      } catch (error) {
        return sendError(reply, error);
      }
    }
  );

  app.post<{ Body?: StartBody }>('/api/agent/sessions', async (request, reply) => {
    try {
      const callerId = authenticate(request, deps);
      return await startAgentSession(deps, callerId, (request.body ?? {}) as StartBody);
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.get('/api/agent/sessions', async (request, reply) => {
    try {
      const callerId = authenticate(request, deps);
      return { sessions: listAgentSessions(deps, callerId) };
    } catch (error) {
      return sendError(reply, error);
    }
  });
}
