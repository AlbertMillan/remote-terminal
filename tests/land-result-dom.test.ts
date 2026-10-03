// @vitest-environment happy-dom
import { describe, it, expect, beforeEach } from 'vitest';
import { isLandNotification, showLandResult } from '../src/client/land-result.js';
import type { LandNotificationPayload } from '../src/client/session-types.js';

/**
 * A session-requested Land's outcome. The session that asked is closed by the
 * time it arrives, so it can't be a session badge: it is a toast that stays
 * until dismissed, and its text is shown as text, never as markup.
 */

const OK: LandNotificationPayload = {
  kind: 'land',
  projectCwd: 'C:\\p\\demo',
  track: 'Split view',
  ok: true,
  detail: 'Landed into main — build passed',
  timestamp: '2026-10-03T10:00:00.000Z',
};

describe('land result toast', () => {
  beforeEach(() => {
    document.body.innerHTML = '<div id="land-result-toast" class="land-result-toast hidden"></div>';
  });
  const toast = () => document.getElementById('land-result-toast') as HTMLElement;

  it('tells a land notification from a session one', () => {
    expect(isLandNotification(OK)).toBe(true);
    expect(isLandNotification({ sessionId: 's1', type: 'completed', timestamp: OK.timestamp })).toBe(false);
  });

  it('shows a landed track with Land’s detail, until dismissed', () => {
    showLandResult(OK);
    expect(toast().classList.contains('hidden')).toBe(false);
    expect(toast().classList.contains('land-result-failed')).toBe(false);
    expect(toast().querySelector('.land-result-title')?.textContent).toBe('Landed "Split view"');
    expect(toast().querySelector('.land-result-detail')?.textContent).toBe('Landed into main — build passed');

    (toast().querySelector('.land-result-close') as HTMLButtonElement).click();
    expect(toast().classList.contains('hidden')).toBe(true);
  });

  it('marks a failure, and a later result replaces it', () => {
    showLandResult({ ...OK, ok: false, detail: 'Landing "Split view" failed: <b>conflict</b>' });
    expect(toast().classList.contains('land-result-failed')).toBe(true);
    expect(toast().querySelector('.land-result-title')?.textContent).toBe('Land of "Split view" failed');
    expect(toast().querySelector('b')).toBeNull(); // text, not markup

    showLandResult(OK);
    expect(toast().classList.contains('land-result-failed')).toBe(false);
    expect(toast().querySelectorAll('.land-result-title')).toHaveLength(1);
  });
});
