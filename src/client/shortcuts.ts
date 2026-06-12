// Single source of truth for keyboard shortcuts shown in the Shortcuts modal.
//
// To add a new shortcut: append an entry to the relevant group below (or add a
// new group). The Shortcuts modal renders directly from this registry, so the
// display stays in sync automatically — no HTML changes required.

export interface Shortcut {
  /** Key tokens rendered as individual <kbd> elements, joined by "+". e.g. ['Ctrl', 'Q'] */
  keys: string[];
  /** Human-readable description of what the shortcut does. */
  label: string;
  /** When true, this shortcut is also shown in the welcome screen's curated hint list. */
  welcome?: boolean;
}

export interface ShortcutGroup {
  title: string;
  shortcuts: Shortcut[];
}

export const SHORTCUT_GROUPS: ShortcutGroup[] = [
  {
    title: 'Sessions',
    shortcuts: [
      { keys: ['Alt', 'N'], label: 'New session' },
      { keys: ['Ctrl', 'Q'], label: 'Previous session' },
      { keys: ['Ctrl', 'E'], label: 'Next session' },
    ],
  },
  {
    title: 'Terminal',
    shortcuts: [
      { keys: ['Ctrl', 'Shift', 'V'], label: 'Paste', welcome: true },
      { keys: ['Ctrl', 'C'], label: 'Interrupt (send SIGINT)', welcome: true },
    ],
  },
  {
    title: 'General',
    shortcuts: [
      { keys: ['?'], label: 'Show keyboard shortcuts', welcome: true },
      { keys: ['Esc'], label: 'Close modal / dialog', welcome: true },
    ],
  },
];
