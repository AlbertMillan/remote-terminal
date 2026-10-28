import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, existsSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { installSkillsAtBoot, serverCheckoutRoot } from '../src/server/utils/skill-install.js';

const repoRoot = join(__dirname, '..');
const dirs: string[] = [];
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), 'cr-skills-'));
  dirs.push(d);
  return d;
};

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('installSkillsAtBoot', () => {
  it('installs the repo skill into the skills folder, matching the source', async () => {
    const dest = tmp();
    expect(await installSkillsAtBoot({ root: repoRoot, dest, env: {} })).toBe('ran');
    const installed = join(dest, 'claude-remote-sessions', 'SKILL.md');
    expect(existsSync(installed)).toBe(true);
    expect(readFileSync(installed, 'utf8')).toBe(
      readFileSync(join(repoRoot, 'skills', 'claude-remote-sessions', 'SKILL.md'), 'utf8')
    );
  });

  it("installs into every account's skills folder", async () => {
    const personal = tmp();
    const work = tmp();
    expect(await installSkillsAtBoot({ root: repoRoot, dest: [personal, work], env: {} })).toBe('ran');
    for (const dest of [personal, work]) {
      expect(existsSync(join(dest, 'claude-remote-sessions', 'SKILL.md'))).toBe(true);
    }
  });

  it('skips an isolated boot, which usually runs an unlanded worktree build', async () => {
    const dest = tmp();
    const result = await installSkillsAtBoot({ root: repoRoot, dest, env: { CLAUDE_REMOTE_CONFIG: 'x.json' } });
    expect(result).toBe('skipped');
    expect(existsSync(join(dest, 'claude-remote-sessions'))).toBe(false);
  });

  it('skips a root with no install script instead of failing the boot', async () => {
    expect(await installSkillsAtBoot({ root: tmp(), dest: tmp(), env: {} })).toBe('skipped');
  });

  it('finds the checkout root from the source tree', () => {
    expect(existsSync(join(serverCheckoutRoot(), 'scripts', 'install-skill.mjs'))).toBe(true);
  });
});
