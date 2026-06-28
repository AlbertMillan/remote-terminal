// Cross-platform copy of static client assets into the build output.
// Replaces the Unix-only `cp` that broke on Windows (cmd/PowerShell lack `cp`).
import { copyFileSync, mkdirSync } from 'node:fs';
import { basename, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const destDir = join(root, 'dist', 'client');
const files = [
  join(root, 'src', 'client', 'index.html'),
  join(root, 'src', 'client', 'styles.css'),
];

mkdirSync(destDir, { recursive: true });
for (const src of files) {
  const dest = join(destDir, basename(src));
  copyFileSync(src, dest);
  console.log(`copied ${basename(src)} -> ${dest}`);
}
