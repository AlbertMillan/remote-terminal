// @vitest-environment happy-dom
import { describe, it, expect } from 'vitest';
import { ProjectWorkspace, type WorkspaceProject } from '../src/client/project-workspace.js';
import { formatUsageCost, type StageUsage } from '../src/client/job-board.js';

/**
 * The project's spend chip in its header.
 *
 * It counts everything the project spent — sessions and background runs, not
 * just the pipeline — which is why it sits in the header and says so in its
 * tooltip. And it must never read "$0.00" for spend it merely cannot price.
 */

const ZERO: StageUsage = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheCreationTokens: 0,
  costUsd: 0,
  runCount: 0,
};
const spent = (costUsd: number, extra: Partial<StageUsage> = {}): StageUsage => ({
  ...ZERO,
  outputTokens: 1000,
  costUsd,
  ...extra,
});

function project(usage: WorkspaceProject['usage']): WorkspaceProject {
  return {
    cwd: 'C:\\p\\demo',
    name: 'demo',
    nested: [],
    registered: true,
    vcs: { kind: 'git', canDispatch: true, needsInit: false, canPush: false, note: null },
    hasDoc: true,
    revision: 'r1',
    docPath: 'PROJECT.md',
    status: null,
    verify: [],
    tracks: [],
    orphanBranches: [],
    counts: { total: 0, done: 0, in_progress: 0, pending: 0, blocked: 0 },
    lastActivity: null,
    lastModified: null,
    transcriptCount: 0,
    usage,
  };
}

function chip(usage: WorkspaceProject['usage']): HTMLElement | null {
  const ws = new ProjectWorkspace(() => {}, () => {}, () => {}, () => {});
  document.body.innerHTML = `<div id="badges">${ws.renderHeaderBadges(project(usage))}</div>`;
  return document.querySelector<HTMLElement>('.jb-usage.project');
}

describe('project spend chip', () => {
  it('shows the total, with who spent it in the tooltip', () => {
    const el = chip({ total: spent(12.5), pipeline: spent(2), sessions: spent(10), background: spent(0.5) });
    expect(el?.textContent).toBe('$12.50');
    expect(el?.title).toContain('est. $12.50 at API list price');
    expect(el?.title).toContain('pipeline $2.00');
    expect(el?.title).toContain('sessions $10.00');
    expect(el?.title).toContain('background');
  });

  it('is absent before the ledger has read anything for the project', () => {
    expect(chip(null)).toBeNull();
    expect(chip(undefined)).toBeNull();
  });

  it('reads "—", not "$0.00", when every token is from a model it cannot price', () => {
    const unknown = spent(0, { unpriced: true });
    const el = chip({ total: unknown, pipeline: ZERO, sessions: unknown, background: ZERO });
    expect(el?.textContent).toBe('—');
    expect(el?.title).toContain('no known price');
  });
});

describe('formatUsageCost', () => {
  it('keeps a real figure when only some tokens are unpriced', () => {
    expect(formatUsageCost(spent(1.5, { unpriced: true }))).toBe('$1.50');
  });

  it('formats priced spend as the plain cost', () => {
    expect(formatUsageCost(spent(0.0004))).toBe('<$0.01');
  });
});
