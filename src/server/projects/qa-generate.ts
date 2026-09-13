import { existsSync, readFileSync } from 'fs';
import { basename } from 'path';
import { createLogger } from '../utils/logger.js';
import { getConfig } from '../config.js';
import { runClaude } from '../agent/claude-run.js';
import { COMPANION_DIR } from './project-store.js';
import { qaDocPathIn, qaDocRelPath, parseQaDoc, type QaDoc } from '../jobs/qa-doc.js';
import type { RegistryProject } from './registry.js';

const logger = createLogger('qa-generate');

/**
 * Draft a project's QA.md.
 *
 * Explicitly a DRAFT: the user reads, edits and approves it, which is why the
 * prompt pushes hard for brevity. A long generated QA doc will not be read, and
 * an unread QA doc is worse than none — it creates the appearance of a checked
 * project without the substance.
 */

export type QaGenerateOutcome = 'generated' | 'exists' | 'error';

export interface QaGenerateResult {
  outcome: QaGenerateOutcome;
  path: string;
  doc: QaDoc | null;
  detail: string | null;
}

function buildPrompt(projectName: string, path: string): string {
  return `Write a SHORT automated-QA contract for this project at ${path}.

This document says what "verified" means here. A human reads and approves it, so
brevity matters more than completeness: aim for under 30 lines total.

FIRST, work out how this project can actually be checked:
- Read package.json / CLAUDE.md / README for the real test, lint and build commands.
- Look for a test runner, a Playwright config, a Unity project, or nothing at all.

THEN write ${path} in EXACTLY this shape:

---
driver: <commands | playwright | unity | manual>
commands:
  - <a real command from this project, e.g. npm test>
---

# QA — ${projectName}

## Preconditions
- <anything that must be true first; omit the section if nothing is needed>

## Flows
1. <the single most important thing a user does>
   expect: <the observable result that proves it worked>

RULES
- driver: "commands" if the project is verified by running its own commands;
  "playwright" only if Playwright is genuinely set up; "unity" for a Unity
  project driven through the editor; "manual" if it honestly cannot be
  automated.
- Every command must be one this project actually has. Do not invent scripts.
- At most 5 flows, each two lines. Pick the ones whose breakage would matter
  most. An empty Flows section is better than invented ones.
- No prose beyond the sections above.

CONSTRAINTS
- Create ONLY ${path}. Touch no other file.`;
}

/**
 * Generate a QA doc for a project. Refuses to overwrite an existing one: it is
 * a user-approved document, and silently replacing their edits would be the
 * worst possible behaviour for a button labelled "generate".
 */
export async function generateQaDoc(
  project: RegistryProject,
  options: { force?: boolean } = {}
): Promise<QaGenerateResult> {
  const path = qaDocPathIn(project.cwd);
  const rel = qaDocRelPath();

  if (existsSync(path) && !options.force) {
    return {
      outcome: 'exists',
      path: rel,
      doc: parseQaDoc(readFileSync(path, 'utf-8')),
      detail: 'This project already has a QA doc. Edit it directly, or delete it to regenerate.',
    };
  }

  try {
    logger.info({ cwd: project.cwd }, 'qa-generate: drafting QA doc');
    await runClaude(
      project.cwd,
      buildPrompt(basename(project.cwd) || project.cwd, rel),
      [`${COMPANION_DIR}/**`],
      {
        allowedTools: ['Read', 'Glob', 'Grep', 'Write'],
        timeoutMs: getConfig().projectLog.timeoutMs,
        failOnDenial: false,
      }
    );

    if (!existsSync(path)) {
      return { outcome: 'error', path: rel, doc: null, detail: 'The run wrote no QA doc.' };
    }

    const doc = parseQaDoc(readFileSync(path, 'utf-8'));
    logger.info({ cwd: project.cwd, driver: doc.driver }, 'qa-generate: drafted');
    return {
      outcome: 'generated',
      path: rel,
      doc,
      detail:
        doc.driver === 'manual'
          ? 'Drafted as manual QA — review it; automated checks will be skipped.'
          : null,
    };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    logger.warn({ cwd: project.cwd, err: detail }, 'qa-generate: failed');
    return { outcome: 'error', path: rel, doc: null, detail };
  }
}
