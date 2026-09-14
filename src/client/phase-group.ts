/**
 * Collapsible `.phase-group` sections.
 *
 * Two surfaces render this widget from the same markup and the same CSS
 * (`.phase-group.collapsed .phase-list { display: none }`): the plan-progress
 * groups in the session-log view and the track groups on the PROJECT.md feature
 * board. Folding is presentational, so it is a class toggle on the group — not
 * a re-render — and this module is the one place that knows how to do it,
 * keeping `aria-expanded` in step with the class.
 *
 * Callers that need the fold to survive a later re-render keep their own state
 * and feed it back in at render time; this module never persists anything.
 */

/** Mark a group folded or unfolded. Returns the state actually applied. */
export function setPhaseGroupCollapsed(head: HTMLElement, collapsed: boolean): boolean {
  const group = head.closest('.phase-group');
  if (!group) return false;
  group.classList.toggle('collapsed', collapsed);
  head.setAttribute('aria-expanded', String(!collapsed));
  return collapsed;
}

/** Flip a group's fold. Returns true if it is now collapsed. */
export function togglePhaseGroup(head: HTMLElement): boolean {
  const group = head.closest('.phase-group');
  if (!group) return false;
  return setPhaseGroupCollapsed(head, !group.classList.contains('collapsed'));
}

/**
 * True when the key should operate a `role="button"` group head. A div with
 * that role gets no synthetic click from the browser, so Enter and Space have
 * to be handled explicitly.
 */
export function isPhaseGroupActivation(key: string): boolean {
  return key === 'Enter' || key === ' ';
}
