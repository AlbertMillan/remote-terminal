import { createLogger } from '../utils/logger.js';
import type { RegistryProject } from '../projects/registry.js';
import { readProjectPlan } from '../projects/project-plan.js';
import { featuresOf } from '../projects/project-doc-format.js';
import { ensureTrackBranch } from '../projects/track-branches.js';
import type { TrackBranch } from '../projects/track-store.js';
import { commitWorktreePlanning, docRelOf, nameFiles } from '../projects/track-plan.js';
import { withProjectLock } from '../projects/project-lock.js';
import { getDispatcher } from './dispatcher.js';
import { INBOX_TRACK } from './plan-lines.js';
import { factoryReviewSettings } from './review-settings.js';
import { MODEL_TIERS } from './shape-step.js';
import { deleteRunState, unitIdFor } from './run-state.js';
import { createItem, deleteItem, getItem, listItems } from './store.js';
import { isTrackWorkflow, TRACK_TEMPLATE } from './templates.js';
import { CLOSED_STATUSES, DEFAULT_PRIORITY, REVIEW_GRANULARITIES, type ReviewGranularity } from './types.js';

const logger = createLogger('factory-send');

/**
 * Sending a planned track to the factory (project/code-factory.md: "A planned
 * track — planned and specced in a session"). No planner, spec or mockup
 * step: the spec is the input. The track's open features become items of the
 * `track` workflow, which one agent works in order in the track's worktree,
 * one commit per feature, reviewed per track or per feature.
 *
 * ▶ on a Workspace track sends with nothing overridden (Settings defaults); a
 * session that planned the track may override the review granularity and the
 * model per feature.
 */

export class SendError extends Error {
  constructor(
    public readonly status: number,
    message: string
  ) {
    super(message);
    this.name = 'SendError';
  }
}

export interface SendInput {
  project: RegistryProject;
  track: unknown;
  review?: unknown;
  models?: unknown;
}

export interface SentFeature {
  featureId: string;
  title: string;
  model: string | null;
  /** `queued` now, or already in the factory from an earlier send. */
  state: 'queued' | 'already queued';
}

export interface SendPlan {
  track: string;
  branch: string;
  worktreePath: string;
  /** The granularity in force: the override, else Settings → Factory's. */
  review: ReviewGranularity;
  reviewOverridden: boolean;
  features: SentFeature[];
}

export interface SendResult {
  queued: string[];
  plan: SendPlan;
}

export interface SendDeps {
  ensureTrackBranch(project: RegistryProject, track: string): Promise<TrackBranch>;
  /** Commit the worktree's planning files; the code paths still uncommitted, or null when clean. */
  commitPlanning(worktreePath: string, docRel: string, message: string): Promise<string[] | null>;
}

export const defaultSendDeps: SendDeps = {
  ensureTrackBranch,
  commitPlanning: commitWorktreePlanning,
};

// A model alias or a full model id; claude-run passes nothing else to the shell anyway.
const MODEL = /^claude-[a-z0-9.-]+$/;

function checkModels(models: unknown, featureIds: Set<string>): Record<string, string> {
  if (models === undefined || models === null) return {};
  if (typeof models !== 'object' || Array.isArray(models)) throw new SendError(400, 'models must map feature ids to a model');
  const out: Record<string, string> = {};
  for (const [id, tier] of Object.entries(models as Record<string, unknown>)) {
    if (!featureIds.has(id)) throw new SendError(400, `${id} is not an open feature of this track`);
    if (typeof tier !== 'string' || !((MODEL_TIERS as readonly string[]).includes(tier) || MODEL.test(tier))) {
      throw new SendError(400, `The model for ${id} must be one of ${MODEL_TIERS.join(', ')} or a claude-… model id`);
    }
    out[id] = tier;
  }
  return out;
}

export async function sendTrack(input: SendInput, deps: SendDeps = defaultSendDeps): Promise<SendResult> {
  const { project } = input;
  if (typeof input.track !== 'string' || !input.track.trim()) throw new SendError(400, 'track is required');
  const trackName = input.track.trim();
  if (trackName === INBOX_TRACK) {
    throw new SendError(400, 'The Inbox holds loose work, which runs item by item: file work with "factory add" instead');
  }
  if (input.review !== undefined && input.review !== null && !(REVIEW_GRANULARITIES as readonly unknown[]).includes(input.review)) {
    throw new SendError(400, `review must be one of ${REVIEW_GRANULARITIES.join(', ')}`);
  }
  const review = (input.review ?? null) as ReviewGranularity | null;

  const track = readProjectPlan(project).doc.tracks.find((t) => t.name === trackName);
  if (!track) throw new SendError(404, `No track "${trackName}" in this project's plan`);
  const open = featuresOf(track).filter((f) => f.status !== 'done' && f.id);
  if (open.length === 0) throw new SendError(400, `"${trackName}" has no open features to send`);
  const models = checkModels(input.models, new Set(open.map((f) => f.id)));

  // One unit per track at a time. Features sent beside a unit still in the
  // factory would be outside its claimed set and its progress (featuresDone);
  // they wait for it to finish.
  const running = listItems({ projectCwd: project.cwd }).filter(
    (i) => i.trackName === trackName && isTrackWorkflow(i.workflow) && !CLOSED_STATUSES.includes(i.status)
  );
  if (running.length > 0) {
    throw new SendError(
      409,
      `"${trackName}" is already in the factory (${running.map((i) => i.featureId).join(', ')}); send the rest once it has finished`
    );
  }

  const fresh = open.filter((f) => {
    const item = getItem(project.cwd, f.id);
    return !item || CLOSED_STATUSES.includes(item.status);
  });
  if (fresh.length === 0) throw new SendError(409, `Every open feature of "${trackName}" is already in the factory`);

  // The factory works the track in its worktree: create it now (moving the
  // plan there) so the run finds it, and so the user sees the branch at once.
  const branch = await deps.ensureTrackBranch(project, trackName);
  // A fresh unit refuses a dirty worktree. Planning files (a session's spec and
  // plan edits) are committed for it; code someone is still editing is not.
  const left = await withProjectLock(project.cwd, `sending "${trackName}" to the factory`, () =>
    deps.commitPlanning(branch.worktreePath, docRelOf(project), `plan: "${trackName}" as sent to the factory`)
  );
  if (left && left.length > 0) {
    throw new SendError(409, `The track's worktree has uncommitted changes (${nameFiles(left)}); commit or stash them first`);
  }

  // Every earlier unit of this track is closed: start its progress over. Kept,
  // a merged unit stays handed off (dispatch never claims it again) and any
  // other resumes a finished walk, releasing its claims without doing the work.
  deleteRunState(project.cwd, unitIdFor({ featureId: '', trackName }, true));

  const queued: string[] = [];
  for (const f of fresh) {
    // A feature reopened after the factory closed it (cancelled, or ticked
    // back) runs again as a new item.
    if (getItem(project.cwd, f.id)) deleteItem(project.cwd, f.id);
    createItem({
      projectCwd: project.cwd,
      featureId: f.id,
      trackName,
      workflow: TRACK_TEMPLATE.name,
      priority: f.priority && f.priority >= 1 ? f.priority : DEFAULT_PRIORITY,
      modelTier: models[f.id] ?? null,
      reviewGranularity: review,
    });
    queued.push(f.id);
  }
  logger.info({ cwd: project.cwd, track: trackName, queued, review }, 'factory: track sent');
  void getDispatcher()?.tick();

  return {
    queued,
    plan: {
      track: trackName,
      branch: branch.branch,
      worktreePath: branch.worktreePath,
      review: review ?? factoryReviewSettings().granularity,
      reviewOverridden: review !== null,
      features: open.map((f) => ({
        featureId: f.id,
        title: f.title,
        model: queued.includes(f.id) ? (models[f.id] ?? null) : (getItem(project.cwd, f.id)?.modelTier ?? null),
        state: queued.includes(f.id) ? 'queued' : 'already queued',
      })),
    },
  };
}
