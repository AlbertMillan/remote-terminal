/**
 * Shared validation for WebSocket payloads.
 *
 * Terminal dimensions arrive on four different messages (session.create, session.open,
 * session.revive, terminal.resize) and every one of them ends up at a PTY. Keeping the bounds
 * in one place is what stops a new handler from quietly forwarding whatever the client sent:
 * session.open and session.revive both did exactly that before this module existed.
 */
import { URLSearchParams } from 'url';

export const MIN_TERMINAL_DIMENSION = 1;
export const MAX_TERMINAL_DIMENSION = 500;

/** True when `value` is a number a PTY can be sized to. */
export function isValidDimension(value: unknown): boolean {
  const n = Number(value);
  return Number.isFinite(n) && n >= MIN_TERMINAL_DIMENSION && n <= MAX_TERMINAL_DIMENSION;
}

/**
 * Validate the optional cols/rows on a payload, throwing on anything out of range.
 *
 * Used by the session-spawning handlers, which surface the error to the client. terminal.resize
 * uses isValidDimension() directly instead: a bad resize is ignored rather than reported, since
 * it arrives unprompted from a resize observer rather than from a user action.
 */
export function validateTerminalDimensions(payload: { cols?: unknown; rows?: unknown } | undefined): {
  cols?: number;
  rows?: number;
} {
  const validated: { cols?: number; rows?: number } = {};

  if (payload?.cols !== undefined) {
    if (!isValidDimension(payload.cols)) {
      throw new Error('Invalid terminal columns');
    }
    validated.cols = Number(payload.cols);
  }

  if (payload?.rows !== undefined) {
    if (!isValidDimension(payload.rows)) {
      throw new Error('Invalid terminal rows');
    }
    validated.rows = Number(payload.rows);
  }

  return validated;
}

/**
 * The Android app's install id from `/ws?device=<id>` (docs/android-app.md); anything that
 * is not a plain id is ignored, so the socket is treated as a browser's.
 */
export function deviceIdFromUrl(url: string | undefined): string | undefined {
  const query = url?.split('?')[1];
  if (!query) return undefined;
  const id = new URLSearchParams(query).get('device');
  return id && /^[A-Za-z0-9-]{8,64}$/.test(id) ? id : undefined;
}
