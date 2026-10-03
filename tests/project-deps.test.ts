import { describe, it, expect, afterAll, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { installCommandFor, installDependencies, isInstalling, needsInstall } from '../src/server/projects/project-deps.js';

// Runs real npm, whose start-up alone is a second or two on Windows.
vi.setConfig({ testTimeout: 60_000 });

/** A worktree's own dependency install, against real npm in throwaway projects. */

const dirs: string[] = [];

function projectWith(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'cr-deps-'));
  dirs.push(dir);
  for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, name), content);
  return dir;
}

afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

describe('installCommandFor', () => {
  it('maps each lockfile to its frozen install', () => {
    expect(installCommandFor(projectWith({ 'package-lock.json': '{}' }))).toBe(
      'npm ci --prefer-offline --no-audit --no-fund'
    );
    expect(installCommandFor(projectWith({ 'pnpm-lock.yaml': '' }))).toBe(
      'pnpm install --frozen-lockfile --prefer-offline'
    );
    expect(installCommandFor(projectWith({ 'yarn.lock': '' }))).toBe(
      'yarn install --frozen-lockfile --prefer-offline'
    );
  });

  it('gives null with no lockfile, even with a package.json', () => {
    expect(installCommandFor(projectWith({}))).toBeNull();
    expect(installCommandFor(projectWith({ 'package.json': '{"name":"x"}' }))).toBeNull();
  });
});

describe('needsInstall', () => {
  it('is true only for a locked project with no node_modules', () => {
    const locked = projectWith({ 'package-lock.json': '{}' });
    expect(needsInstall(locked)).toBe(true);
    mkdirSync(join(locked, 'node_modules'));
    expect(needsInstall(locked)).toBe(false);
    expect(needsInstall(projectWith({}))).toBe(false);
  });
});

describe('installDependencies', () => {
  it('runs nothing for a project with no lockfile', async () => {
    expect(await installDependencies(projectWith({}))).toMatchObject({ ran: false, ok: true });
  });

  it('reports a failed install with the command and its output, leaving no node_modules', async () => {
    const cwd = projectWith({
      'package.json': '{"name":"broken","version":"1.0.0"}',
      'package-lock.json': '{ not json',
    });
    const result = await installDependencies(cwd);
    expect(result.ran).toBe(true);
    expect(result.ok).toBe(false);
    expect(result.detail).toMatch(/^npm ci --prefer-offline --no-audit --no-fund failed: /);
    expect(result.detail.length).toBeGreaterThan('npm ci --prefer-offline --no-audit --no-fund failed: '.length);
    expect(existsSync(join(cwd, 'node_modules'))).toBe(false);
  });

  it('shares one install between concurrent callers for the same folder', () => {
    const cwd = projectWith({
      'package.json': '{"name":"broken","version":"1.0.0"}',
      'package-lock.json': '{ not json',
    });
    const first = installDependencies(cwd);
    expect(installDependencies(cwd)).toBe(first);
    // However the path is spelled: Land and Delete check it by the row's path.
    expect(isInstalling(cwd.toUpperCase().replace(/\\/g, '/'))).toBe(true);
    return first.then(() => expect(isInstalling(cwd)).toBe(false));
  });

  it('kills the install when aborted', async () => {
    const cwd = projectWith({
      'package.json': '{"name":"broken","version":"1.0.0"}',
      'package-lock.json': '{ not json',
    });
    const controller = new AbortController();
    controller.abort();
    const result = await installDependencies(cwd, controller.signal);
    expect(result).toMatchObject({ ran: true, ok: false });
    expect(result.detail).toMatch(/cancelled$/);
  });
});
