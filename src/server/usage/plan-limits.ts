import { existsSync, readFileSync, renameSync, writeFileSync } from 'fs';
import { join } from 'path';
import { getConfig } from '../config.js';
import { createLogger } from '../utils/logger.js';
import { accountForConfigDir, defaultAccount } from '../accounts.js';

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
  /** The login (`oauthAccount.accountUuid`) the reading was verified for. */
  loginUuid: string;
}

export interface PlanUsageSnapshot {
  fiveHour: WindowReading | null;
  sevenDay: WindowReading | null;
}

export type WindowName = 'fiveHour' | 'sevenDay';

/**
 * Why a reading was held back instead of merged:
 * - `login-mismatch`: the account's folder holds another login than expected;
 * - `session-flagged`: its session's `claude` may still run the login it started
 *   with, from before a `/login` swap (account-watch flagged it);
 * - `no-login`: nobody logged in there, or no expected identity to check against;
 * - `unknown-folder`: sent from a folder no account uses;
 * - `unverified-legacy`: restored from a file written before readings were verified.
 */
export type HeldReason = 'login-mismatch' | 'session-flagged' | 'no-login' | 'unknown-folder' | 'unverified-legacy';

/**
 * Whether a reading came from the login its account expects. Decided by the
 * route (plan-routes.ts) from the session that sent it, else the folder; only a
 * verified reading reaches the snapshot.
 */
export type Verdict = { verified: true; loginUuid: string } | { verified: false; reason: HeldReason };

/** One window of a reading that was held back. Shown on the usage page, never on the chip. */
export interface HeldReading {
  id: string;
  /** The account it was sent for, or null for a folder no account uses. */
  account: string | null;
  window: WindowName;
  usedPercentage: number;
  resetsAt: number;
  /** When it (last) arrived (ISO). */
  arrivedAt: string;
  reason: HeldReason;
}

type ParsedWindow = Omit<WindowReading, 'observedAt' | 'loginUuid'>;

const DAY_S = 24 * 60 * 60;

/**
 * One window from the status line payload, or null when absent or implausible.
 * The endpoint is reachable over the tailnet like /api/notify, so nothing is
 * trusted: a percentage outside 0–100, or a reset time that is neither recent
 * nor within the next week, is dropped rather than shown.
 */
function parseWindow(raw: unknown, nowS: number): ParsedWindow | null {
  if (!raw || typeof raw !== 'object') return null;
  const { used_percentage: pct, resets_at: resets } = raw as { used_percentage?: unknown; resets_at?: unknown };
  if (typeof pct !== 'number' || !Number.isFinite(pct) || pct < 0 || pct > 100) return null;
  if (typeof resets !== 'number' || !Number.isFinite(resets)) return null;
  if (resets < nowS - DAY_S || resets > nowS + 8 * DAY_S) return null;
  return { usedPercentage: pct, resetsAt: Math.round(resets) };
}

/** Both windows from a status line payload; null when it carries neither. */
export function parseReading(body: unknown, now = Date.now()): { fiveHour: ParsedWindow | null; sevenDay: ParsedWindow | null } | null {
  const limits = body && typeof body === 'object' ? (body as { rate_limits?: unknown }).rate_limits : undefined;
  if (!limits || typeof limits !== 'object') return null;
  const nowS = now / 1000;
  const { five_hour: five, seven_day: seven } = limits as { five_hour?: unknown; seven_day?: unknown };
  const fiveHour = parseWindow(five, nowS);
  const sevenDay = parseWindow(seven, nowS);
  return fiveHour || sevenDay ? { fiveHour, sevenDay } : null;
}

/**
 * Fold one verified window reading into what is held.
 *
 * Every open Claude Code session reports, and an idle one can re-render its
 * status line with limits it cached an hour ago. Arrival order therefore says
 * nothing; the window itself does. A later reset time is a newer window and
 * wins outright. Within the same window usage only rises, so the higher
 * percentage wins — a stale session can re-confirm a value, never lower it.
 *
 * Those rules hold for one login's stream only. A reading verified for another
 * login than the held window's replaces it outright, whatever its reset: the
 * login changed, so the held window is not this login's, and a later foreign
 * reset would otherwise pin it until that reset passed.
 */
function merge(
  held: WindowReading | null,
  next: ParsedWindow | null,
  observedAt: string,
  loginUuid: string
): WindowReading | null {
  if (!next) return held;
  if (!held || held.loginUuid !== loginUuid || next.resetsAt > held.resetsAt) return { ...next, observedAt, loginUuid };
  if (next.resetsAt < held.resetsAt) return held;
  if (next.usedPercentage > held.usedPercentage) return { ...next, observedAt, loginUuid };
  if (next.usedPercentage === held.usedPercentage) return { ...held, observedAt };
  return held;
}

/**
 * One account's readings (docs/accounts.md): each login has its own plan and
 * limits, and a status line reports only its own session's.
 *
 * `relaySeenAt` is when its status line relay last reached the server, limits
 * or not. It is what tells "never set up" apart from "set up, but no limits yet"
 * — a session before its first response, a plan without limits — so the chip
 * does not ask for a snippet that is already installed.
 *
 * `savedFigures` / `relaySavedAt` are what the file on disk last recorded, so a
 * post that changes nothing worth keeping writes nothing. Every session's status
 * line posts on every render; a synchronous write and rename per post churns the
 * disk on the event loop, and on Windows the rename fails outright whenever an
 * indexer or antivirus has the file open. Worth keeping: a percentage, reset
 * time or login that changed. Not worth a write: a fresher `observedAt` alone (a
 * restored "as of" a little old is harmless), or relay contact already recorded
 * within the hour.
 */
interface AccountState {
  snapshot: PlanUsageSnapshot | null;
  relaySeenAt: string | null;
  savedFigures: string | null;
  relaySavedAt: number;
}

const states = new Map<string, AccountState>();
const RELAY_SAVE_EVERY_MS = 60 * 60 * 1000;

function stateOf(account: string): AccountState {
  let state = states.get(account);
  if (!state) {
    state = { snapshot: null, relaySeenAt: null, savedFigures: null, relaySavedAt: 0 };
    states.set(account, state);
  }
  return state;
}

/**
 * Readings held back, by account ('' for a folder no account uses). In memory
 * only: they are there to be looked at on the usage page, never shown as
 * limits. Bounded — a mismatched session posts on every render — by keeping one
 * entry per window, reason and reset (the latest arrival), at most
 * HELD_PER_ACCOUNT, newest first.
 */
const held = new Map<string, HeldReading[]>();
const HELD_PER_ACCOUNT = 10;
let heldSeq = 0;

function holdBack(account: string | null, window: WindowName, w: ParsedWindow, reason: HeldReason, arrivedAt: string): void {
  const key = account ?? '';
  const list = (held.get(key) ?? []).filter((h) => !(h.window === window && h.reason === reason && h.resetsAt === w.resetsAt));
  list.unshift({ id: `h${++heldSeq}`, account, window, usedPercentage: w.usedPercentage, resetsAt: w.resetsAt, arrivedAt, reason });
  held.set(key, list.slice(0, HELD_PER_ACCOUNT));
}

/** Readings held back: one account's (null: a folder no account uses), or every one. Newest first per account. */
export function getHeld(account?: string | null): HeldReading[] {
  if (account !== undefined) return [...(held.get(account ?? '') ?? [])];
  return [...held.values()].flat();
}

/** Drop held-back readings: the one with `id`, or all of `account`'s (null: no account). Returns how many went. */
export function discardHeld(target: { id: string } | { account: string | null }): number {
  if ('id' in target) {
    let dropped = 0;
    for (const [key, list] of held) {
      const kept = list.filter((h) => h.id !== target.id);
      dropped += list.length - kept.length;
      held.set(key, kept);
    }
    return dropped;
  }
  const key = target.account ?? '';
  const dropped = held.get(key)?.length ?? 0;
  held.delete(key);
  return dropped;
}

/**
 * Whose a snapshot file from before accounts was: the login on Claude Code's
 * default folder, the only one there was, else the configured default. Only
 * loadSnapshot uses it: every reading and lookup names its account, so nothing
 * here can pick a different default than the route does.
 */
function legacyFileAccount(): string {
  return accountForConfigDir(null) ?? defaultAccount();
}

function figuresOf(s: PlanUsageSnapshot | null): string {
  const w = (r: WindowReading | null | undefined) => (r ? [r.usedPercentage, r.resetsAt, r.loginUuid] : null);
  return JSON.stringify([w(s?.fiveHour), w(s?.sevenDay)]);
}

function snapshotPath(): string {
  return join(getConfig().persistence.dataDir, 'plan-usage.json');
}

/**
 * Take one relay post for `account` (null: a folder no account uses). Every
 * post to an account proves its relay is installed. Limits update the account's
 * snapshot only when `verdict` verified them; otherwise they are held back, and
 * the snapshot is untouched. Returns whether the post carried limits (their
 * absence is normal: plans without limits, and a session before its first
 * response, send none).
 */
export function recordReading(body: unknown, account: string | null, verdict: Verdict, now = Date.now()): boolean {
  const reading = parseReading(body, now);
  const at = new Date(now).toISOString();
  if (account === null || !verdict.verified) {
    const reason: HeldReason = account === null ? 'unknown-folder' : (verdict as { reason: HeldReason }).reason;
    if (reading?.fiveHour) holdBack(account, 'fiveHour', reading.fiveHour, reason, at);
    if (reading?.sevenDay) holdBack(account, 'sevenDay', reading.sevenDay, reason, at);
    if (account === null) return reading !== null;
  }
  const state = stateOf(account);
  state.relaySeenAt = at;
  if (reading && verdict.verified) {
    state.snapshot = {
      fiveHour: merge(state.snapshot?.fiveHour ?? null, reading.fiveHour, at, verdict.loginUuid),
      sevenDay: merge(state.snapshot?.sevenDay ?? null, reading.sevenDay, at, verdict.loginUuid),
    };
  }
  // Measured against what was last WRITTEN, not last seen: contact every few
  // minutes must still be persisted once the saved time is an hour old.
  if (figuresOf(state.snapshot) !== state.savedFigures || now - state.relaySavedAt > RELAY_SAVE_EVERY_MS) save(now);
  return reading !== null;
}

export function getSnapshot(account: string): PlanUsageSnapshot | null {
  return states.get(account)?.snapshot ?? null;
}

export function getRelaySeenAt(account: string): string | null {
  return states.get(account)?.relaySeenAt ?? null;
}

/** Write every account via a temp file and rename, so a crash mid-write never leaves half a JSON file. */
function save(now: number): void {
  const path = snapshotPath();
  const accounts: Record<string, unknown> = {};
  for (const [name, state] of states) accounts[name] = { ...state.snapshot, relaySeenAt: state.relaySeenAt };
  try {
    writeFileSync(`${path}.tmp`, JSON.stringify({ accounts }));
    renameSync(`${path}.tmp`, path);
    for (const state of states.values()) {
      state.savedFigures = figuresOf(state.snapshot);
      state.relaySavedAt = now;
    }
  } catch (error) {
    logger.warn({ error, path }, 'plan-usage: could not save snapshot');
  }
}

/**
 * One account's entry read back from disk. A window with no `loginUuid` was
 * written before readings were verified — exactly the data that was misfiled —
 * so it comes back held back (`unverified-legacy`), never shown: the chip waits
 * for the next verified reading, seconds away for any open session.
 */
function restoreState(account: string, raw: Record<string, unknown>): AccountState {
  const restore = (window: WindowName): WindowReading | null => {
    const w = raw[window];
    if (!w || typeof w !== 'object') return null;
    const { usedPercentage, resetsAt, observedAt, loginUuid } = w as Record<string, unknown>;
    if (typeof observedAt !== 'string') return null;
    const parsed = parseWindow({ used_percentage: usedPercentage, resets_at: resetsAt }, Date.now() / 1000);
    if (!parsed) return null;
    if (typeof loginUuid === 'string' && loginUuid) return { ...parsed, observedAt, loginUuid };
    holdBack(account, window, parsed, 'unverified-legacy', observedAt);
    return null;
  };
  const fiveHour = restore('fiveHour');
  const sevenDay = restore('sevenDay');
  const snapshot = fiveHour || sevenDay ? { fiveHour, sevenDay } : null;
  const relaySeenAt =
    typeof raw.relaySeenAt === 'string' && !Number.isNaN(Date.parse(raw.relaySeenAt)) ? raw.relaySeenAt : null;
  // What is on disk now, so the first post after a restart does not rewrite it
  // unchanged. A held-back legacy window is not "what is held": the first save
  // drops it from the file.
  return { snapshot, relaySeenAt, savedFigures: figuresOf(snapshot), relaySavedAt: relaySeenAt ? Date.parse(relaySeenAt) : 0 };
}

/**
 * Restore the last snapshots at boot, so a restart does not blank the chip.
 * A missing or unreadable file is an empty start, never a failure; each window
 * is re-validated rather than trusted from disk. A file from before accounts
 * (one flat snapshot) is filed under the default folder's account; its windows,
 * like any without a `loginUuid`, come back held back (restoreState).
 */
export function loadSnapshot(): void {
  const path = snapshotPath();
  states.clear();
  held.clear();
  if (!existsSync(path)) return;
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
    if (raw.accounts && typeof raw.accounts === 'object') {
      for (const [name, entry] of Object.entries(raw.accounts as Record<string, unknown>)) {
        if (entry && typeof entry === 'object') states.set(name, restoreState(name, entry as Record<string, unknown>));
      }
    } else {
      const account = legacyFileAccount();
      states.set(account, restoreState(account, raw));
    }
  } catch (error) {
    logger.warn({ error, path }, 'plan-usage: ignoring unreadable snapshot');
  }
}
