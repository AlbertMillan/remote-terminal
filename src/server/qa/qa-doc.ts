import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { COMPANION_DIR } from '../projects/project-store.js';

/**
 * The per-project QA contract: a short markdown file describing what
 * "automatically verified" means for that project, and which driver can do it.
 *
 * Projects differ far too much for one built-in notion of QA. A web app is
 * driven through a browser, a Unity project through the editor, a library
 * through its test command, and some things can only be checked by hand. So the
 * project declares it, the user edits and approves it, and the stage reports
 * honestly when the declared driver is not actually reachable.
 */

export type QaDriver = 'commands' | 'playwright' | 'unity' | 'manual';

export interface QaDoc {
  driver: QaDriver;
  /** Commands declared in the QA doc itself (in addition to PROJECT.md verify). */
  commands: string[];
  /** Everything below the frontmatter — the flows, handed to the agent pass. */
  body: string;
  exists: boolean;
}

export function qaDocRelPath(): string {
  return `${COMPANION_DIR}/QA.md`;
}

export function qaDocPathIn(root: string): string {
  return join(root, qaDocRelPath());
}

const DRIVERS: QaDriver[] = ['commands', 'playwright', 'unity', 'manual'];

function normalizeDriver(value: string | undefined): QaDriver {
  const lower = (value || '').trim().toLowerCase();
  return (DRIVERS as string[]).includes(lower) ? (lower as QaDriver) : 'commands';
}

/**
 * Parse a QA doc. Never throws: a hand-edited file with a broken header still
 * yields usable flows, because losing the whole QA contract to a typo would be
 * worse than guessing the driver.
 */
export function parseQaDoc(markdown: string): QaDoc {
  const text = (markdown ?? '').replace(/\r\n/g, '\n');
  const lines = text.split('\n');

  let driver: string | undefined;
  const commands: string[] = [];
  let bodyStart = 0;

  if (lines[0]?.trim() === '---') {
    const end = lines.findIndex((l, i) => i > 0 && l.trim() === '---');
    if (end !== -1) {
      let inCommands = false;
      for (const line of lines.slice(1, end)) {
        const item = line.match(/^\s+-\s+(.*)$/);
        if (item && inCommands) {
          commands.push(item[1].trim());
          continue;
        }
        const pair = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
        if (!pair) continue;
        inCommands = pair[1] === 'commands';
        if (pair[1] === 'driver') driver = pair[2];
        else if (pair[1] === 'commands' && pair[2].trim()) commands.push(pair[2].trim());
      }
      bodyStart = end + 1;
    }
  }

  return {
    driver: normalizeDriver(driver),
    commands,
    body: lines.slice(bodyStart).join('\n').trim(),
    exists: text.trim().length > 0,
  };
}

export function readQaDoc(root: string): QaDoc | null {
  const path = qaDocPathIn(root);
  if (!existsSync(path)) return null;
  try {
    return parseQaDoc(readFileSync(path, 'utf-8'));
  } catch {
    return null;
  }
}

// --- Driver availability ---------------------------------------------------

export interface DriverAvailability {
  available: boolean;
  /** Why it cannot run — shown verbatim on the board when a check is skipped. */
  reason: string | null;
}

/** True when the project has Playwright wired up in some recognisable way. */
function hasPlaywright(root: string): boolean {
  const configs = [
    'playwright.config.ts',
    'playwright.config.js',
    'playwright.config.mjs',
    'playwright.config.cjs',
  ];
  if (configs.some((c) => existsSync(join(root, c)))) return true;
  return existsSync(join(root, 'node_modules', '@playwright', 'test'));
}

/**
 * Whether the Unity Editor is actually open.
 *
 * Unity QA is driven through the editor's MCP bridge, which only exists while
 * the editor is running — so a background job at 3am simply cannot do it. That
 * has to be reported as "not run", never as "passed".
 */
export type ProcessProbe = (name: string) => boolean;

export function checkDriver(
  driver: QaDriver,
  root: string,
  isProcessRunning?: ProcessProbe
): DriverAvailability {
  switch (driver) {
    case 'commands':
      return { available: true, reason: null };

    case 'playwright':
      return hasPlaywright(root)
        ? { available: true, reason: null }
        : {
            available: false,
            reason:
              'QA declares the playwright driver, but this project has no Playwright config or install.',
          };

    case 'unity': {
      const running = isProcessRunning ? isProcessRunning('Unity') : false;
      return running
        ? { available: true, reason: null }
        : {
            available: false,
            reason:
              'QA declares the unity driver, which needs the Unity Editor open with the MCP bridge running. It is not.',
          };
    }

    case 'manual':
      return {
        available: false,
        reason: 'QA for this project is declared manual — check it yourself before merging.',
      };
  }
}

/**
 * The skeleton the generator is asked to fill in. Kept deliberately short: this
 * is a document the user has to read and approve, and a long one will not get
 * read.
 */
export function qaDocSkeleton(projectName: string, driver: QaDriver): string {
  return `---
driver: ${driver}
commands:
  - <command that proves the build works>
---

# QA — ${projectName}

## Preconditions
- <anything that must be true before the flows below can run>

## Flows
1. <the most important thing a user does>
   expect: <what proves it worked>
`;
}
