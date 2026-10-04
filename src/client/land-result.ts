import type { LandNotificationPayload, NotificationPayload, PromptMissingNotificationPayload } from './session-types.js';

/**
 * The outcome of a Land a session asked for (POST /api/agent/land), and the
 * warning that a started session never got its prompt.
 *
 * Both arrive as a `notification` told apart by `kind`, with no session to
 * badge: a Land's session is closed by then, and a badge on an idle started
 * session would read as "needs input". They show in a toast fixed over every
 * view, and stay until dismissed: the user may be away, and this is the only
 * place either is reported.
 */

type AnyNotification = NotificationPayload | LandNotificationPayload | PromptMissingNotificationPayload;

export function isLandNotification(payload: AnyNotification): payload is LandNotificationPayload {
  return (payload as LandNotificationPayload).kind === 'land';
}

export function isPromptMissingNotification(payload: AnyNotification): payload is PromptMissingNotificationPayload {
  return (payload as PromptMissingNotificationPayload).kind === 'prompt-missing';
}

/** The toast's heading: what happened, to which track. */
export function landResultTitle(payload: LandNotificationPayload): string {
  return payload.ok ? `Landed "${payload.track}"` : `Land of "${payload.track}" failed`;
}

export function promptMissingTitle(payload: PromptMissingNotificationPayload): string {
  return `Started session "${payload.name}" never got its prompt`;
}

/** Fill and show the toast. A later result replaces an earlier one. */
function showResultToast(title: string, detail: string, failed: boolean, doc: Document): void {
  const toast = doc.getElementById('land-result-toast');
  if (!toast) return;
  toast.classList.toggle('land-result-failed', failed);
  toast.replaceChildren();

  const heading = doc.createElement('div');
  heading.className = 'land-result-title';
  heading.textContent = title;
  const body = doc.createElement('div');
  body.className = 'land-result-detail';
  body.textContent = detail;
  const close = doc.createElement('button');
  close.className = 'land-result-close';
  close.type = 'button';
  close.title = 'Dismiss';
  close.setAttribute('aria-label', 'Dismiss');
  close.textContent = '×';
  close.addEventListener('click', () => toast.classList.add('hidden'));

  toast.append(close, heading, body);
  toast.classList.remove('hidden');
}

export function showLandResult(payload: LandNotificationPayload, doc: Document = document): void {
  showResultToast(landResultTitle(payload), payload.detail, !payload.ok, doc);
}

export function showPromptMissing(payload: PromptMissingNotificationPayload, doc: Document = document): void {
  showResultToast(
    promptMissingTitle(payload),
    `${payload.detail}. Open it and give it the task, or tell the session that started it.`,
    true,
    doc
  );
}
