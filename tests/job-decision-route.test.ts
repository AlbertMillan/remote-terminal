import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

/**
 * GET /api/jobs/:id/decision serves the board's own parse of a parked question
 * (src/client/decision-format.ts), so the Android app renders the same cards and asks for
 * one answer per question without a second parser to drift (docs/android-app.md).
 */

const dataDir = mkdtempSync(join(tmpdir(), 'cr-decision-'));
const configPath = join(dataDir, 'config.json');
writeFileSync(configPath, JSON.stringify({ persistence: { dataDir } }));
process.env.CLAUDE_REMOTE_CONFIG = configPath;

const { loadConfig } = await import('../src/server/config.js');
const { initDatabase, closeDatabase } = await import('../src/server/db/schema.js');
const store = await import('../src/server/jobs/store.js');
const { registerJobRoutes } = await import('../src/server/jobs/routes.js');

let app: FastifyInstance;

beforeAll(async () => {
  loadConfig();
  initDatabase();
  app = Fastify({ logger: false });
  registerJobRoutes(app);
  await app.ready();
});

afterAll(async () => {
  await app.close();
  closeDatabase();
  rmSync(dataDir, { recursive: true, force: true });
});

describe('GET /api/jobs/:id/decision', () => {
  it('splits a parked detail into one card per question', async () => {
    const job = store.createJob({ projectCwd: dataDir, featureId: 'f-1', title: 'A feature' });
    store.updateJob(job.id, {
      status: 'parked',
      parkReason: 'question',
      detail:
        '- Which store should sessions use? (a) SQLite (b) JSON files. Recommends (a): it is already a dependency.\n' +
        '- Should old rows be migrated? (a) yes (b) no. Recommends (b).',
    });
    const res = await app.inject({ method: 'GET', url: `/api/jobs/${job.id}/decision` });
    expect(res.statusCode).toBe(200);
    const { decision } = res.json();
    expect(decision.questionCount).toBe(2);
    expect(decision.cards[0].question).toContain('Which store');
    expect(decision.cards[0].options.map((o: { label: string }) => o.label)).toEqual(['a', 'b']);
  });

  it('is null for a job with nothing to ask, and 404 for an unknown one', async () => {
    const job = store.createJob({ projectCwd: dataDir, featureId: null, title: 'Quiet' });
    expect((await app.inject({ method: 'GET', url: `/api/jobs/${job.id}/decision` })).json()).toEqual({ decision: null });
    expect((await app.inject({ method: 'GET', url: '/api/jobs/nope/decision' })).statusCode).toBe(404);
  });
});
