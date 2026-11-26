import type { FastifyInstance } from 'fastify';
import { getConfig, setFactoryReviewConfig } from '../config.js';
import { createLogger } from '../utils/logger.js';
import { isAllowedWebSocketOrigin } from '../websocket/origin.js';
import { extractIpFromRequest, verifyTailscaleConnection } from '../auth/tailscale.js';
import { DEFAULT_FACTORY_LIMITS, type FactoryLimits } from './limits.js';
import { FIX_LOOP_MAX } from './templates.js';
import { REVIEW_GRANULARITIES, type ReviewGranularity } from './types.js';

const logger = createLogger('factory-settings');

/**
 * Settings → Factory (project/code-factory.md, "The review gate is an agent by
 * default, configurable"). Kept in the server's config (`factory.review`), like
 * Settings → Sessions, and read on every review, so a change applies to the
 * next unit reviewed without a restart.
 */

/** Who decides a unit's review: the reviewer agent, the agent with escalation rules, or the user. */
export type ReviewMode = 'agent' | 'agent-escalate' | 'me';

export const REVIEW_MODES: readonly ReviewMode[] = ['agent', 'agent-escalate', 'me'];

/** The escalation rules, each a switch. Only applied in `agent-escalate` mode. */
export interface EscalationRules {
  /** Touches auth/, the access gate, accounts or migrations (src/server/db/schema.ts). */
  sensitivePaths: boolean;
  /** Changes more than `largeDiffLines` lines, tests, lockfiles and generated files excluded. */
  largeDiff: boolean;
  /** The unit needed the full fix-loop count before the reviewer approved it. */
  fixLoops: boolean;
  /** The summary lists assumptions the unit made instead of asking. */
  assumptions: boolean;
  /** A package.json gains a dependency. */
  newDependency: boolean;
}

export type RuleKey = keyof EscalationRules;

export const RULE_KEYS: readonly RuleKey[] = ['sensitivePaths', 'largeDiff', 'fixLoops', 'assumptions', 'newDependency'];

export interface FactoryReviewSettings {
  mode: ReviewMode;
  rules: EscalationRules;
  largeDiffLines: number;
  granularity: ReviewGranularity;
}

export const LARGE_DIFF_RANGE = { min: 50, max: 100_000 } as const;

export const DEFAULT_REVIEW_SETTINGS: FactoryReviewSettings = {
  mode: 'agent-escalate',
  rules: { sensitivePaths: true, largeDiff: true, fixLoops: true, assumptions: true, newDependency: false },
  largeDiffLines: 600,
  granularity: 'track',
};

const isObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);

const isLines = (v: unknown): v is number =>
  typeof v === 'number' && Number.isInteger(v) && v >= LARGE_DIFF_RANGE.min && v <= LARGE_DIFF_RANGE.max;

/**
 * The settings in force: what config.json holds, each unusable value (a
 * hand-edited typo) replaced by its default rather than failing the review.
 */
export function factoryReviewSettings(raw: unknown = getConfig().factory?.review): FactoryReviewSettings {
  const d = DEFAULT_REVIEW_SETTINGS;
  const r = isObject(raw) ? raw : {};
  const rules = isObject(r.rules) ? r.rules : {};
  return {
    mode: (REVIEW_MODES as readonly unknown[]).includes(r.mode) ? (r.mode as ReviewMode) : d.mode,
    rules: Object.fromEntries(
      RULE_KEYS.map((k) => [k, typeof rules[k] === 'boolean' ? rules[k] : d.rules[k]])
    ) as unknown as EscalationRules,
    largeDiffLines: isLines(r.largeDiffLines) ? r.largeDiffLines : d.largeDiffLines,
    granularity: (REVIEW_GRANULARITIES as readonly unknown[]).includes(r.granularity)
      ? (r.granularity as ReviewGranularity)
      : d.granularity,
  };
}

/** A checked patch, or why the body is refused. Every key is checked before any is kept. */
export function checkReviewPatch(body: unknown): { patch: Partial<FactoryReviewSettings> } | { error: string } {
  if (!isObject(body)) return { error: 'Send a JSON object' };
  const patch: Partial<FactoryReviewSettings> = {};
  if ('mode' in body) {
    if (!(REVIEW_MODES as readonly unknown[]).includes(body.mode)) return { error: `mode must be one of ${REVIEW_MODES.join(', ')}` };
    patch.mode = body.mode as ReviewMode;
  }
  if ('granularity' in body) {
    if (!(REVIEW_GRANULARITIES as readonly unknown[]).includes(body.granularity)) {
      return { error: `granularity must be one of ${REVIEW_GRANULARITIES.join(', ')}` };
    }
    patch.granularity = body.granularity as ReviewGranularity;
  }
  if ('largeDiffLines' in body) {
    if (!isLines(body.largeDiffLines)) {
      return { error: `The diff size must be a whole number from ${LARGE_DIFF_RANGE.min} to ${LARGE_DIFF_RANGE.max}` };
    }
    patch.largeDiffLines = body.largeDiffLines;
  }
  if ('rules' in body) {
    if (!isObject(body.rules)) return { error: 'rules must be an object' };
    const rules: Partial<EscalationRules> = {};
    for (const [key, value] of Object.entries(body.rules)) {
      if (!(RULE_KEYS as readonly string[]).includes(key)) return { error: `Unknown rule ${key}` };
      if (typeof value !== 'boolean') return { error: `Rule ${key} must be true or false` };
      rules[key as RuleKey] = value;
    }
    // Merged over the rules in force: a client sending one switch keeps the others.
    patch.rules = { ...factoryReviewSettings().rules, ...rules };
  }
  if (Object.keys(patch).length === 0) return { error: 'Nothing to change: send mode, rules, largeDiffLines or granularity' };
  return { patch };
}

export interface FactorySettingsView extends FactoryReviewSettings {
  largeDiffRange: { min: number; max: number };
  fixLoopMax: number;
  /** The engine's dispatch limits (limits.ts), shown read-only. */
  limits: FactoryLimits;
}

export interface FactorySettingsDeps {
  verify?: (ip: string) => Promise<unknown>;
}

export function registerFactorySettingsRoutes(app: FastifyInstance, deps: FactorySettingsDeps = {}): void {
  const verify = deps.verify ?? verifyTailscaleConnection;
  const view = (): FactorySettingsView => ({
    ...factoryReviewSettings(),
    largeDiffRange: { ...LARGE_DIFF_RANGE },
    fixLoopMax: FIX_LOOP_MAX,
    limits: { ...DEFAULT_FACTORY_LIMITS },
  });

  app.get('/api/factory/settings', async () => view());

  app.put<{ Body?: unknown }>('/api/factory/settings', async (request, reply) => {
    // Writes the config file: the same checks as the session limits (server-settings.ts).
    if (!isAllowedWebSocketOrigin(request.headers.origin, request.headers.host)) {
      logger.warn({ origin: request.headers.origin }, 'factory settings write rejected: cross-origin');
      return reply.status(403).send({ error: 'Cross-origin request refused' });
    }
    if (!(await verify(extractIpFromRequest(request)))) {
      return reply.status(403).send({ error: 'Not authorized' });
    }
    const checked = checkReviewPatch(request.body ?? {});
    if ('error' in checked) return reply.status(400).send({ error: checked.error });
    try {
      setFactoryReviewConfig(checked.patch as Record<string, unknown>);
    } catch (error) {
      logger.error({ error: error instanceof Error ? error.message : String(error) }, 'could not save the factory settings');
      // Generic: the message can name the config path and quote part of the file.
      return reply.status(500).send({ error: 'Could not save the factory settings; the server log has the reason.' });
    }
    return view();
  });
}
