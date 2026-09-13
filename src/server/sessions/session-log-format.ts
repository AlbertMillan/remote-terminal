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

// --- Phases manifest -------------------------------------------------------
// A normalized, model-produced view of the project's plan stages. Source docs
// use wildly different conventions (Phase N / SU-N / M-N / "✅ shipped" / prose
// status), so the generator interprets them into this schema for a consistent
// cross-project report. Grouped by track/doc since one project can have several
// parallel stage axes that must NOT be conflated.
export type PhaseStatus = 'done' | 'in_progress' | 'pending';

export interface PhaseItem {
  id: string; // e.g. "Phase 1", "M3", "SU-2"
  title: string;
  status: PhaseStatus;
  sessionIds: string[]; // claude session ids that contributed (best-effort, multi)
}

export interface PhaseGroup {
  group: string; // track label, e.g. "Feature roadmap"
  source: string; // source doc, e.g. "docs/project-onboarding.md"
  items: PhaseItem[];
}

// Multi-line JSON inside an HTML comment; distinct prefix from the log marker.
const PHASES_BLOCK_RE = /<!-- claude-remote-phases\s+([\s\S]*?)-->/;

function normalizeStatus(s: unknown): PhaseStatus {
  return s === 'done' || s === 'in_progress' || s === 'pending' ? s : 'pending';
}

/** Parse the `<!-- claude-remote-phases [...] -->` manifest. Defensive: returns
 *  [] on a missing or malformed block so the dashboard degrades gracefully. */
export function parsePhasesBlock(markdown: string): PhaseGroup[] {
  const m = markdown.match(PHASES_BLOCK_RE);
  if (!m) return [];
  let data: unknown;
  try {
    data = JSON.parse(m[1].trim());
  } catch {
    return [];
  }
  if (!Array.isArray(data)) return [];
  const groups: PhaseGroup[] = [];
  for (const g of data) {
    if (!g || typeof g !== 'object') continue;
    const gg = g as Record<string, unknown>;
    const rawItems = Array.isArray(gg.items) ? gg.items : [];
    const items: PhaseItem[] = rawItems
      .filter((it): it is Record<string, unknown> => !!it && typeof it === 'object')
      .map((it) => ({
        id: typeof it.id === 'string' ? it.id : '',
        title: typeof it.title === 'string' ? it.title : '',
        status: normalizeStatus(it.status),
        sessionIds: Array.isArray(it.sessionIds) ? it.sessionIds.filter((x): x is string => typeof x === 'string') : [],
      }))
      .filter((it) => it.id || it.title);
    groups.push({
      group: typeof gg.group === 'string' ? gg.group : 'Phases',
      source: typeof gg.source === 'string' ? gg.source : '',
      items,
    });
  }
  return groups;
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

/**
 * Remove the entry at `index` (as returned by parseLogEntries) from a
 * SESSION-LOG.md, returning the rewritten markdown — or null if the index is
 * out of range.
 *
 * The slice runs from the entry's own marker to the next marker (or EOF), so
 * everything preceding the first marker — the "# Session Log" header and the
 * `claude-remote-phases` manifest block — is always preserved. Blank lines are
 * normalized so removing an entry can't leave a double gap or strip the file's
 * trailing newline.
 */
export function removeLogEntry(markdown: string, index: number): string | null {
  const matches = [...markdown.matchAll(MARKER_RE)];
  if (!Number.isInteger(index) || index < 0 || index >= matches.length) return null;
  const start = matches[index].index ?? 0;
  const end = index + 1 < matches.length ? matches[index + 1].index ?? markdown.length : markdown.length;
  const before = markdown.slice(0, start).replace(/\s+$/, '');
  const after = markdown.slice(end).replace(/^\s+/, '');
  const joined = before && after ? `${before}\n\n${after}` : before || after;
  return joined ? `${joined.replace(/\s+$/, '')}\n` : '';
}

/**
 * Find the entry already written for a conversation, if any.
 *
 * The format has always documented `claudeSessionId` as "the idempotency key
 * (prevents duplicates)", but nothing enforced it: resuming a conversation
 * produced a second entry, then a third. One entry per conversation, amended,
 * is what that promise actually means.
 */
export function findEntryForSession(
  markdown: string,
  claudeSessionId: string
): { index: number; entry: ParsedLogEntry } | null {
  if (!claudeSessionId || claudeSessionId === 'backfill' || claudeSessionId === 'unknown') {
    return null;
  }
  const entries = parseLogEntries(markdown);
  const index = entries.findIndex((e) => e.meta?.claudeSessionId === claudeSessionId);
  return index === -1 ? null : { index, entry: entries[index] };
}

/**
 * The human-readable body of an entry: marker and heading stripped.
 * Used to show a generator what it previously wrote so it can extend it.
 */
export function entryBodyOnly(entry: ParsedLogEntry): string {
  return entry.body
    .split('\n')
    .filter((l) => !l.startsWith('<!--') && !l.startsWith('## '))
    .join('\n')
    .trim();
}
