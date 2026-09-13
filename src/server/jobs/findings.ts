import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { createLogger } from '../utils/logger.js';
import { COMPANION_DIR, REVIEWS_DIR } from '../projects/project-store.js';

const logger = createLogger('job-findings');

/**
 * Single source of truth for the review-findings file.
 *
 * The review stage writes it, the API serves it, the user's selection is
 * recorded back into it, and the fix stage reads it — so all four agree on one
 * shape defined here, the same reason session-log-format.ts exists.
 *
 * The file lives beside PROJECT.md but inside a gitignored folder: findings are
 * per-job scratch that would otherwise land in every commit.
 */

export type Severity = 'critical' | 'important' | 'nice';

export interface Finding {
  id: string;
  severity: Severity;
  file: string;
  line: number | null;
  title: string;
  detail: string;
  /** What the reviewer proposes doing about it. */
  suggestion: string;
  /**
   * Whether the user ticked this one at the review gate. Only selected
   * findings are handed to the fix stage.
   */
  selected: boolean;
}

export interface FindingsFile {
  jobId: string;
  generatedAt: string;
  findings: Finding[];
}

/** Path of a job's findings file, relative to the project root. */
export function findingsRelPath(jobId: string): string {
  return `${COMPANION_DIR}/${REVIEWS_DIR}/${jobId}.json`;
}

export function findingsAbsPath(worktreePath: string, jobId: string): string {
  return join(worktreePath, findingsRelPath(jobId));
}

const SEVERITIES: Severity[] = ['critical', 'important', 'nice'];

function normalizeSeverity(value: unknown): Severity {
  if (typeof value !== 'string') return 'nice';
  const lower = value.toLowerCase();
  if ((SEVERITIES as string[]).includes(lower)) return lower as Severity;
  // Tolerate the wordier labels the review criteria use as headings.
  if (lower.startsWith('crit')) return 'critical';
  if (lower.startsWith('import') || lower.startsWith('major')) return 'important';
  return 'nice';
}

function normalizeLine(value: unknown): number | null {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isInteger(n) && n > 0 ? n : null;
}

/**
 * Coerce whatever the review run wrote into valid findings.
 *
 * Defensive by design: the file is model-authored, so a missing field or an
 * unexpected severity must degrade to a usable row rather than throw and lose
 * the whole review. Entries with no title AND no file are dropped as noise.
 */
export function parseFindings(raw: unknown, jobId: string): FindingsFile {
  const empty: FindingsFile = { jobId, generatedAt: new Date().toISOString(), findings: [] };
  if (!raw || typeof raw !== 'object') return empty;

  const obj = raw as Record<string, unknown>;
  // Accept either { findings: [...] } or a bare array.
  const list = Array.isArray(obj.findings) ? obj.findings : Array.isArray(raw) ? raw : [];

  const findings: Finding[] = [];
  list.forEach((entry, index) => {
    if (!entry || typeof entry !== 'object') return;
    const e = entry as Record<string, unknown>;
    const title = typeof e.title === 'string' ? e.title.trim() : '';
    const file = typeof e.file === 'string' ? e.file.trim() : '';
    if (!title && !file) return;

    findings.push({
      id: typeof e.id === 'string' && e.id.trim() ? e.id.trim() : `r${index + 1}`,
      severity: normalizeSeverity(e.severity),
      file,
      line: normalizeLine(e.line),
      title: title || file,
      detail: typeof e.detail === 'string' ? e.detail.trim() : '',
      suggestion: typeof e.suggestion === 'string' ? e.suggestion.trim() : '',
      // A fresh review starts with nothing selected: acting on a finding is the
      // user's decision, which is the entire point of this gate.
      selected: e.selected === true,
    });
  });

  // Most severe first, so the gate leads with what matters.
  const rank = (s: Severity): number => SEVERITIES.indexOf(s);
  findings.sort((a, b) => rank(a.severity) - rank(b.severity));

  return {
    jobId,
    generatedAt: typeof obj.generatedAt === 'string' ? obj.generatedAt : empty.generatedAt,
    findings,
  };
}

/** Read a job's findings, or null when the file is missing/unreadable. */
export function readFindings(worktreePath: string, jobId: string): FindingsFile | null {
  const path = findingsAbsPath(worktreePath, jobId);
  if (!existsSync(path)) return null;
  try {
    return parseFindings(JSON.parse(readFileSync(path, 'utf-8')), jobId);
  } catch (error) {
    logger.warn({ error, path }, 'findings: unreadable or malformed');
    return null;
  }
}

export function writeFindings(worktreePath: string, file: FindingsFile): void {
  const path = findingsAbsPath(worktreePath, file.jobId);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(file, null, 2)}\n`, 'utf-8');
}

/**
 * Record which findings the user ticked. Ids not present are left untouched,
 * so a stale board snapshot can't silently deselect something.
 */
export function applySelection(file: FindingsFile, selectedIds: string[]): FindingsFile {
  const wanted = new Set(selectedIds);
  return {
    ...file,
    findings: file.findings.map((f) => ({ ...f, selected: wanted.has(f.id) })),
  };
}

export function selectedFindings(file: FindingsFile | null): Finding[] {
  return file ? file.findings.filter((f) => f.selected) : [];
}

/** One-line summary for the stage detail column. */
export function summarize(file: FindingsFile | null): string {
  if (!file || file.findings.length === 0) return 'no findings';
  const counts = { critical: 0, important: 0, nice: 0 };
  for (const f of file.findings) counts[f.severity]++;
  const parts: string[] = [];
  if (counts.critical) parts.push(`${counts.critical} critical`);
  if (counts.important) parts.push(`${counts.important} important`);
  if (counts.nice) parts.push(`${counts.nice} nice-to-have`);
  return parts.join(', ');
}
