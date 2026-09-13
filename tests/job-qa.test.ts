import { describe, it, expect } from 'vitest';
import { parseQaDoc, checkDriver, qaDocRelPath } from '../src/server/jobs/qa-doc.js';
import { rollUp, parseFlowVerdict, type QaCheck } from '../src/server/jobs/stages/qa.js';

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

describe('parseFlowVerdict', () => {
  it('reads the verdict line', () => {
    expect(parseFlowVerdict('blah\nQA RESULT: PASS')).toBe('passed');
    expect(parseFlowVerdict('QA RESULT: FAIL')).toBe('failed');
    expect(parseFlowVerdict('QA RESULT: skip')).toBe('skipped');
  });

  it('returns null when the run never concluded', () => {
    expect(parseFlowVerdict('I ran some things and got bored')).toBeNull();
  });
});

describe('rollUp', () => {
  const check = (status: QaCheck['status'], name = status): QaCheck => ({
    name,
    status,
    detail: null,
  });

  it('passes only when something actually passed and nothing failed', () => {
    expect(rollUp([check('passed'), check('passed')]).outcome).toBe('passed');
  });

  it('fails when any check failed, however many passed', () => {
    expect(rollUp([check('passed'), check('passed'), check('failed')]).outcome).toBe('failed');
  });

  it('reports skipped — never passed — when nothing actually ran', () => {
    // The rule that matters: no evidence is not the same as evidence of success.
    expect(rollUp([check('skipped'), check('skipped')]).outcome).toBe('skipped');
  });

  it('does not let a trivial pass mask a check that never ran', () => {
    // Found by running it: a passing `node --check` alongside a Unity flow that
    // could not run was reporting the whole stage green.
    expect(rollUp([check('passed', 'node --check'), check('skipped', 'unity flows')])).toEqual({
      outcome: 'skipped',
      summary: '1 passed, 1 skipped',
    });
  });

  it('treats no checks at all as skipped', () => {
    expect(rollUp([])).toEqual({ outcome: 'skipped', summary: 'no QA declared' });
  });

  it('summarises the mix', () => {
    expect(rollUp([check('passed'), check('failed'), check('skipped')]).summary).toBe(
      '1 passed, 1 failed, 1 skipped'
    );
  });

  it('a failure alongside a skip still fails', () => {
    expect(rollUp([check('skipped'), check('failed')]).outcome).toBe('failed');
  });
});

describe('qaDocRelPath', () => {
  it('sits beside PROJECT.md in the companion folder', () => {
    expect(qaDocRelPath()).toBe('project/QA.md');
  });
});
