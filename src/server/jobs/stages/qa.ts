import { exec } from 'child_process';
import { promisify } from 'util';
import { createLogger } from '../../utils/logger.js';
import { getConfig } from '../../config.js';
import { runClaude, type UsageSink } from '../../agent/claude-run.js';
import { readProjectDoc } from '../../projects/project-store.js';
import { checkDriver, readQaDoc, qaDocRelPath, type ProcessProbe } from '../qa-doc.js';

const execAsync = promisify(exec);
const logger = createLogger('stage-qa');

/**
 * QA stage: verify the change actually works.
 *
 * Two layers, deliberately distinct:
 *  - declared commands run deterministically with no agent involved, so their
 *    pass/fail is something you can trust at a merge gate; and
 *  - the flows in QA.md are exercised by an agent, which catches what no
 *    declared command covers but cannot be a hard gate on its own.
 *
 * The rule that matters most: an unverified change is NEVER reported as
 * verified. When a declared driver is unreachable the check is skipped with the
 * reason attached, and the board says so.
 */

export type CheckStatus = 'passed' | 'failed' | 'skipped';

export interface QaCheck {
  name: string;
  status: CheckStatus;
  /** Failure output or skip reason, trimmed for the board. */
  detail: string | null;
}

export interface QaResult {
  outcome: CheckStatus;
  checks: QaCheck[];
  summary: string;
  claudeSessionId: string | null;
}

/** Per-command timeout; a hung test run must not hold the pipeline open. */
const COMMAND_TIMEOUT_MS = 5 * 60 * 1000;
const MAX_OUTPUT_CHARS = 1200;

function tail(text: string, limit = MAX_OUTPUT_CHARS): string {
  const trimmed = text.trim();
  return trimmed.length > limit ? `…${trimmed.slice(-limit)}` : trimmed;
}

/**
 * Run one declared command in the worktree. Non-zero exit is a failure, full
 * stop — this is the deterministic half, so it does not get to interpret.
 */
async function runCommand(cwd: string, command: string): Promise<QaCheck> {
  try {
    const { stdout, stderr } = await execAsync(command, {
      cwd,
      timeout: COMMAND_TIMEOUT_MS,
      windowsHide: true,
      maxBuffer: 8 * 1024 * 1024,
    });
    logger.info({ command }, 'qa: command passed');
    return { name: command, status: 'passed', detail: tail(`${stdout}\n${stderr}`, 300) || null };
  } catch (error) {
    const e = error as { stdout?: string; stderr?: string; message?: string; killed?: boolean };
    const output = tail(`${e.stdout || ''}\n${e.stderr || ''}`) || e.message || 'failed';
    logger.warn({ command }, 'qa: command failed');
    return {
      name: command,
      status: 'failed',
      detail: e.killed ? `Timed out after ${COMMAND_TIMEOUT_MS / 1000}s` : output,
    };
  }
}

function buildFlowPrompt(opts: { qaBody: string; driver: string }): string {
  const { qaBody, driver } = opts;
  return `Exercise this project's QA flows against the current working tree and report
what you observed. You are verifying, not fixing.

Driver: ${driver}

=== QA FLOWS (${qaDocRelPath()}) ===
${qaBody}
=== END FLOWS ===

HOW TO WORK
1. Satisfy the preconditions if you can do so with the project's own commands.
2. Walk each flow and check the stated expectation.
3. Report per flow: PASS, FAIL, or SKIP with the reason it could not be run.

RULES
- Do NOT modify any source file. If a flow fails, report it; do not fix it.
- Never report PASS for something you did not actually observe. If you could
  not run a flow — a service was not up, a driver was unavailable — say SKIP and
  why. An honest SKIP is far more useful than an optimistic PASS.
- End with a single final line: "QA RESULT: PASS" or "QA RESULT: FAIL" or
  "QA RESULT: SKIP".`;
}

/** The verdict line the flow pass is asked to end with. */
export function parseFlowVerdict(text: string): CheckStatus | null {
  const match = text.match(/QA RESULT:\s*(PASS|FAIL|SKIP)/i);
  if (!match) return null;
  const word = match[1].toUpperCase();
  return word === 'PASS' ? 'passed' : word === 'FAIL' ? 'failed' : 'skipped';
}

/** Roll individual checks up into the stage's outcome. */
export function rollUp(checks: QaCheck[]): { outcome: CheckStatus; summary: string } {
  if (checks.length === 0) {
    return { outcome: 'skipped', summary: 'no QA declared' };
  }
  const failed = checks.filter((c) => c.status === 'failed');
  const skipped = checks.filter((c) => c.status === 'skipped');
  const passed = checks.filter((c) => c.status === 'passed');

  const parts: string[] = [];
  if (passed.length) parts.push(`${passed.length} passed`);
  if (failed.length) parts.push(`${failed.length} failed`);
  if (skipped.length) parts.push(`${skipped.length} skipped`);
  const summary = parts.join(', ');

  // Precedence is failed > skipped > passed, and the skipped rung is the one
  // that matters: if ANY declared check did not run, the change is not
  // verified, however many trivial ones passed alongside it. Letting a
  // `node --check` outrank a Unity flow that never ran is precisely how
  // unverified work reaches a merge gate wearing a green badge.
  if (failed.length > 0) return { outcome: 'failed', summary };
  if (skipped.length > 0) return { outcome: 'skipped', summary };
  if (passed.length === 0) return { outcome: 'skipped', summary };
  return { outcome: 'passed', summary };
}

export async function runQaStage(opts: {
  jobId: string;
  worktreePath: string;
  isProcessRunning?: ProcessProbe;
  onUsage?: UsageSink;
  /** Aborts the underlying claude run when the job is cancelled. */
  signal?: AbortSignal;
}): Promise<QaResult> {
  const { jobId, worktreePath, isProcessRunning, onUsage, signal } = opts;

  const qa = readQaDoc(worktreePath);
  // PROJECT.md's verify list is the other source of declared commands, so a
  // project gets a meaningful QA stage before anyone writes a QA.md.
  const projectVerify = readProjectDoc({ cwd: worktreePath }).doc.frontmatter.verify;

  const commands = [...new Set([...(qa?.commands ?? []), ...projectVerify])];
  const checks: QaCheck[] = [];

  for (const command of commands) {
    checks.push(await runCommand(worktreePath, command));
  }

  let claudeSessionId: string | null = null;

  if (qa?.body) {
    const driver = checkDriver(qa.driver, worktreePath, isProcessRunning);
    if (!driver.available) {
      // The declared way of checking this project is not reachable right now.
      // Skip loudly rather than quietly calling the change verified.
      checks.push({ name: `QA flows (${qa.driver})`, status: 'skipped', detail: driver.reason });
      logger.info({ jobId, driver: qa.driver, reason: driver.reason }, 'qa: driver unavailable');
    } else {
      const result = await runClaude(worktreePath, buildFlowPrompt({ qaBody: qa.body, driver: qa.driver }), [], {
        allowedTools: ['Read', 'Glob', 'Grep', 'Bash'],
        timeoutMs: getConfig().jobs.stageTimeoutMs,
        signal,
        failOnDenial: false,
        onUsage,
      });
      claudeSessionId = result.sessionId;

      const verdict = parseFlowVerdict(result.result);
      checks.push({
        name: `QA flows (${qa.driver})`,
        // No verdict line means the run did not conclude. That is a skip, not a
        // pass: we have no evidence either way.
        status: verdict ?? 'skipped',
        detail: verdict ? tail(result.result, 600) : 'The QA run did not report a verdict.',
      });
    }
  } else if (commands.length === 0) {
    checks.push({
      name: 'QA',
      status: 'skipped',
      detail: `No ${qaDocRelPath()} and no verify commands declared — nothing was checked.`,
    });
  }

  const { outcome, summary } = rollUp(checks);
  logger.info({ jobId, outcome, summary }, 'qa: finished');
  return { outcome, checks, summary, claudeSessionId };
}
