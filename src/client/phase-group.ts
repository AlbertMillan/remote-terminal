/**
 * Collapsible `.phase-group` sections, shared by the session-log plan groups and
 * the PROJECT.md track groups.
 *
 * Folding is presentational: a class toggle, never a re-render, and this module
 * is the one place that keeps `aria-expanded` in step with the class. It
 * persists nothing — callers that need a fold to survive a re-render hold that
 * state themselves.
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
