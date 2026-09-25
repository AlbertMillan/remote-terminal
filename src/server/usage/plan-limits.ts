import { existsSync, readFileSync, renameSync, writeFileSync } from 'fs';
import { join } from 'path';
import { getConfig } from '../config.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('plan-usage');

/**
 * The Pro/Max plan's usage limits, as Claude Code reports them to its status
 * line: `rate_limits.five_hour` and `rate_limits.seven_day`, each
 * `{ used_percentage, resets_at }`. See docs/plan-usage.md.
 *
 * These cannot be computed from the usage ledger's token counts — the limits
 * are weighted by model and their sizes are not published — so the status
 * line, relayed by scripts/statusline.mjs, is the only documented source.
 */

export interface WindowReading {
  /** 0–100, as Claude Code reports it. */
  usedPercentage: number;
  /** Unix seconds. */
  resetsAt: number;
  /** When a reading last confirmed this value (ISO). */
  observedAt: string;
}

export interface PlanUsageSnapshot {
  fiveHour: WindowReading | null;
  sevenDay: WindowReading | null;
}

const DAY_S = 24 * 60 * 60;

/**
 * One window from the status line payload, or null when absent or implausible.
 * The endpoint is reachable over the tailnet like /api/notify, so nothing is
 * trusted: a percentage outside 0–100, or a reset time that is neither recent
 * nor within the next week, is dropped rather than shown.
 */
function parseWindow(raw: unknown, nowS: number): Omit<WindowReading, 'observedAt'> | null {
  if (!raw || typeof raw !== 'object') return null;
  const { used_percentage: pct, resets_at: resets } = raw as { used_percentage?: unknown; resets_at?: unknown };
  if (typeof pct !== 'number' || !Number.isFinite(pct) || pct < 0 || pct > 100) return null;
  if (typeof resets !== 'number' || !Number.isFinite(resets)) return null;
  if (resets < nowS - DAY_S || resets > nowS + 8 * DAY_S) return null;
  return { usedPercentage: pct, resetsAt: Math.round(resets) };
}

/** Both windows from a status line payload; null when it carries neither. */
export function parseReading(body: unknown, now = Date.now()): { fiveHour: ReturnType<typeof parseWindow>; sevenDay: ReturnType<typeof parseWindow> } | null {
  const limits = body && typeof body === 'object' ? (body as { rate_limits?: unknown }).rate_limits : undefined;
  if (!limits || typeof limits !== 'object') return null;
  const nowS = now / 1000;
  const { five_hour: five, seven_day: seven } = limits as { five_hour?: unknown; seven_day?: unknown };
  const fiveHour = parseWindow(five, nowS);
  const sevenDay = parseWindow(seven, nowS);
  return fiveHour || sevenDay ? { fiveHour, sevenDay } : null;
}

/**
 * Fold one window reading into what is held.
 *
 * Every open Claude Code session reports, and an idle one can re-render its
 * status line with limits it cached an hour ago. Arrival order therefore says
 * nothing; the window itself does. A later reset time is a newer window and
 * wins outright. Within the same window usage only rises, so the higher
 * percentage wins — a stale session can re-confirm a value, never lower it.
 */
function merge(
  held: WindowReading | null,
  next: Omit<WindowReading, 'observedAt'> | null,
  observedAt: string
): WindowReading | null {
  if (!next) return held;
  if (!held || next.resetsAt > held.resetsAt) return { ...next, observedAt };
  if (next.resetsAt < held.resetsAt) return held;
  if (next.usedPercentage > held.usedPercentage) return { ...next, observedAt };
  if (next.usedPercentage === held.usedPercentage) return { ...held, observedAt };
  return held;
}

let snapshot: PlanUsageSnapshot | null = null;
/**
 * When the status line relay last reached the server, limits or not. It is
 * what tells "never set up" apart from "set up, but no limits yet" — a session
 * before its first response, a plan without limits — so the chip does not ask
 * for a snippet that is already installed.
 */
let relaySeenAt: string | null = null;

/**
 * What the file on disk last recorded, so a post that changes nothing worth
 * keeping writes nothing. Every session's status line posts on every render;
 * a synchronous write and rename per post churns the disk on the event loop,
 * and on Windows the rename fails outright whenever an indexer or antivirus
 * has the file open.
 *
 * Worth keeping: a percentage or reset time that changed. Not worth a write:
 * a fresher `observedAt` alone (a restored "as of" a little old is harmless),
 * or relay contact already recorded within the hour.
 */
let savedFigures: string | null = null;
let relaySavedAt = 0;
const RELAY_SAVE_EVERY_MS = 60 * 60 * 1000;

function figuresOf(s: PlanUsageSnapshot | null): string {
  const w = (r: WindowReading | null | undefined) => (r ? [r.usedPercentage, r.resetsAt] : null);
  return JSON.stringify([w(s?.fiveHour), w(s?.sevenDay)]);
}

function snapshotPath(): string {
  return join(getConfig().persistence.dataDir, 'plan-usage.json');
}

/**
 * Take one relay post. Every post proves the relay is installed; one carrying
 * usable limits also updates the snapshot. Returns whether it carried limits
 * (their absence is normal: plans without limits, and a session before its
 * first response, send none).
 */
export function recordReading(body: unknown, now = Date.now()): boolean {
  relaySeenAt = new Date(now).toISOString();
  const reading = parseReading(body, now);
  if (reading) {
    const observedAt = new Date(now).toISOString();
    snapshot = {
      fiveHour: merge(snapshot?.fiveHour ?? null, reading.fiveHour, observedAt),
      sevenDay: merge(snapshot?.sevenDay ?? null, reading.sevenDay, observedAt),
    };
  }
  // Measured against what was last WRITTEN, not last seen: contact every few
  // minutes must still be persisted once the saved time is an hour old.
  if (figuresOf(snapshot) !== savedFigures || now - relaySavedAt > RELAY_SAVE_EVERY_MS) save(now);
  return reading !== null;
}

export function getSnapshot(): PlanUsageSnapshot | null {
  return snapshot;
}

export function getRelaySeenAt(): string | null {
  return relaySeenAt;
}

/** Write via a temp file and rename, so a crash mid-write never leaves half a JSON file. */
function save(now: number): void {
  const path = snapshotPath();
  try {
    writeFileSync(`${path}.tmp`, JSON.stringify({ ...snapshot, relaySeenAt }));
    renameSync(`${path}.tmp`, path);
    savedFigures = figuresOf(snapshot);
    relaySavedAt = now;
  } catch (error) {
    logger.warn({ error, path }, 'plan-usage: could not save snapshot');
  }
}

/**
 * Restore the last snapshot at boot, so a restart does not blank the chip.
 * A missing or unreadable file is an empty start, never a failure; each window
 * is re-validated rather than trusted from disk.
 */
export function loadSnapshot(): void {
  const path = snapshotPath();
  snapshot = null;
  relaySeenAt = null;
  savedFigures = null;
  relaySavedAt = 0;
  if (!existsSync(path)) return;
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
    const restore = (w: unknown): WindowReading | null => {
      if (!w || typeof w !== 'object') return null;
      const { usedPercentage, resetsAt, observedAt } = w as Record<string, unknown>;
      if (typeof observedAt !== 'string') return null;
      const parsed = parseWindow({ used_percentage: usedPercentage, resets_at: resetsAt }, Date.now() / 1000);
      return parsed ? { ...parsed, observedAt } : null;
    };
    const fiveHour = restore(raw.fiveHour);
    const sevenDay = restore(raw.sevenDay);
    snapshot = fiveHour || sevenDay ? { fiveHour, sevenDay } : null;
    relaySeenAt = typeof raw.relaySeenAt === 'string' && !Number.isNaN(Date.parse(raw.relaySeenAt)) ? raw.relaySeenAt : null;
    // What is on disk now, so the first post after a restart does not rewrite it unchanged.
    savedFigures = figuresOf(snapshot);
    relaySavedAt = relaySeenAt ? Date.parse(relaySeenAt) : 0;
  } catch (error) {
    logger.warn({ error, path }, 'plan-usage: ignoring unreadable snapshot');
  }
}
