import { describe, it, expect } from 'vitest';
import { StopRequests, currentAfterRevive, isLive } from '../src/client/session-stop.js';
import type { SessionInfo } from '../src/client/session-types.js';

/** The client's half of Stop (src/client/session-stop.ts, project/stop-sessions.md). */

describe('StopRequests', () => {
  it('holds a second click on the same session until the first is answered', () => {
    const stops = new StopRequests();
    stops.sent('1', 's-1');
    expect(stops.inFlight('s-1')).toBe(true);
    expect(stops.inFlight('s-2')).toBe(false);

    stops.answered('1');
    expect(stops.inFlight('s-1')).toBe(false);
  });

  it('retries only a viewers refusal, and forgets the request either way', () => {
    const stops = new StopRequests();
    stops.sent('1', 's-1');
    stops.sent('2', 's-2');

    expect(stops.refused('1', 'viewers')).toBe('s-1');
    expect(stops.refused('2', undefined)).toBeUndefined();
    expect(stops.inFlight('s-1')).toBe(false);
    expect(stops.inFlight('s-2')).toBe(false);
  });

  it('ignores errors that answer no stop', () => {
    const stops = new StopRequests();
    expect(stops.refused('9', 'viewers')).toBeUndefined();
    expect(stops.refused(undefined, 'viewers')).toBeUndefined();
  });

  it('forgets everything when the socket closes, so Stop works again after a reconnect', () => {
    const stops = new StopRequests();
    stops.sent('1', 's-1');
    stops.clear();
    expect(stops.inFlight('s-1')).toBe(false);
  });
});

describe('isLive', () => {
  const row = (attachable: boolean) => ({ attachable }) as SessionInfo;

  it('is false only for a row known to have no shell', () => {
    expect(isLive(row(true))).toBe(true);
    expect(isLive(row(false))).toBe(false);
    // Not listed yet (the attach can answer before the list): never block its input.
    expect(isLive(undefined)).toBe(true);
  });
});

describe('currentAfterRevive', () => {
  it('forgets the stopped session on screen, so its revive attaches again', () => {
    expect(currentAfterRevive('s-1', 's-1')).toBeNull();
  });

  it('keeps another current session', () => {
    expect(currentAfterRevive('s-2', 's-1')).toBe('s-2');
    expect(currentAfterRevive(null, 's-1')).toBeNull();
  });
});
