// Single source of truth for the canonical PROJECT.md format. The migration
// prompt (which asks a model to author the file), the deterministic parser, and
// every server-side write must agree on the exact line shape, so all three live
// here to prevent drift — the same reason session-log-format.ts exists.
//
// Design rules:
//  - Parsing NEVER throws. A malformed file yields an empty-but-valid doc, so a
//    hand-edited project can't take the board down (mirrors parsePhasesBlock).
//  - Unrecognized lines are preserved verbatim on re-render. The file is
//    human-owned; we are a guest in it.

export type FeatureStatus = 'pending' | 'in_progress' | 'done' | 'blocked';

const STATUS_BY_CHAR: Record<string, FeatureStatus> = {
  ' ': 'pending',
  '~': 'in_progress',
  x: 'done',
  X: 'done',
  '!': 'blocked',
};

const CHAR_BY_STATUS: Record<FeatureStatus, string> = {
  pending: ' ',
  in_progress: '~',
  done: 'x',
  blocked: '!',
};

export interface Feature {
  id: string; // stable, server-generated, e.g. "f-a1b2c3"
  status: FeatureStatus;
  priority: number | null; // 0-9 from "P1"; null when unprioritised
  title: string;
  spec: string | null; // relative path to the spec file, e.g. "project/x.md"
}

/**
 * A track's body, modelled as an ordered mix of parsed features and raw lines.
 * Keeping raw lines inline (rather than hoisting them) is what lets prose sit
 * between features and survive a re-render in its original position.
 */
export type TrackItem =
  | { kind: 'feature'; feature: Feature }
  | { kind: 'raw'; text: string };

export interface Track {
  name: string; // "Feature roadmap" from "## Track: Feature roadmap"
  items: TrackItem[];
}

export interface ProjectDoc {
  frontmatter: Frontmatter;
  tracks: Track[];
  /** Lines before the first track heading (kept verbatim on re-render). */
  preamble: string[];
}

/** The features of one track, in document order. */
export function featuresOf(track: Track): Feature[] {
  return track.items.flatMap((i) => (i.kind === 'feature' ? [i.feature] : []));
}

/** Every feature across every track, in document order. */
export function allFeatures(doc: ProjectDoc): Feature[] {
  return doc.tracks.flatMap(featuresOf);
}

// --- Frontmatter -----------------------------------------------------------
// Deliberately NOT YAML: the project has no yaml dependency and these documents
// only ever need `key: value` and a `key:` followed by `- item` lines. Anything
// more exotic is preserved as an unknown key rather than parsed.

export interface Frontmatter {
  name: string | null;
  status: string | null;
  verify: string[]; // shell commands the QA stage may run
  /** Keys we don't model, preserved so a re-render never drops user data. */
  extra: Record<string, string | string[]>;
}

const KNOWN_KEYS = new Set(['name', 'status', 'verify']);

export function emptyFrontmatter(): Frontmatter {
  return { name: null, status: null, verify: [], extra: {} };
}

/**
 * Split a document into its frontmatter block and body. A file with no leading
 * `---` fence is all body — frontmatter is optional by design, so a two-line
 * PROJECT.md is still valid.
 */
function splitFrontmatter(markdown: string): { fm: string[]; body: string[] } {
  const lines = markdown.replace(/\r\n/g, '\n').split('\n');
  // Drop the single empty element a trailing newline produces. It is an artifact
  // of the file's final "\n" (which renderProjectDoc always writes), not content
  // — and left in place it becomes a raw item at the end of the last track, so
  // each append would insert another blank line than the one before.
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();

  if (lines[0]?.trim() !== '---') return { fm: [], body: lines };
  const end = lines.findIndex((l, i) => i > 0 && l.trim() === '---');
  if (end === -1) return { fm: [], body: lines }; // unterminated fence — treat as body
  return { fm: lines.slice(1, end), body: lines.slice(end + 1) };
}

function parseFrontmatter(fmLines: string[]): Frontmatter {
  const fm = emptyFrontmatter();
  let listKey: string | null = null;

  for (const raw of fmLines) {
    const listItem = raw.match(/^\s+-\s+(.*)$/);
    if (listItem && listKey) {
      const value = stripQuotes(listItem[1].trim());
      if (listKey === 'verify') fm.verify.push(value);
      else {
        const bucket = fm.extra[listKey];
        if (Array.isArray(bucket)) bucket.push(value);
        else fm.extra[listKey] = [value];
      }
      continue;
    }

    const pair = raw.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!pair) continue; // comment, blank, or junk — ignore
    const [, key, rest] = pair;
    if (rest.trim() === '') {
      // `key:` with items on following lines
      listKey = key;
      if (key === 'verify') fm.verify = [];
      else fm.extra[key] = [];
      continue;
    }
    listKey = null;
    const value = stripQuotes(rest.trim());
    if (key === 'name') fm.name = value;
    else if (key === 'status') fm.status = value;
    else if (key === 'verify') fm.verify = [value];
    else if (!KNOWN_KEYS.has(key)) fm.extra[key] = value;
  }
  return fm;
}

function stripQuotes(s: string): string {
  if (s.length >= 2 && ((s[0] === '"' && s.endsWith('"')) || (s[0] === "'" && s.endsWith("'")))) {
    return s.slice(1, -1);
  }
  return s;
}

function renderFrontmatter(fm: Frontmatter): string[] {
  const out: string[] = ['---'];
  if (fm.name !== null) out.push(`name: ${fm.name}`);
  if (fm.status !== null) out.push(`status: ${fm.status}`);
  if (fm.verify.length > 0) {
    out.push('verify:');
    for (const cmd of fm.verify) out.push(`  - ${cmd}`);
  }
  for (const [key, value] of Object.entries(fm.extra)) {
    if (Array.isArray(value)) {
      out.push(`${key}:`);
      for (const item of value) out.push(`  - ${item}`);
    } else {
      out.push(`${key}: ${value}`);
    }
  }
  out.push('---');
  return out;
}

// --- Tracks & features -----------------------------------------------------

const TRACK_RE = /^##\s+Track:\s*(.+?)\s*$/;

// - [~] `f-a1b2` P1 Task dispatch queue → project/task-dispatch.md
// Every part after the checkbox is optional so a half-written line still parses
// into something the board can show (and a later write can heal).
const FEATURE_RE = /^\s*-\s*\[(.)\]\s*(?:`([^`]*)`)?\s*(?:P(\d))?\s*(.*)$/;

// Accept both the rendered arrow and a plain ASCII one — the file is hand-edited.
const SPEC_SEP_RE = /\s*(?:→|->)\s*/;

function parseFeatureLine(line: string): Feature | null {
  const m = line.match(FEATURE_RE);
  if (!m) return null;
  const [, statusChar, id, priority, rest] = m;
  const status = STATUS_BY_CHAR[statusChar];
  if (status === undefined) return null; // "[q]" is not a checkbox we understand

  let title = rest.trim();
  let spec: string | null = null;
  const sep = title.search(SPEC_SEP_RE);
  if (sep !== -1) {
    const parts = title.split(SPEC_SEP_RE);
    title = parts[0].trim();
    spec = parts.slice(1).join(' ').trim() || null;
  }

  return {
    id: (id || '').trim(),
    status,
    priority: priority === undefined ? null : Number(priority),
    title,
    spec,
  };
}

export function renderFeatureLine(f: Feature): string {
  const bits = [`- [${CHAR_BY_STATUS[f.status]}]`];
  if (f.id) bits.push(`\`${f.id}\``);
  if (f.priority !== null) bits.push(`P${f.priority}`);
  if (f.title) bits.push(f.title);
  const line = bits.join(' ');
  return f.spec ? `${line} → ${f.spec}` : line;
}

/**
 * Parse a PROJECT.md. Never throws: unparseable frontmatter, unknown checkbox
 * characters, and stray prose all degrade into preserved raw content rather
 * than an error, so a hand-edited file can't break the board.
 */
export function parseProjectDoc(markdown: string): ProjectDoc {
  const { fm, body } = splitFrontmatter(markdown ?? '');
  const doc: ProjectDoc = {
    frontmatter: parseFrontmatter(fm),
    tracks: [],
    preamble: [],
  };

  let current: Track | null = null;
  for (const line of body) {
    const track = line.match(TRACK_RE);
    if (track) {
      current = { name: track[1], items: [] };
      doc.tracks.push(current);
      continue;
    }
    if (!current) {
      doc.preamble.push(line);
      continue;
    }
    const feature = parseFeatureLine(line);
    current.items.push(feature ? { kind: 'feature', feature } : { kind: 'raw', text: line });
  }

  return doc;
}

/** Render a doc back to markdown. Round-trips an unmodified doc byte-for-byte
 *  apart from trailing-whitespace normalization. */
export function renderProjectDoc(doc: ProjectDoc): string {
  const out: string[] = [];
  const fm = doc.frontmatter;
  const hasFrontmatter =
    fm.name !== null || fm.status !== null || fm.verify.length > 0 || Object.keys(fm.extra).length > 0;
  if (hasFrontmatter) out.push(...renderFrontmatter(fm));

  out.push(...doc.preamble);
  for (const track of doc.tracks) {
    out.push(`## Track: ${track.name}`);
    for (const item of track.items) {
      out.push(item.kind === 'feature' ? renderFeatureLine(item.feature) : item.text);
    }
  }

  return `${out.join('\n').replace(/\s+$/, '')}\n`;
}

// --- Mutations -------------------------------------------------------------
// Every server-side write goes through these so ids stay stable and unknown
// content is never dropped. The caller handles the read-modify-write and the
// staleness precondition; these are pure functions over a parsed doc.

const ID_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';

/**
 * A short, stable feature id ("f-a1b2c3"). Ids are generated once and never
 * derived from the title, so renaming a feature can never orphan the job
 * history or review findings that reference it — the failure mode the old
 * heading-as-id phases manifest had.
 */
export function generateFeatureId(taken: Set<string>): string {
  for (let attempt = 0; attempt < 1000; attempt++) {
    let suffix = '';
    for (let i = 0; i < 6; i++) {
      suffix += ID_ALPHABET[Math.floor(Math.random() * ID_ALPHABET.length)];
    }
    const id = `f-${suffix}`;
    if (!taken.has(id)) return id;
  }
  // Astronomically unlikely; fall back to something guaranteed unique.
  return `f-${Date.now().toString(36)}`;
}

/** Ids already used anywhere in the doc. */
export function usedIds(doc: ProjectDoc): Set<string> {
  return new Set(allFeatures(doc).map((f) => f.id).filter(Boolean));
}

/**
 * Assign ids to any feature that lacks one (hand-written lines, or output from
 * a migration run that skipped them). Mutates and returns the doc; a no-op when
 * everything is already identified.
 */
export function healMissingIds(doc: ProjectDoc): ProjectDoc {
  const taken = usedIds(doc);
  for (const track of doc.tracks) {
    for (const item of track.items) {
      if (item.kind !== 'feature' || item.feature.id) continue;
      const id = generateFeatureId(taken);
      taken.add(id);
      item.feature.id = id;
    }
  }
  return doc;
}

export function findFeature(doc: ProjectDoc, id: string): { track: Track; feature: Feature } | null {
  for (const track of doc.tracks) {
    for (const item of track.items) {
      if (item.kind === 'feature' && item.feature.id === id) return { track, feature: item.feature };
    }
  }
  return null;
}

/** Ensure a track exists, creating it at the end of the doc if not. */
export function ensureTrack(doc: ProjectDoc, name: string): Track {
  const existing = doc.tracks.find((t) => t.name === name);
  if (existing) return existing;
  const track: Track = { name, items: [] };
  doc.tracks.push(track);
  return track;
}

export interface FeatureInput {
  title: string;
  status?: FeatureStatus;
  priority?: number | null;
  spec?: string | null;
  track?: string; // defaults to the first track, or "Feature roadmap"
}

const DEFAULT_TRACK = 'Feature roadmap';

/** Append a new feature and return it (with its freshly generated id). */
export function addFeature(doc: ProjectDoc, input: FeatureInput): Feature {
  const trackName = input.track || doc.tracks[0]?.name || DEFAULT_TRACK;
  const track = ensureTrack(doc, trackName);
  const feature: Feature = {
    id: generateFeatureId(usedIds(doc)),
    status: input.status ?? 'pending',
    priority: input.priority ?? null,
    title: input.title.trim(),
    spec: input.spec ?? null,
  };
  track.items.push({ kind: 'feature', feature });
  return feature;
}

/**
 * Update an existing feature in place. Only the provided fields change, so a
 * status toggle from the board can't clobber a title edited in the file since.
 * Returns null when the id is unknown.
 */
export function updateFeature(
  doc: ProjectDoc,
  id: string,
  patch: Partial<Omit<Feature, 'id'>> & { track?: string }
): Feature | null {
  const found = findFeature(doc, id);
  if (!found) return null;
  const { feature } = found;

  if (patch.status !== undefined) feature.status = patch.status;
  if (patch.priority !== undefined) feature.priority = patch.priority;
  if (patch.title !== undefined) feature.title = patch.title.trim();
  if (patch.spec !== undefined) feature.spec = patch.spec;

  // Moving tracks means physically relocating the line.
  if (patch.track !== undefined && patch.track !== found.track.name) {
    found.track.items = found.track.items.filter(
      (i) => !(i.kind === 'feature' && i.feature.id === id)
    );
    ensureTrack(doc, patch.track).items.push({ kind: 'feature', feature });
  }
  return feature;
}

/** Remove a feature. Returns true when something was actually removed. */
export function removeFeature(doc: ProjectDoc, id: string): boolean {
  for (const track of doc.tracks) {
    const before = track.items.length;
    track.items = track.items.filter((i) => !(i.kind === 'feature' && i.feature.id === id));
    if (track.items.length !== before) return true;
  }
  return false;
}

/**
 * Reorder features within a track to match `orderedIds`. Ids not present in the
 * track are ignored, and features omitted from the list keep their relative
 * order at the end — so a partial list from a drag-and-drop can't lose rows.
 * Raw lines hold their absolute positions; only feature slots are permuted.
 */
export function reorderFeatures(doc: ProjectDoc, trackName: string, orderedIds: string[]): boolean {
  const track = doc.tracks.find((t) => t.name === trackName);
  if (!track) return false;

  const features = featuresOf(track);
  const byId = new Map(features.map((f) => [f.id, f]));
  const ranked: Feature[] = [];
  for (const id of orderedIds) {
    const f = byId.get(id);
    if (f) {
      ranked.push(f);
      byId.delete(id);
    }
  }
  for (const f of features) if (byId.has(f.id)) ranked.push(f);

  let next = 0;
  track.items = track.items.map((item) =>
    item.kind === 'feature' ? { kind: 'feature', feature: ranked[next++] } : item
  );
  return true;
}
