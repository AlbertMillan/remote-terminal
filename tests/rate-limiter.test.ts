import { describe, it, expect, vi, afterEach } from 'vitest';
import { RateLimiter } from '../src/server/utils/rate-limiter.js';

afterEach(() => vi.useRealTimers());

describe('RateLimiter', () => {
  it('keeps the remainder of a refill interval', () => {
    vi.useFakeTimers();
    const limiter = new RateLimiter(2, 10);
    expect(limiter.tryAcquire('c')).toBe(true);
    expect(limiter.tryAcquire('c')).toBe(true);
    expect(limiter.tryAcquire('c')).toBe(false);
    // 19 ms: one token, and 9 ms toward the next.
    vi.advanceTimersByTime(19);
    expect(limiter.tryAcquire('c')).toBe(true);
    expect(limiter.tryAcquire('c')).toBe(false);
    // 1 ms more completes it; resetting to `now` at 19 ms would have needed 10.
    vi.advanceTimersByTime(1);
    expect(limiter.tryAcquire('c')).toBe(true);
  });

  it('never banks past the cap', () => {
    vi.useFakeTimers();
    const limiter = new RateLimiter(2, 10);
    limiter.tryAcquire('c');
    vi.advanceTimersByTime(10_000);
    expect(limiter.tryAcquire('c')).toBe(true);
    expect(limiter.tryAcquire('c')).toBe(true);
    expect(limiter.tryAcquire('c')).toBe(false);
  });
});
