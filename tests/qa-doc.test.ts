import { describe, it, expect } from 'vitest';
import { parseQaDoc, checkDriver, qaDocRelPath } from '../src/server/qa/qa-doc.js';

const DOC = [
  '---',
  'driver: playwright',
  'commands:',
  '  - npm test',
  '  - npm run lint',
  '---',
  '',
  '# QA — demo',
  '',
  '## Flows',
  '1. Open the board',
  '   expect: projects listed',
  '',
].join('\n');

describe('parseQaDoc', () => {
  it('reads the driver and commands from frontmatter', () => {
    const doc = parseQaDoc(DOC);
    expect(doc.driver).toBe('playwright');
    expect(doc.commands).toEqual(['npm test', 'npm run lint']);
    expect(doc.exists).toBe(true);
  });

  it('keeps the flows as the body', () => {
    const doc = parseQaDoc(DOC);
    expect(doc.body).toContain('## Flows');
    expect(doc.body).not.toContain('driver:');
  });

  it('defaults to the commands driver when none is declared', () => {
    expect(parseQaDoc('# QA\n\n## Flows\n1. x').driver).toBe('commands');
  });

  it('defaults to commands for an unrecognised driver rather than failing', () => {
    expect(parseQaDoc('---\ndriver: telepathy\n---\n# QA').driver).toBe('commands');
  });

  it('handles an inline single command', () => {
    expect(parseQaDoc('---\ndriver: commands\ncommands: npm test\n---\n').commands).toEqual([
      'npm test',
    ]);
  });

  it('survives an unterminated frontmatter fence', () => {
    const doc = parseQaDoc('---\ndriver: unity\n\n# QA\n1. thing');
    expect(doc.driver).toBe('commands');
    expect(doc.body).toContain('# QA');
  });

  it('handles CRLF and empty input', () => {
    expect(parseQaDoc(DOC.replace(/\n/g, '\r\n')).commands).toHaveLength(2);
    expect(parseQaDoc('').exists).toBe(false);
  });
});

describe('checkDriver', () => {
  const noProcess = () => false;
  const unityRunning = (name: string) => name === 'Unity';

  it('always allows the commands driver', () => {
    expect(checkDriver('commands', 'C:/anywhere').available).toBe(true);
  });

  it('refuses playwright when the project has no Playwright set up', () => {
    const result = checkDriver('playwright', 'C:/definitely/not/a/project');
    expect(result.available).toBe(false);
    expect(result.reason).toMatch(/Playwright/);
  });

  it('refuses unity when the editor is not running, and says why', () => {
    const result = checkDriver('unity', 'C:/proj', noProcess);
    expect(result.available).toBe(false);
    expect(result.reason).toMatch(/Unity Editor/);
  });

  it('allows unity when the editor is running', () => {
    expect(checkDriver('unity', 'C:/proj', unityRunning).available).toBe(true);
  });

  it('treats manual QA as never automatable, with an explanation', () => {
    const result = checkDriver('manual', 'C:/proj');
    expect(result.available).toBe(false);
    expect(result.reason).toMatch(/manual/);
  });
});

describe('qaDocRelPath', () => {
  it('sits beside PROJECT.md in the companion folder', () => {
    expect(qaDocRelPath()).toBe('project/QA.md');
  });
});
