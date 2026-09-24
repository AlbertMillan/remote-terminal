import type { FastifyInstance } from 'fastify';
import { existsSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { getSnapshot, recordReading } from './plan-limits.js';

/**
 * The status line script, found by walking up from this module: it sits at
 * `<repo>/scripts/statusline.mjs`, and this file runs from `src/server/usage`
 * under tsx but from `dist/server` once bundled. Null if it cannot be found.
 */
function findStatuslineScript(): string | null {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 6; i++) {
    const candidate = join(dir, 'scripts', 'statusline.mjs');
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/**
 * The `statusLine.command` to put in ~/.claude/settings.json. Forward slashes:
 * Claude Code runs the command through bash on Windows too, where a backslash
 * path is an escape sequence waiting to happen.
 */
export function statuslineCommand(): string | null {
  const script = findStatuslineScript();
  return script ? `node "${script.replace(/\\/g, '/')}"` : null;
}

/** A status line payload is a few KB; anything far larger is not one. */
const BODY_LIMIT = 64 * 1024;

export function registerPlanUsageRoutes(app: FastifyInstance): void {
  // The relay: scripts/statusline.mjs posts every status line payload here. A
  // payload with no usable limits is normal (before a session's first
  // response, or on a plan without limits), so it is accepted and ignored.
  app.post('/api/plan-usage', { bodyLimit: BODY_LIMIT }, async (request) => {
    return { stored: recordReading(request.body) };
  });

  app.get('/api/plan-usage', async () => {
    return { snapshot: getSnapshot(), setup: { command: statuslineCommand() } };
  });
}
