import { describe, it, expect, beforeEach, vi } from 'vitest';

/**
 * reviveRefusal() is the one rule behind both reviveSession() and the sidebar's play button
 * (`SessionInfo.revivable`). These pin each row kind to its verdict.
 */

const findTranscript = vi.fn(
  (_cwd: string, _id: string, _account?: string | null): { path: string; account: string } | null => null
);
vi.mock('../src/server/accounts.js', () => ({
  findTranscript: (cwd: string, id: string, account?: string | null) => findTranscript(cwd, id, account),
}));

import { reviveRefusal } from '../src/server/sessions/revivable.js';

const CLAUDE_ID = '22222222-2222-4222-8222-222222222222';
const row = (overrides: Record<string, unknown> = {}) => ({
  status: 'idle',
  isFork: false,
  claudeSessionId: null as string | null,
  cwd: '/home/albert/proj',
  account: 'personal',
  ...overrides,
});

beforeEach(() => {
  findTranscript.mockReset();
  findTranscript.mockReturnValue(null);
});

describe('reviveRefusal', () => {
  it('refuses a running session', () => {
    expect(reviveRefusal(row(), true)).toMatch(/already running/i);
  });

  it('refuses a fork, stale or terminated', () => {
    expect(reviveRefusal(row({ isFork: true }), false)).toMatch(/fork/i);
    expect(reviveRefusal(row({ isFork: true, status: 'terminated', claudeSessionId: CLAUDE_ID }), false)).toMatch(/fork/i);
  });

  it('allows a stale row, with or without a conversation, without touching the disk', () => {
    expect(reviveRefusal(row(), false)).toBeNull();
    expect(reviveRefusal(row({ claudeSessionId: CLAUDE_ID }), false)).toBeNull();
    expect(findTranscript).not.toHaveBeenCalled();
  });

  it('refuses a terminated plain shell', () => {
    expect(reviveRefusal(row({ status: 'terminated' }), false)).toMatch(/no conversation/i);
  });

  it('allows a terminated conversation only while its transcript exists', () => {
    const terminated = row({ status: 'terminated', claudeSessionId: CLAUDE_ID });
    expect(reviveRefusal(terminated, false)).toMatch(/transcript no longer exists/i);

    findTranscript.mockReturnValue({ path: `/t/${CLAUDE_ID}.jsonl`, account: 'personal' });
    expect(reviveRefusal(terminated, false)).toBeNull();
    expect(findTranscript).toHaveBeenLastCalledWith('/home/albert/proj', CLAUDE_ID, 'personal');
  });

  it('checks a running session before any transcript lookup', () => {
    reviveRefusal(row({ status: 'terminated', claudeSessionId: CLAUDE_ID }), true);
    expect(findTranscript).not.toHaveBeenCalled();
  });
});
