import { describe, it, expect } from 'vitest';
import { ViewerResync } from '../src/client/viewer-resync.js';

/**
 * The browser's half of `terminal.resized` (viewer-resync.ts): when another viewer resizes the
 * session on screen, this browser re-attaches on its next use, and only then.
 */

const PC = { cols: 268, rows: 50 };
const PHONE = { cols: 48, rows: 30 };

describe('ViewerResync', () => {
  it('re-attaches the session on screen once, on the first use after another size', () => {
    const r = new ViewerResync();
    r.resized('s1', PHONE, 's1', PC);

    expect(r.ptySize('s1')).toEqual(PHONE);
    expect(r.take('s1', true, 12)).toBe('s1');
    expect(r.take('s1', true, 0)).toBeNull();
  });

  it('ignores a resize to our own size, and one for a session not on screen', () => {
    const r = new ViewerResync();
    r.resized('s1', PC, 's1', PC);
    r.resized('s2', PHONE, 's1', PC);

    expect(r.ptySize('s1')).toBeNull();
    expect(r.take('s1', true, 0)).toBeNull();
  });

  it('stays marked when the size comes back to ours: what was drawn meanwhile is still wrong', () => {
    const r = new ViewerResync();
    r.resized('s1', PHONE, 's1', PC);
    r.resized('s1', PC, 's1', PC);

    expect(r.take('s1', true, 0)).toBe('s1');
  });

  it('drops the mark without re-attaching while another attach is in flight', () => {
    const r = new ViewerResync();
    r.resized('s1', PHONE, 's1', PC);

    expect(r.take('s1', false, 0)).toBeNull();
    expect(r.take('s1', true, 0)).toBeNull();
  });

  it('rebuilds the terminal for its own re-attach and hands back the scroll position', () => {
    const r = new ViewerResync();
    r.resized('s1', PHONE, 's1', PC);
    r.take('s1', true, 40);

    expect(r.attached('s1', 's1')).toEqual({ rebuild: true, linesFromBottom: 40 });
    // A duplicate answer afterwards is the old race guard again.
    expect(r.attached('s1', 's1')).toEqual({ rebuild: false, linesFromBottom: 0 });
  });

  it('clears a mark from a resize that raced its own re-attach', () => {
    const r = new ViewerResync();
    r.resized('s1', PHONE, 's1', PC);
    r.take('s1', true, 0);
    // The phone resized again while our attach waited for its snapshot.
    r.resized('s1', PHONE, 's1', PC);

    r.attached('s1', 's1');
    expect(r.take('s1', true, 0)).toBeNull();
  });

  it('clears the mark when the session is attached afresh after switching away and back', () => {
    const r = new ViewerResync();
    r.resized('s1', PHONE, 's1', PC);

    expect(r.attached('s1', 's2')).toEqual({ rebuild: true, linesFromBottom: 0 });
    expect(r.take('s1', true, 0)).toBeNull();
  });

  it('forgets everything on reset (the socket dropped)', () => {
    const r = new ViewerResync();
    r.resized('s1', PHONE, 's1', PC);
    r.reset();

    expect(r.ptySize('s1')).toBeNull();
    expect(r.take('s1', true, 0)).toBeNull();
  });
});
