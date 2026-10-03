import { spawn } from 'child_process';
import { existsSync } from 'fs';
import { rm } from 'fs/promises';
import { join } from 'path';
import { killTree } from '../agent/claude-run.js';
import { createLogger } from '../utils/logger.js';
import { pathKey } from '../sessions/project-discovery.js';

const logger = createLogger('project-deps');

const INSTALL_TIMEOUT_MS = 10 * 60_000;
const MAX_OUTPUT_CHARS = 600;
/** Output kept while the install runs; only the tail is ever reported. */
const KEEP_CHARS = 64 * 1024;

export interface InstallResult {
  /** False when the project has no lockfile, or `node_modules` was already there. */
  ran: boolean;
  ok: boolean;
  detail: string;
}

function tail(text: string): string {
  const trimmed = text.trim();
  return trimmed.length > MAX_OUTPUT_CHARS ? `…${trimmed.slice(-MAX_OUTPUT_CHARS)}` : trimmed;
}

/**
 * The install command the project's lockfile asks for, or null with none.
 *
 * Frozen installs only: a worktree must get exactly what its branch locked,
 * and an install that rewrites the lockfile would show up in the branch's diff.
 */
export function installCommandFor(cwd: string): string | null {
  if (existsSync(join(cwd, 'package-lock.json'))) return 'npm ci --prefer-offline --no-audit --no-fund';
  if (existsSync(join(cwd, 'pnpm-lock.yaml'))) return 'pnpm install --frozen-lockfile --prefer-offline';
  if (existsSync(join(cwd, 'yarn.lock'))) return 'yarn install --frozen-lockfile --prefer-offline';
  return null;
}

/** True when the project locks dependencies and `node_modules` is missing. */
export function needsInstall(cwd: string): boolean {
  return installCommandFor(cwd) !== null && !existsSync(join(cwd, 'node_modules'));
}

// One install per folder at a time. Two into one node_modules corrupt it, and
// a double-clicked Open session would otherwise start a second.
const inFlight = new Map<string, Promise<InstallResult>>();

/**
 * True while an install is writing into `cwd`. Land and Delete track refuse
 * then: their teardown would delete node_modules under a running npm, which
 * keeps writing into a folder git has already deregistered.
 */
export function isInstalling(cwd: string): boolean {
  return inFlight.has(pathKey(cwd));
}

/**
 * Install a worktree's own dependencies from its lockfile.
 *
 * Never links another checkout's `node_modules` in, as a fallback or
 * otherwise: `git worktree remove` on Windows deletes through a junction and
 * empties the target (docs/track-branches.md, "Dependencies"). A caller that
 * passes `signal` gets the whole process tree killed on abort, and the
 * promise settles only once it is dead, so a teardown that follows never
 * races npm writing into the folder.
 */
export function installDependencies(cwd: string, signal?: AbortSignal): Promise<InstallResult> {
  const key = pathKey(cwd);
  const running = inFlight.get(key);
  if (running) return running;
  const started = runInstall(cwd, signal).finally(() => inFlight.delete(key));
  inFlight.set(key, started);
  return started;
}

async function runInstall(cwd: string, signal?: AbortSignal): Promise<InstallResult> {
  if (!needsInstall(cwd)) return { ran: false, ok: true, detail: 'nothing to install' };
  const command = installCommandFor(cwd) as string;
  const startedAt = Date.now();
  logger.info({ cwd, command }, 'installing dependencies');

  let output = '';
  let stopped: 'timeout' | 'aborted' | null = null;
  let killed: Promise<void> = Promise.resolve();
  const code = await new Promise<number | null>((done) => {
    const child = spawn(command, { cwd, shell: true, windowsHide: true });
    // Decoded per stream, so a character split across two chunks survives.
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    const keep = (chunk: string): void => {
      output = (output + chunk).slice(-KEEP_CHARS);
    };
    child.stdout?.on('data', keep);
    child.stderr?.on('data', keep);
    const stop = (why: 'timeout' | 'aborted'): void => {
      if (stopped) return;
      stopped = why;
      killed = killTree(child);
    };
    const timer = setTimeout(() => stop('timeout'), INSTALL_TIMEOUT_MS);
    const onAbort = (): void => stop('aborted');
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) onAbort();
    // Settles on whichever comes first. A process that never started may emit
    // 'error' with no 'close', and waiting on 'close' alone would then hang
    // this install, and every later one for the folder behind it, forever.
    let finished = false;
    const finish = (exitCode: number | null): void => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      // The shell can close before taskkill reaches npm under it.
      void killed.then(() => done(exitCode));
    };
    child.on('error', (error) => {
      output += `\n${error.message}`;
      finish(null);
    });
    child.on('close', finish);
  });

  const seconds = Math.round((Date.now() - startedAt) / 1000);
  if (code === 0 && !stopped) {
    logger.info({ cwd, command, seconds }, 'dependencies installed');
    return { ran: true, ok: true, detail: `dependencies installed (${seconds}s)` };
  }

  // A half-written node_modules would read as installed to the next session
  // opened here, which then skips the install and fails its tests instead.
  // rm removes a link itself, never what it points at; async, since a
  // partial install can be thousands of files and this runs on the event loop.
  try {
    await rm(join(cwd, 'node_modules'), { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
  } catch (error) {
    logger.warn({ cwd, code: (error as NodeJS.ErrnoException).code }, 'could not remove a partial node_modules');
  }
  const why =
    stopped === 'timeout'
      ? `timed out after ${INSTALL_TIMEOUT_MS / 60_000} minutes`
      : stopped === 'aborted'
        ? 'cancelled'
        : tail(output) || `exited with code ${code}`;
  logger.warn({ cwd, command, code, stopped, seconds }, 'dependency install failed');
  return { ran: true, ok: false, detail: `${command} failed: ${why}` };
}
