import { createLogger } from '../../utils/logger.js';
import { getConfig } from '../../config.js';
import { runClaude, type UsageSink } from '../../agent/claude-run.js';
import { commitAll, diffStat } from '../worktree.js';
import type { Finding } from '../findings.js';

const logger = createLogger('stage-fix');

/**
 * Fix stage: apply the review findings the user ticked — and only those.
 *
 * The selection is the user's decision, so this stage's job is obedience. A run
 * that "also fixed" an unticked finding has quietly overridden the gate, which
 * is why the prompt is explicit about the untouched ones and why the stage
 * reports what actually changed.
 */

export interface FixResult {
  claudeSessionId: string | null;
  stat: { files: number; insertions: number; deletions: number };
  /** Findings the run reported it could not apply. */
  unresolved: string[];
}

function renderFinding(f: Finding, index: number): string {
  const where = f.file ? `${f.file}${f.line ? `:${f.line}` : ''}` : '(no file given)';
  return [
    `${index + 1}. [${f.severity}] ${f.title}`,
    `   Location: ${where}`,
    f.detail ? `   Problem: ${f.detail}` : '',
    f.suggestion ? `   Suggested fix: ${f.suggestion}` : '',
  ]
    .filter(Boolean)
    .join('\n');
}

function buildFixPrompt(opts: { selected: Finding[]; skipped: Finding[] }): string {
  const { selected, skipped } = opts;

  const skippedBlock =
    skipped.length > 0
      ? `\nTHE USER DELIBERATELY DID NOT SELECT THESE. Leave them alone:\n${skipped
          .map((f) => `- ${f.title}${f.file ? ` (${f.file})` : ''}`)
          .join('\n')}\n`
      : '';

  return `Apply the following code-review findings. The user reviewed the full list and
chose exactly these; treat that selection as the specification.

FINDINGS TO FIX
${selected.map(renderFinding).join('\n\n')}
${skippedBlock}
HOW TO WORK
1. Fix each selected finding. Follow the suggested fix unless it is actually
   wrong, in which case do the right thing and say so in your summary.
2. Re-run the project's tests after your changes. If the project has a lint or
   typecheck step, run that too. Leave the tree green.
3. Change nothing else. No opportunistic refactors, no reformatting of untouched
   lines, no fixes to the unselected findings above.

IF A FINDING CANNOT BE APPLIED
Say so explicitly in your final summary, prefixed with "UNRESOLVED:", one line
each, and move on to the others. Do not invent a different change in its place.

CONSTRAINTS
- Do not commit; the pipeline handles commits.
- End with a short summary: what you changed per finding, and what you ran.`;
}

/** Lines the run flagged as unapplied, pulled from its summary. */
export function extractUnresolved(summary: string): string[] {
  return summary
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.toUpperCase().startsWith('UNRESOLVED:'))
    .map((l) => l.slice('UNRESOLVED:'.length).trim())
    .filter(Boolean);
}

export async function runFixStage(opts: {
  jobId: string;
  worktreePath: string;
  baseBranch: string;
  selected: Finding[];
  skipped: Finding[];
  title: string;
  onUsage?: UsageSink;
}): Promise<FixResult> {
  const { jobId, worktreePath, baseBranch, selected, skipped, title, onUsage } = opts;

  const prompt = buildFixPrompt({ selected, skipped });

  logger.info({ jobId, selected: selected.length }, 'fix: running');
  const result = await runClaude(worktreePath, prompt, ['**'], {
    allowedTools: ['Read', 'Glob', 'Grep', 'Edit', 'Write', 'Bash'],
    timeoutMs: getConfig().projectLog.timeoutMs,
    failOnDenial: false,
    onUsage,
  });

  await commitAll(worktreePath, `fix: review findings for ${title}`);
  const stat = await diffStat(worktreePath, baseBranch);
  const unresolved = extractUnresolved(result.result);

  logger.info({ jobId, ...stat, unresolved: unresolved.length }, 'fix: finished');
  return { claudeSessionId: result.sessionId, stat, unresolved };
}
