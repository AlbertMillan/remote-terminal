import { execFileSync } from 'child_process';
import { platform } from 'os';

export type Platform = 'windows' | 'linux' | 'darwin';

export function getPlatform(): Platform {
  const p = platform();
  if (p === 'win32') return 'windows';
  if (p === 'darwin') return 'darwin';
  return 'linux';
}

export function isWindows(): boolean {
  return getPlatform() === 'windows';
}

export function isLinux(): boolean {
  return getPlatform() === 'linux';
}

export function isMac(): boolean {
  return getPlatform() === 'darwin';
}

export function getDefaultShell(): string {
  const p = getPlatform();
  if (p === 'windows') {
    return process.env.COMSPEC || 'powershell.exe';
  }
  return process.env.SHELL || '/bin/bash';
}

export function getShellArgs(): string[] {
  const p = getPlatform();
  if (p === 'windows') {
    const shell = getDefaultShell().toLowerCase();
    if (shell.includes('powershell') || shell.includes('pwsh')) {
      return ['-NoLogo'];
    }
    return [];
  }
  return ['-l']; // Login shell on Unix
}

/**
 * Whether a process whose name starts with `name` is currently running.
 *
 * Used by the QA stage to tell "the Unity Editor is open so its bridge can be
 * driven" from "it is not, so this check genuinely cannot run". Deliberately
 * synchronous and best-effort: a probe that cannot answer returns false, which
 * makes the QA stage skip with a reason rather than claim a pass it has no
 * evidence for.
 */
export function isProcessRunning(name: string): boolean {
  const needle = name.toLowerCase();
  try {
    if (getPlatform() === 'windows') {
      const out = execFileSync('tasklist', ['/FO', 'CSV', '/NH'], {
        encoding: 'utf-8',
        windowsHide: true,
        timeout: 5000,
      });
      return out
        .split('\n')
        .some((line) => line.toLowerCase().replace(/^"/, '').startsWith(needle));
    }
    const out = execFileSync('ps', ['-A', '-o', 'comm='], { encoding: 'utf-8', timeout: 5000 });
    return out.split('\n').some((line) => line.trim().toLowerCase().includes(needle));
  } catch {
    return false;
  }
}
