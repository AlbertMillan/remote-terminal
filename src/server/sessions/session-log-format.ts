// Single source of truth for the SESSION-LOG.md entry format. The generator
// (prompt builders) and any consumer (the dashboard parser) must agree on the
// marker shape and field labels, so both live here to prevent drift.

export interface LogEntryMeta {
  date: string; // ISO timestamp
  session: string; // session name (or "(backfill)")
  branch: string;
  claudeSessionId: string; // or "backfill"
  blockers: number;
  openItems: number;
}

const MARKER_OPEN = '<!-- claude-remote-log ';
const MARKER_CLOSE = ' -->';

/** The machine-readable marker comment that precedes every entry. */
export function buildMarker(meta: LogEntryMeta): string {
  return `${MARKER_OPEN}${JSON.stringify(meta)}${MARKER_CLOSE}`;
}

export interface ParsedLogEntry {
  meta: LogEntryMeta | null; // null if the marker JSON failed to parse
  body: string; // entry markdown, from its marker to the next (or EOF)
}

// Markers are single-line; capture JSON non-greedily up to the first closer.
const MARKER_RE = /<!-- claude-remote-log (.+?) -->/g;

/**
 * Parse all entries out of a SESSION-LOG.md. Each entry's body runs from its
 * marker to the next marker (or end of file), newest-first as written.
 */
export function parseLogEntries(markdown: string): ParsedLogEntry[] {
  const matches = [...markdown.matchAll(MARKER_RE)];
  return matches.map((m, i) => {
    let meta: LogEntryMeta | null = null;
    try {
      const obj = JSON.parse(m[1]) as unknown;
      if (obj && typeof obj === 'object') meta = obj as LogEntryMeta;
    } catch {
      // malformed marker — surface the body with null meta
    }
    const start = m.index ?? 0;
    const end = i + 1 < matches.length ? matches[i + 1].index ?? markdown.length : markdown.length;
    return { meta, body: markdown.slice(start, end).trim() };
  });
}

export interface EntryHints {
  done: string;
  changed: string;
  planProgress: string;
  openNext: string;
  blockers: string;
}

/**
 * Render the exact entry skeleton shown to the generator. Returning it from one
 * place keeps the heading, field labels, and marker identical across the
 * per-session and backfill prompts (and aligned with parseLogEntries).
 */
export function buildEntrySkeleton(opts: {
  meta: LogEntryMeta;
  headingDate: string; // YYYY-MM-DD
  headingTitle: string;
  hints: EntryHints;
}): string {
  const { meta, headingDate, headingTitle, hints } = opts;
  return [
    buildMarker(meta),
    `## ${headingDate} · ${headingTitle} · ${meta.branch}`,
    `**Done:** ${hints.done}`,
    `**Changed:** ${hints.changed}`,
    `**Plan progress:** ${hints.planProgress}`,
    `**Open / next:** ${hints.openNext}`,
    `**Blockers:** ${hints.blockers}`,
  ].join('\n');
}
