import { describe, it, expect } from 'vitest';
import {
  cardDetail,
  countJobs,
  isTerminal,
  selectVisibleJobs,
  type JobSummary,
} from '../src/client/job-overlay.js';
import type { JobStatus } from '../src/client/job-board.js';

/**
 * What the overlay chooses to show, and in what order.
 *
 * The ordering is the feature: a running job is information, a parked one is
 * work that stopped until you act on it. Showing them in arrival order buries
 * the second behind the first, which is exactly the failure this panel exists
 * to fix.
 *
 * Kept as pure functions so they can be tested without a DOM — the vitest
 * environment is 'node', and the alternative is a jsdom dependency bought for
 * two rules.
 */

const MINUTE = 60_000;

function job(id: string, status: JobStatus, updatedMinutesAgo = 0): JobSummary {
  return {
    id,
    projectCwd: `C:\\p\\${id}`,
    projectName: id,
    featureId: null,
    title: `Job ${id}`,
    status,
    stage: 'implement',
    gate: null,
    parkReason: status === 'parked' ? 'gate' : null,
    detail: null,
    stages: [],
    costUsd: 0,
    createdAt: new Date(Date.now() - 10 * MINUTE).toISOString(),
    updatedAt: new Date(Date.now() - updatedMinutesAgo * MINUTE).toISOString(),
  };
}

describe('selectVisibleJobs — ordering', () => {
  const now = Date.now();

  it('puts what is waiting on you above what is merely running', () => {
    const jobs = [
      job('queued-one', 'queued'),
      job('running-one', 'running'),
      job('failed-one', 'failed'),
      job('parked-one', 'parked'),
    ];
    const order = selectVisibleJobs(jobs, new Map([['failed-one', now]]), now).map((j) => j.id);
    expect(order).toEqual(['parked-one', 'failed-one', 'running-one', 'queued-one']);
  });

  it('breaks a tie by most recently updated', () => {
    const jobs = [
      job('old', 'running', 30),
      job('fresh', 'running', 1),
      job('middle', 'running', 10),
    ];
    expect(selectVisibleJobs(jobs, new Map(), now).map((j) => j.id)).toEqual([
      'fresh',
      'middle',
      'old',
    ]);
  });

  it('does not mutate the array it was given', () => {
    const jobs = [job('a', 'running'), job('b', 'parked')];
    const before = jobs.map((j) => j.id);
    selectVisibleJobs(jobs, new Map(), now);
    expect(jobs.map((j) => j.id)).toEqual(before);
  });
});

describe('selectVisibleJobs — expiry', () => {
  const now = Date.now();

  it('keeps a job that finished seconds ago', () => {
    const jobs = [job('done-one', 'done')];
    const seen = new Map([['done-one', now - 5_000]]);
    expect(selectVisibleJobs(jobs, seen, now)).toHaveLength(1);
  });

  it('drops one that has been on screen past the linger window', () => {
    const jobs = [job('done-one', 'done')];
    const seen = new Map([['done-one', now - 90_000]]);
    expect(selectVisibleJobs(jobs, seen, now)).toHaveLength(0);
  });

  it('counts from when it was first seen finished, not from updatedAt', () => {
    // Finished an hour ago by the server's clock, but this client only just
    // connected and saw it — it still gets its minute on screen.
    const jobs = [job('done-one', 'done', 60)];
    const seen = new Map([['done-one', now - 1_000]]);
    expect(selectVisibleJobs(jobs, seen, now)).toHaveLength(1);
  });

  it('treats a finished job it has never seen before as finishing now', () => {
    const jobs = [job('done-one', 'done', 1)];
    expect(selectVisibleJobs(jobs, new Map(), now)).toHaveLength(1);
  });

  it('never expires a live job, however long it has been parked', () => {
    const jobs = [job('parked-one', 'parked', 60 * 24 * 30)];
    expect(selectVisibleJobs(jobs, new Map(), now)).toHaveLength(1);
  });

  it('expires failed and cancelled jobs, not just done ones', () => {
    const jobs = [job('f', 'failed'), job('c', 'cancelled')];
    const seen = new Map([
      ['f', now - 90_000],
      ['c', now - 90_000],
    ]);
    expect(selectVisibleJobs(jobs, seen, now)).toHaveLength(0);
  });
});

describe('isTerminal', () => {
  it('treats cancelled as finished — it is not coming back on its own', () => {
    expect(isTerminal('cancelled')).toBe(true);
    expect(isTerminal('done')).toBe(true);
    expect(isTerminal('failed')).toBe(true);
  });

  it('treats a parked job as live: it is waiting on you, not over', () => {
    expect(isTerminal('parked')).toBe(false);
    expect(isTerminal('queued')).toBe(false);
    expect(isTerminal('running')).toBe(false);
  });
});

describe('countJobs', () => {
  it('counts queued with running, and parked as waiting', () => {
    const jobs = [
      job('a', 'queued'),
      job('b', 'running'),
      job('c', 'parked'),
      job('d', 'failed'),
      job('e', 'done'),
    ];
    expect(countJobs(jobs)).toEqual({ running: 2, waiting: 1, failed: 1 });
  });

  it('is all zeroes for an empty panel', () => {
    expect(countJobs([])).toEqual({ running: 0, waiting: 0, failed: 0 });
  });
});

describe('cardDetail — what a parked card says', () => {
  function parked(detail: string | null): JobSummary {
    return { ...job('p', 'parked'), parkReason: 'question', detail };
  }

  it('leads with the question, not the paragraph explaining it', () => {
    const detail =
      '- **BOE ingestion geography: province-wide or pilot-municipality-only?** ' +
      'BOE filters by province only, so a municipality filter means fetching the ' +
      'province and discarding most of it. (a) province-wide (b) municipality. ' +
      'Recommends (b).';
    expect(cardDetail(parked(detail))).toBe(
      'BOE ingestion geography: province-wide or pilot-municipality-only?'
    );
  });

  it('strips emphasis marks when there is no question to find', () => {
    expect(cardDetail(parked('qa **failed**: 2 of 5 checks'))).toBe('qa failed: 2 of 5 checks');
  });

  it('leaves underscores alone — they are identifiers far more often than emphasis', () => {
    expect(cardDetail(parked('MAX_HISTORICAL_DAYS is unset'))).toContain('MAX_HISTORICAL_DAYS');
  });

  it('is null when there is nothing to say', () => {
    expect(cardDetail(parked(null))).toBeNull();
  });

  it('does not hunt for a question on a job parked at a gate', () => {
    const gate = { ...job('g', 'parked'), parkReason: 'gate', detail: '6 findings — 2 critical' };
    expect(cardDetail(gate)).toBe('6 findings — 2 critical');
  });
});
