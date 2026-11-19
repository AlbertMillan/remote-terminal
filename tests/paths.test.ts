import { describe, it, expect } from 'vitest';
import { join, resolve } from 'path';
import { isInside, posixKey, relativeInside, toPosix } from '../src/server/utils/paths.js';

const root = resolve('/cr-paths/project');

describe('relativeInside', () => {
  it('is the empty string for the root itself', () => {
    expect(relativeInside(root, root)).toBe('');
    expect(relativeInside(root, root + '/')).toBe('');
  });

  it('returns the relative path for anything below the root', () => {
    expect(relativeInside(root, join(root, 'project', 'spec.md'))).toBe(join('project', 'spec.md'));
  });

  it('refuses a parent, a sibling and a climb back out', () => {
    expect(relativeInside(root, resolve(root, '..'))).toBeNull();
    expect(relativeInside(root, resolve(root, '..', 'project-other', 'x'))).toBeNull();
    expect(relativeInside(root, join(root, 'a', '..', '..', 'escape'))).toBeNull();
  });

  it('keeps a name that merely starts with two dots', () => {
    // Every earlier copy used startsWith('..') and refused these.
    expect(relativeInside(root, join(root, '..foo'))).toBe('..foo');
    expect(relativeInside(root, join(root, '...', 'x'))).toBe(join('...', 'x'));
  });

  it.runIf(process.platform === 'win32')('refuses another drive', () => {
    const other = root.toLowerCase().startsWith('c:') ? 'D:\\project' : 'C:\\project';
    expect(relativeInside(root, other)).toBeNull();
  });

  it('resolves relative inputs against the cwd before comparing', () => {
    expect(relativeInside('.', '.')).toBe('');
    expect(relativeInside('.', 'sub/file')).toBe(join('sub', 'file'));
  });
});

describe('isInside', () => {
  it('counts the root and its descendants, nothing else', () => {
    expect(isInside(root, root)).toBe(true);
    expect(isInside(root, join(root, 'a'))).toBe(true);
    expect(isInside(root, join(root, '..foo'))).toBe(true);
    expect(isInside(root, resolve(root, '..', 'b'))).toBe(false);
  });
});

describe('toPosix / posixKey', () => {
  it('turns backslashes into slashes; posixKey also lowercases', () => {
    expect(toPosix('Project\\Specs\\A.md')).toBe('Project/Specs/A.md');
    expect(posixKey('Project\\Specs\\A.md')).toBe('project/specs/a.md');
    expect(posixKey('project/specs/a.md')).toBe('project/specs/a.md');
  });
});
