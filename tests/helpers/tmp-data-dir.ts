import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

/**
 * A fresh temp folder to stand in for `persistence.dataDir`, so a test never
 * writes into the real ~/.claude-remote.
 *
 * vi.mock factories are hoisted above the imports, so a test whose config mock
 * needs the folder creates it inside `vi.hoisted`:
 *
 *   const { dataDir } = await vi.hoisted(async () => {
 *     const { makeTmpDataDir } = await import('./helpers/tmp-data-dir.js');
 *     return { dataDir: makeTmpDataDir('my-suite') };
 *   });
 */
export function makeTmpDataDir(label: string): string {
  return mkdtempSync(join(tmpdir(), `cr-${label}-`));
}
