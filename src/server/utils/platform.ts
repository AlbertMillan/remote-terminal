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
