import { describe, it, expect } from 'vitest';
import { execFileSync } from 'child_process';
import { appendFileSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { makeTmpDataDir } from './helpers/tmp-data-dir.js';

/**
 * scripts/install-skill.mjs copies skills/<name>/ into a Claude Code skills
 * folder, so the installed copy cannot silently fall behind the repo's.
 */

const SCRIPT = join(__dirname, '..', 'scripts', 'install-skill.mjs');
const SOURCE = join(__dirname, '..', 'skills', 'claude-remote-sessions', 'SKILL.md');

let dest: string;

function install(): string {
  return execFileSync(process.execPath, [SCRIPT, '--dest', dest], { encoding: 'utf-8' });
}

describe('install-skill', () => {
  it('installs, then reports up to date, then refreshes a drifted copy', () => {
    dest = makeTmpDataDir('skill-dest');
    const installed = join(dest, 'claude-remote-sessions', 'SKILL.md');

    expect(install()).toMatch(/claude-remote-sessions: installed/);
    expect(readFileSync(installed, 'utf-8')).toBe(readFileSync(SOURCE, 'utf-8'));

    expect(install()).toMatch(/claude-remote-sessions: up to date/);

    appendFileSync(installed, '\nlocal drift\n');
    expect(install()).toMatch(/claude-remote-sessions: updated/);
    expect(readFileSync(installed, 'utf-8')).toBe(readFileSync(SOURCE, 'utf-8'));
  });

  it("with no --dest, installs into every account in claude-remote's config", () => {
    const dir = makeTmpDataDir('skill-accounts');
    const config = join(dir, 'config.json');
    const personal = join(dir, 'personal');
    const work = join(dir, 'work');
    writeFileSync(config, JSON.stringify({ accounts: { personal: { configDir: personal }, work: { configDir: work } } }));
    const out = execFileSync(process.execPath, [SCRIPT], { encoding: 'utf-8', env: { ...process.env, CLAUDE_REMOTE_CONFIG: config } });
    expect(out).toContain(join(personal, 'skills', 'claude-remote-sessions'));
    expect(out).toContain(join(work, 'skills', 'claude-remote-sessions'));
    expect(readFileSync(join(work, 'skills', 'claude-remote-sessions', 'SKILL.md'), 'utf-8')).toBe(readFileSync(SOURCE, 'utf-8'));
  });
});
