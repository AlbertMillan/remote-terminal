import { describe, it, expect } from 'vitest';
import { join, resolve } from 'path';
import { hookCwdToStore } from '../src/server/utils/paths.js';

/**
 * The claude-session hook reports a cwd after every turn; an old hook sends `$PWD`, which is
 * wherever Claude last `cd`'d. Recording that would move the session into a subfolder, where
 * its file links and Resume stop working.
 */
describe('hookCwdToStore', () => {
  const root = resolve('work', 'home');
  const sub = join(root, 'render', 'out');
  const other = resolve('work', 'other');

  it('ignores case and separator differences on Windows', () => {
    if (process.platform !== 'win32') return;
    expect(hookCwdToStore(root, sub.toUpperCase().replace(/\\/g, '/'))).toBeUndefined();
  });

  it('keeps the stored folder when the report is below it', () => {
    expect(hookCwdToStore(root, sub)).toBeUndefined();
  });

  it('records the same folder, a parent, another folder, or a first one', () => {
    expect(hookCwdToStore(root, root)).toBe(root);
    expect(hookCwdToStore(sub, root)).toBe(root); // repairs a drifted session
    expect(hookCwdToStore(root, other)).toBe(other);
    expect(hookCwdToStore(null, sub)).toBe(sub);
  });

  it('records nothing without a report', () => {
    expect(hookCwdToStore(root, undefined)).toBeUndefined();
  });
});
