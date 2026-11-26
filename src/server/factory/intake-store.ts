import { getDatabase } from '../db/schema.js';
import { pathKey } from '../utils/paths.js';

/**
 * What intake and shaping know about a loose item (`factory_intake`,
 * migration 027). The item store holds its execution state; PROJECT.md its
 * line. This holds the rest: the requirements intake split off the ask, the
 * "mockup first" flag, the spec shaping wrote and the files it expects to
 * touch (the overlap check), its assumptions, and a blocking question with
 * the session that asked it, which the answer resumes.
 */

/** Where an item came from: intake of free-form text, or work an agent or session discovered. */
export type IntakeSource = 'intake' | 'discovered';

/** A question shaping cannot proceed without: options to pick from and the one it would take. */
export interface ShapeQuestion {
  question: string;
  options: string[];
  default: string;
}

export interface IntakeRecord {
  projectCwd: string;
  featureId: string;
  source: IntakeSource;
  requirements: string[];
  mockupFirst: boolean;
  /** Free text that came with discovered work (what was seen, where). */
  detail: string | null;
  /** The shaped spec's file; null until shaping wrote one. */
  specPath: string | null;
  /** Files shaping expects the item to touch; null until shaped. */
  files: string[] | null;
  assumptions: string[];
  question: ShapeQuestion | null;
  answer: string | null;
  shapeSessionId: string | null;
  createdAt: string;
  updatedAt: string;
}

interface Row {
  project_key: string;
  feature_id: string;
  source: string;
  requirements: string;
  mockup_first: number;
  detail: string | null;
  spec_path: string | null;
  files: string | null;
  assumptions: string;
  question: string | null;
  answer: string | null;
  shape_session_id: string | null;
  created_at: string;
  updated_at: string;
}

function json<T>(text: string | null, fallback: T): T {
  if (text === null) return fallback;
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
}

const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);

function toRecord(projectCwd: string, row: Row): IntakeRecord {
  const files = row.files === null ? null : strings(json<unknown>(row.files, []));
  return {
    projectCwd,
    featureId: row.feature_id,
    source: row.source === 'discovered' ? 'discovered' : 'intake',
    requirements: strings(json<unknown>(row.requirements, [])),
    mockupFirst: row.mockup_first === 1,
    detail: row.detail,
    specPath: row.spec_path,
    files,
    assumptions: strings(json<unknown>(row.assumptions, [])),
    question: json<ShapeQuestion | null>(row.question, null),
    answer: row.answer,
    shapeSessionId: row.shape_session_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export interface NewIntake {
  projectCwd: string;
  featureId: string;
  source: IntakeSource;
  requirements?: string[];
  mockupFirst?: boolean;
  detail?: string | null;
}

/** Record intake's view of an item. The item must exist (foreign key). */
export function insertIntake(input: NewIntake, now = Date.now()): IntakeRecord {
  const at = new Date(now).toISOString();
  getDatabase()
    .prepare(
      `INSERT INTO factory_intake (project_key, feature_id, source, requirements, mockup_first, detail, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      pathKey(input.projectCwd),
      input.featureId,
      input.source,
      JSON.stringify(input.requirements ?? []),
      input.mockupFirst ? 1 : 0,
      input.detail ?? null,
      at,
      at
    );
  return getIntake(input.projectCwd, input.featureId) as IntakeRecord;
}

export function getIntake(projectCwd: string, featureId: string): IntakeRecord | null {
  const row = getDatabase()
    .prepare('SELECT * FROM factory_intake WHERE project_key = ? AND feature_id = ?')
    .get(pathKey(projectCwd), featureId) as Row | undefined;
  return row ? toRecord(projectCwd, row) : null;
}

/** Every item of a project shaping has estimated files for, with those files. */
export function shapedFiles(projectCwd: string): { featureId: string; files: string[] }[] {
  const rows = getDatabase()
    .prepare('SELECT * FROM factory_intake WHERE project_key = ? AND files IS NOT NULL ORDER BY updated_at, rowid')
    .all(pathKey(projectCwd)) as Row[];
  return rows.map((r) => ({ featureId: r.feature_id, files: toRecord(projectCwd, r).files ?? [] }));
}

export interface IntakePatch {
  specPath?: string | null;
  files?: string[] | null;
  assumptions?: string[];
  question?: ShapeQuestion | null;
  answer?: string | null;
  shapeSessionId?: string | null;
}

export function updateIntake(projectCwd: string, featureId: string, patch: IntakePatch, now = Date.now()): void {
  const sets: string[] = [];
  const values: (string | null)[] = [];
  const set = (column: string, value: string | null) => {
    sets.push(`${column} = ?`);
    values.push(value);
  };
  if (patch.specPath !== undefined) set('spec_path', patch.specPath);
  if (patch.files !== undefined) set('files', patch.files === null ? null : JSON.stringify(patch.files));
  if (patch.assumptions !== undefined) set('assumptions', JSON.stringify(patch.assumptions));
  if (patch.question !== undefined) set('question', patch.question === null ? null : JSON.stringify(patch.question));
  if (patch.answer !== undefined) set('answer', patch.answer);
  if (patch.shapeSessionId !== undefined) set('shape_session_id', patch.shapeSessionId);
  set('updated_at', new Date(now).toISOString());
  getDatabase()
    .prepare(`UPDATE factory_intake SET ${sets.join(', ')} WHERE project_key = ? AND feature_id = ?`)
    .run(...values, pathKey(projectCwd), featureId);
}
