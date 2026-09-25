import { exec } from 'child_process';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { promisify } from 'util';
import { createLogger } from '../utils/logger.js';

const execAsync = promisify(exec);
const logger = createLogger('project-build');

const BUILD_TIMEOUT_MS = 5 * 60_000;
const MAX_OUTPUT_CHARS = 300;

export interface BuildResult {
  /** False when the project declares no build, so nothing was run. */
  ran: boolean;
  ok: boolean;
  detail: string;
}

function tail(text: string): string {
  const trimmed = text.trim();
  return trimmed.length > MAX_OUTPUT_CHARS ? `…${trimmed.slice(-MAX_OUTPUT_CHARS)}` : trimmed;
}

/** The project's declared build command, or null when it has none. */
export function buildCommandFor(cwd: string): string | null {
  const pkgPath = join(cwd, 'package.json');
  if (!existsSync(pkgPath)) return null;
  try {
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8')) as { scripts?: Record<string, unknown> };
    return typeof pkg.scripts?.build === 'string' ? 'npm run build' : null;
  } catch {
    // A package.json we cannot parse declares nothing we can trust.
    return null;
  }
}

/**
 * Build the project in its main checkout, e.g. after a track lands.
 *
 * Only runs a build the project itself declares; guessing a command would
 * report failures for projects that were never meant to be built. It does not
 * restart anything — for claude-remote itself the new dist/ is picked up on the
 * next restart.
 */
export async function buildProject(cwd: string): Promise<BuildResult> {
  const command = buildCommandFor(cwd);
  if (!command) return { ran: false, ok: true, detail: 'no build script' };
  try {
    await execAsync(command, {
      cwd,
      timeout: BUILD_TIMEOUT_MS,
      windowsHide: true,
      maxBuffer: 8 * 1024 * 1024,
    });
    logger.info({ cwd, command }, 'build passed');
    return { ran: true, ok: true, detail: 'build passed' };
  } catch (error) {
    const e = error as { stdout?: string; stderr?: string; message?: string; killed?: boolean };
    logger.warn({ cwd, command }, 'build failed');
    const why = e.killed
      ? `timed out after ${BUILD_TIMEOUT_MS / 1000}s`
      : tail(`${e.stdout || ''}\n${e.stderr || ''}`) || e.message || 'failed';
    return { ran: true, ok: false, detail: `build failed: ${why}` };
  }
}
