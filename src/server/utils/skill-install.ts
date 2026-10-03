import { execFile } from 'child_process';
import { existsSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { createLogger } from './logger.js';

const logger = createLogger('skill-install');

/** The checkout this server runs from: dist/server/ or src/server/utils/ → repo root. */
export function serverCheckoutRoot(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  // Bundled: <root>/dist/server/index.js. Unbundled (tsx): <root>/src/server/utils/.
  for (const up of [['..', '..'], ['..', '..', '..']]) {
    const root = join(here, ...up);
    if (existsSync(join(root, 'scripts', 'install-skill.mjs'))) return root;
  }
  return join(here, '..', '..');
}

/**
 * Refresh the repo's skills in ~/.claude/skills at boot, from the checkout this server
 * runs from. The skill is how an agent learns `cr-session start` / `land` exist; it was
 * left uninstalled because installing was a manual step to repeat after every change.
 * Landed skill changes reach the user on the next restart.
 *
 * Skipped for an isolated boot (CLAUDE_REMOTE_CONFIG): that usually runs a worktree's
 * build, and would install a skill that hasn't landed. Never blocks or fails startup.
 */
export function installSkillsAtBoot(
  opts: { root?: string; dest?: string; env?: NodeJS.ProcessEnv } = {}
): Promise<'skipped' | 'ran' | 'failed'> {
  const env = opts.env ?? process.env;
  if (env.CLAUDE_REMOTE_CONFIG) return Promise.resolve('skipped');
  const root = opts.root ?? serverCheckoutRoot();
  const script = join(root, 'scripts', 'install-skill.mjs');
  if (!existsSync(script)) return Promise.resolve('skipped');
  const args = [script, ...(opts.dest ? ['--dest', opts.dest] : [])];
  return new Promise((resolveRun) => {
    execFile(process.execPath, args, { cwd: root, timeout: 30_000 }, (error, stdout, stderr) => {
      if (error) {
        logger.warn({ err: error.message, stderr: stderr.trim() }, 'skills: install at boot failed');
        resolveRun('failed');
        return;
      }
      logger.info({ result: stdout.trim().split(/\r?\n/) }, 'skills: checked at boot');
      resolveRun('ran');
    });
  });
}
