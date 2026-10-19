import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterAll, onTestFinished } from 'vitest';

/**
 * A fresh temp folder to stand in for `persistence.dataDir`, so a test never
 * writes into the real ~/.claude-remote. It removes itself: when the calling
 * test finishes, or after the file's tests when made outside one.
 *
 * vi.mock factories are hoisted above the imports, so a test whose config mock
 * needs the folder creates it inside `vi.hoisted`:
 *
 *   const { dataDir } = await vi.hoisted(async () => {
 *     const { makeTmpDataDir } = await import('./helpers/tmp-data-dir.js');
 *     return { dataDir: makeTmpDataDir('my-suite') };
 *   });
 *
 * Made at file level, its afterAll is registered before the suite's own, so it
 * runs after them (hooks run as a stack): a suite's closeDatabase() comes
 * first, or Windows refuses to delete the open database (EBUSY).
 */
export function makeTmpDataDir(label: string): string {
  const dir = mkdtempSync(join(tmpdir(), `cr-${label}-`));
  const remove = () => rmSync(dir, { recursive: true, force: true });
  try {
    onTestFinished(remove);
  } catch {
    // Not inside a test: onTestFinished throws there.
    afterAll(remove);
  }
  return dir;
}
