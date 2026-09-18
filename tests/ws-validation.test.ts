import { describe, it, expect } from 'vitest';
import {
  isValidDimension,
  validateTerminalDimensions,
  MIN_TERMINAL_DIMENSION,
  MAX_TERMINAL_DIMENSION,
} from '../src/server/websocket/validation.js';

/**
 * Terminal dimensions reach a PTY from four different messages. session.create and
 * terminal.resize each carried their own copy of the bounds check; session.open and
 * session.revive carried none at all and forwarded whatever the client sent straight into
 * createPty. These tests pin the single implementation they now share.
 */

describe('isValidDimension', () => {
  it('accepts the ends of the allowed range', () => {
    expect(isValidDimension(MIN_TERMINAL_DIMENSION)).toBe(true);
    expect(isValidDimension(MAX_TERMINAL_DIMENSION)).toBe(true);
    expect(isValidDimension(120)).toBe(true);
  });

  it('rejects values outside it', () => {
    expect(isValidDimension(MIN_TERMINAL_DIMENSION - 1)).toBe(false);
    expect(isValidDimension(MAX_TERMINAL_DIMENSION + 1)).toBe(false);
    expect(isValidDimension(-40)).toBe(false);
  });

  it('rejects non-finite values, which Number() alone lets through', () => {
    // isNaN(Infinity) is false, so a bounds check written with isNaN and no upper guard
    // would have accepted Infinity.
    expect(isValidDimension(Infinity)).toBe(false);
    expect(isValidDimension(-Infinity)).toBe(false);
    expect(isValidDimension(NaN)).toBe(false);
    expect(isValidDimension('not a number')).toBe(false);
    expect(isValidDimension(null)).toBe(false);
    expect(isValidDimension({})).toBe(false);
  });

  it('accepts numeric strings, since JSON payloads are not typed', () => {
    expect(isValidDimension('120')).toBe(true);
  });
});

describe('validateTerminalDimensions', () => {
  it('returns nothing when the payload omits dimensions, so stored ones win', () => {
    // session.revive falls back to the row's own cols/rows; an absent field must stay absent
    // rather than becoming 0 or NaN.
    expect(validateTerminalDimensions(undefined)).toEqual({});
    expect(validateTerminalDimensions({})).toEqual({});
  });

  it('passes valid dimensions through as numbers', () => {
    expect(validateTerminalDimensions({ cols: 120, rows: 40 })).toEqual({ cols: 120, rows: 40 });
    expect(validateTerminalDimensions({ cols: '120', rows: '40' })).toEqual({ cols: 120, rows: 40 });
  });

  it('validates each axis independently', () => {
    expect(validateTerminalDimensions({ cols: 120 })).toEqual({ cols: 120 });
    expect(validateTerminalDimensions({ rows: 40 })).toEqual({ rows: 40 });
  });

  it('throws on an oversized value instead of handing it to a PTY', () => {
    expect(() => validateTerminalDimensions({ cols: 999999999 })).toThrow(/Invalid terminal columns/);
    expect(() => validateTerminalDimensions({ rows: 999999999 })).toThrow(/Invalid terminal rows/);
  });

  it('throws on zero, negative and non-numeric values', () => {
    expect(() => validateTerminalDimensions({ cols: 0 })).toThrow(/Invalid terminal columns/);
    expect(() => validateTerminalDimensions({ rows: -1 })).toThrow(/Invalid terminal rows/);
    expect(() => validateTerminalDimensions({ cols: 'wide' })).toThrow(/Invalid terminal columns/);
  });

  it('reports the offending axis, not just "invalid"', () => {
    expect(() => validateTerminalDimensions({ cols: 120, rows: 9000 })).toThrow(/rows/);
  });
});
