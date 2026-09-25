import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { buildCommandFor, buildProject } from '../src/server/projects/project-build.js';

/** The post-Land build, against real `npm run` in throwaway projects. */

const dirs: string[] = [];

function projectWith(pkg: string | null): string {
  const dir = mkdtempSync(join(tmpdir(), 'cr-build-'));
  dirs.push(dir);
  if (pkg !== null) writeFileSync(join(dir, 'package.json'), pkg);
  return dir;
}

afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

describe('buildProject', () => {
  it('runs nothing for a project with no build script', async () => {
    expect(buildCommandFor(projectWith(null))).toBeNull();
    expect(buildCommandFor(projectWith('{ not json'))).toBeNull();
    const result = await buildProject(projectWith(JSON.stringify({ scripts: { test: 'vitest' } })));
    expect(result).toMatchObject({ ran: false, ok: true });
  });

  it('reports a passing build', async () => {
    const cwd = projectWith(JSON.stringify({ scripts: { build: 'node -e "process.exit(0)"' } }));
    expect(await buildProject(cwd)).toMatchObject({ ran: true, ok: true, detail: 'build passed' });
  });

  it('reports a failing build with its output', async () => {
    const cwd = projectWith(
      JSON.stringify({ scripts: { build: 'node -e "console.error(\'boom\'); process.exit(1)"' } })
    );
    const result = await buildProject(cwd);
    expect(result.ran).toBe(true);
    expect(result.ok).toBe(false);
    expect(result.detail).toMatch(/^build failed: .*boom/s);
  });
});
