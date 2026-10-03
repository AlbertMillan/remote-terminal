import type { LandNotificationPayload, NotificationPayload } from './session-types.js';

/**
 * The outcome of a Land a session asked for (POST /api/agent/land).
 *
 * It arrives as a `notification` told apart by `kind`, after the session that
 * asked has been closed, so there is no session to badge. It shows in a toast
 * fixed over every view, and stays until dismissed: the user may be away when
 * a land finishes, and this is the only place its result is reported.
 */

export function isLandNotification(
  payload: NotificationPayload | LandNotificationPayload
): payload is LandNotificationPayload {
  return (payload as LandNotificationPayload).kind === 'land';
}

/** The toast's heading: what happened, to which track. */
export function landResultTitle(payload: LandNotificationPayload): string {
  return payload.ok ? `Landed "${payload.track}"` : `Land of "${payload.track}" failed`;
}

/** Fill and show the toast. A later result replaces an earlier one. */
export function showLandResult(payload: LandNotificationPayload, doc: Document = document): void {
  const toast = doc.getElementById('land-result-toast');
  if (!toast) return;
  toast.classList.toggle('land-result-failed', !payload.ok);
  toast.replaceChildren();

  const title = doc.createElement('div');
  title.className = 'land-result-title';
  title.textContent = landResultTitle(payload);
  const detail = doc.createElement('div');
  detail.className = 'land-result-detail';
  detail.textContent = payload.detail;
  const close = doc.createElement('button');
  close.className = 'land-result-close';
  close.type = 'button';
  close.title = 'Dismiss';
  close.setAttribute('aria-label', 'Dismiss');
  close.textContent = '×';
  close.addEventListener('click', () => toast.classList.add('hidden'));

  toast.append(close, title, detail);
  toast.classList.remove('hidden');
}
