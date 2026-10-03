// @vitest-environment happy-dom
import { describe, it, expect } from 'vitest';
import { landConfirmText } from '../src/client/project-workspace.js';

describe('landConfirmText', () => {
  it('says nothing about sessions when none are open', () => {
    expect(landConfirmText('Alpha', 0)).toBe(
      'Land "Alpha"? Its branch is merged, its worktree removed, and the project rebuilt.'
    );
  });

  it('names the sessions Land will close, singular and plural', () => {
    expect(landConfirmText('Alpha', 1)).toMatch(/ 1 open session in its worktree will be closed\.$/);
    expect(landConfirmText('Alpha', 3)).toMatch(/ 3 open sessions in its worktree will be closed\.$/);
  });
});
