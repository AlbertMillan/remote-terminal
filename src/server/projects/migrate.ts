import { existsSync } from 'fs';
import { basename } from 'path';
import { getConfig } from '../config.js';
import { createLogger } from '../utils/logger.js';
import { git, isGitRepo, runClaude } from '../agent/claude-run.js';
import { docPathFor, type RegistryProject } from './registry.js';
import {
  COMPANION_DIR,
  ensureReviewsIgnored,
  readProjectDoc,
  writeProjectDoc,
} from './project-store.js';
import { allFeatures, healMissingIds } from './project-doc-format.js';

const logger = createLogger('project-migrate');

const MAX_LOG_CHARS = 2000;

export type MigrateOutcome = 'migrated' | 'skipped' | 'error';

export interface MigrateResult {
  cwd: string;
  outcome: MigrateOutcome;
  featureCount: number;
  /** Why a run produced nothing, for the board to surface. */
  detail: string | null;
}

/**
 * Instructions for converting a project's existing plan docs into the canonical
 * index.
 *
 * A model interprets the project's existing plan docs because real ones follow
 * no single convention (H3 headings, "Phase N"/"M-N"/"SU-N" ids, "✅ shipped"
 * suffixes), and one project often runs several tracks that must not be merged.
 *
 * This runs ONCE per project: afterwards the file is authoritative and the
 * server reads and writes it deterministically, so a UI edit is never
 * overwritten by a later agent pass. Feature ids are deliberately NOT asked of
 * the model — the server assigns them, which is what makes them well-formed and
 * unique.
 */
function buildMigratePrompt(opts: {
  cwd: string;
  fileName: string;
  planGlobs: string[];
  log: string;
  projectName: string;
}): string {
  const { cwd, fileName, planGlobs, log, projectName } = opts;

  return `Create a canonical project index at ${fileName} for the project at ${cwd}.

This file is the single place this project's features and their status are
tracked from now on. It will be read and written by a dashboard, so the format
below is exact.

HOW TO GATHER THE CONTENT
1. Read CLAUDE.md and README if present, to understand what the project is.
2. Use Glob to find the project's plan/design docs (patterns: ${planGlobs.join(', ')}) and read them.
3. Extract the project's features / development stages. Docs differ wildly:
   numbered "Phase N", "M1"/"M2" milestones, "SU-N"/"DS-N" stages, "✅ shipped"
   suffixes, a status blockquote, or plain prose. Interpret each and normalize.
4. If the project has no plan docs at all, derive a short feature list from the
   code and README instead. An accurate short list beats an invented long one.

FORMAT — write EXACTLY this shape:

---
name: ${projectName}
status: active
---

## Track: <track label>
- [x] <title of a completed feature>
- [~] P1 <title of a feature in progress>
- [ ] P2 <title of a pending feature>

RULES
- Checkbox: [x] done, [~] in progress, [ ] pending, [!] blocked. Be faithful to
  what the docs actually claim; do not mark something done on a hunch.
- "P1".."P3" is an OPTIONAL priority, written right after the checkbox. Use it
  only where the docs express priority or an obvious ordering. Omit it otherwise.
- Keep each plan track / doc as its OWN "## Track:" section. NEVER merge
  different axes — do not mix "Phase 2" with "SU-2". Preserve the logical
  execution order within each track.
- Where a stage has a doc-native identifier (Phase 3, M2, SU-4), keep it at the
  START of the title, e.g. "- [x] Phase 3 — whois caching". Do NOT invent
  bracketed ids or backtick ids of your own; the server assigns those.
- Titles are one short line each. No prose paragraphs, no nested bullets, no
  trailing commentary inside a track.
- \`status:\` is one of: idea, active, paused, shipped, abandoned.
- If a feature needs detail beyond its title, create ${COMPANION_DIR}/<slug>.md
  with that detail and link it by appending " → ${COMPANION_DIR}/<slug>.md" to
  the feature's line. Only do this where real detail already exists in the
  source docs — do not invent specs.

STRICT CONSTRAINTS
- Create ONLY ${fileName} and files under ${COMPANION_DIR}/. Touch no other file.
- Do NOT modify the plan/design docs you read. This run only reads them.
- Be factual. Every feature must trace to something in the docs or the code.

=== RECENT COMMITS (context for what actually exists) ===
${log || '(none)'}
`;
}

/**
 * Convert a project's existing plan docs into a canonical PROJECT.md.
 *
 * User-initiated, so it runs regardless of projectLog.enabled — that flag
 * governs automatic session logging, which this is not. Never throws; the
 * outcome is reported for the board to render.
 */
export async function migrateProject(project: RegistryProject): Promise<MigrateResult> {
  const cwd = project.cwd;
  const docPath = docPathFor(project);
  const fileName = project.doc || 'PROJECT.md';
  const fail = (detail: string): MigrateResult => ({
    cwd,
    outcome: 'error',
    featureCount: 0,
    detail,
  });

  try {
    if (existsSync(docPath)) {
      // Never overwrite an existing index — it is authoritative once written.
      return { cwd, outcome: 'skipped', featureCount: 0, detail: 'Project index already exists' };
    }
    if (!existsSync(cwd)) {
      return fail('Project directory no longer exists');
    }

    let log = '';
    if (await isGitRepo(cwd)) {
      log = ((await git(cwd, ['log', '-n', '40', '--oneline'])) || '').slice(0, MAX_LOG_CHARS);
    }

    const cfg = getConfig().projectLog;
    const prompt = buildMigratePrompt({
      cwd,
      fileName,
      planGlobs: cfg.planGlobs,
      log,
      projectName: basename(cwd) || cwd,
    });

    logger.info({ cwd }, 'migrate: generating canonical project index');
    // Writes are confined to the index plus the companion folder; anything else
    // the run touches is reverted by runClaude's post-run scope check.
    await runClaude(cwd, prompt, [fileName, `${COMPANION_DIR}/**`], { tag: { projectCwd: cwd, kind: 'migrate' } });

    // A run can exit 0 without writing anything (derailed, or it decided there
    // was nothing to do). Don't report success on a no-write — the board offers
    // a retry instead.
    if (!existsSync(docPath)) {
      logger.warn({ cwd }, 'migrate: run completed but no index was written');
      return fail('The run finished without writing a project index');
    }

    // Normalize what the model wrote: assign stable ids and re-render through
    // our own writer, so the file on disk always matches the canonical shape
    // regardless of formatting drift in the generated output.
    const state = readProjectDoc(project);
    healMissingIds(state.doc);
    const written = writeProjectDoc(project, state.doc, state.revision);
    const featureCount = allFeatures(written.doc).length;

    // Per-job review findings live beside the index but must never be committed.
    ensureReviewsIgnored(project);

    logger.info({ cwd, featureCount }, 'migrate: project index created');
    return {
      cwd,
      outcome: 'migrated',
      featureCount,
      detail: featureCount === 0 ? 'Index created, but no features were identified' : null,
    };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    logger.warn({ cwd, err: detail }, 'migrate: failed');
    return fail(detail);
  }
}
