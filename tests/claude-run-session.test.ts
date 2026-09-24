import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from 'vitest';
import { EventEmitter } from 'events';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

/**
 * How a headless run makes its own transcript attributable.
 *
 * The property worth pinning is ORDER: the run is recorded under its session
 * id before the process exists. A run killed a second in has already written
 * transcript lines, and the ledger can only attribute them if that row is
 * there — so a row written after the spawn (or only on success) would lose
 * exactly the runs whose cost nobody else reports.
 */

const dataDir = mkdtempSync(join(tmpdir(), 'cr-session-'));
const configPath = join(dataDir, 'config.json');
writeFileSync(configPath, JSON.stringify({ persistence: { dataDir } }));
process.env.CLAUDE_REMOTE_CONFIG = configPath;

const spawned = vi.hoisted(() => ({
  stdout: '',
  exitCode: 0 as number | null,
  /** Never exit, so the test can abort a live run. */
  hang: false,
  args: [] as string[][],
  /** agent_runs as seen from inside spawn(), i.e. before the process exists. */
  rowsAtSpawn: [] as unknown[],
  readRows: null as null | (() => unknown[]),
  /** When set, the fake process writes its transcript here, as claude would. */
  transcriptDir: null as string | null,
}));

function fakeChild(): EventEmitter & Record<string, unknown> {
  const child = new EventEmitter() as EventEmitter & Record<string, unknown>;
  const stdout = new EventEmitter();
  child.stdout = stdout;
  child.stderr = new EventEmitter();
  child.stdin = { on: () => {}, end: () => {} };
  child.pid = 1234;
  child.kill = () => child.emit('close', null);
  if (!spawned.hang) {
    setTimeout(() => {
      if (spawned.stdout) stdout.emit('data', spawned.stdout);
      child.emit('close', spawned.exitCode);
    }, 0);
  }
  return child;
}

vi.mock('child_process', () => ({
  spawn: vi.fn((cmd: string, args: string[]) => {
    if (cmd === 'taskkill') return new EventEmitter();
    spawned.args.push(args);
    spawned.rowsAtSpawn = spawned.readRows ? spawned.readRows() : [];
    const id = args[args.indexOf('--session-id') + 1];
    if (spawned.transcriptDir && id) {
      // One response, repeated per content block as the real CLI writes it.
      const entry = JSON.stringify({
        type: 'assistant',
        cwd: 'C:/wt',
        timestamp: new Date().toISOString(),
        message: { id: `msg-${id}`, model: 'claude-opus-5', usage: { input_tokens: 0, output_tokens: 1_000_000 } },
      });
      writeFileSync(join(spawned.transcriptDir, `${id}.jsonl`), `${entry}
${entry}
`);
    }
    return fakeChild();
  }),
  // git status, via promisify(execFile). An empty tree keeps the scope-revert
  // a no-op, which is not what this file is about.
  execFile: vi.fn((_cmd: string, _args: string[], _opts: unknown, cb: unknown) => {
    const callback = typeof _opts === 'function' ? _opts : cb;
    (callback as (e: unknown, v: unknown) => void)(null, { stdout: '', stderr: '' });
  }),
}));

const { loadConfig } = await import('../src/server/config.js');
const { initDatabase, closeDatabase, getDatabase } = await import('../src/server/db/schema.js');
const { runClaude, parseClaudeResult, RunAbortedError } = await import('../src/server/agent/claude-run.js');
const { onRunSettled } = await import('../src/server/agent/run-events.js');
const { ingestUsage } = await import('../src/server/usage/ledger.js');
const { usageByJob, invalidateUsageCache } = await import('../src/server/usage/store.js');

interface RunRow {
  session_id: string;
  kind: string;
  job_id: string | null;
  stage: string | null;
  ended_at: string | null;
}
const rows = () => getDatabase().prepare('SELECT * FROM agent_runs ORDER BY id').all() as RunRow[];
const TAG = { projectCwd: 'C:\\p', kind: 'stage' as const, jobId: 'job-1', stage: 'implement' };
const ENVELOPE = JSON.stringify({ is_error: false, result: 'done', session_id: 'x', permission_denials: [] });

/** The value following a flag in the spawned argv, or undefined. */
function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i === -1 ? undefined : args[i + 1];
}

beforeAll(() => {
  loadConfig();
  initDatabase();
  spawned.readRows = rows;
});

afterAll(() => {
  closeDatabase();
  rmSync(dataDir, { recursive: true, force: true });
});

beforeEach(() => {
  getDatabase().exec('DELETE FROM agent_runs; DELETE FROM usage_messages; DELETE FROM usage_files');
  invalidateUsageCache();
  spawned.transcriptDir = null;
  spawned.stdout = ENVELOPE;
  spawned.exitCode = 0;
  spawned.hang = false;
  spawned.args = [];
});

describe('naming the session', () => {
  it('starts a new session under an id recorded before the process exists', async () => {
    await runClaude('C:/wt', 'prompt', ['**'], { tag: TAG });
    const id = flag(spawned.args[0], '--session-id');
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    expect(spawned.rowsAtSpawn).toHaveLength(1);
    expect((spawned.rowsAtSpawn[0] as RunRow).session_id).toBe(id);
    expect(rows()[0]).toMatchObject({ kind: 'stage', job_id: 'job-1', stage: 'implement' });
  });

  it('keeps a resumed session’s id rather than naming a new one', async () => {
    // --resume keeps the id (measured), and the CLI refuses --session-id with it.
    await runClaude('C:/wt', 'prompt', ['**'], { tag: TAG, resumeSessionId: 'asked-1' });
    expect(flag(spawned.args[0], '--resume')).toBe('asked-1');
    expect(spawned.args[0]).not.toContain('--session-id');
    expect(rows()[0].session_id).toBe('asked-1');
  });

  it('records nothing for an untagged run', async () => {
    await runClaude('C:/wt', 'prompt', ['**']);
    expect(rows()).toHaveLength(0);
  });
});

describe('closing the window', () => {
  it('closes it when the run succeeds', async () => {
    await runClaude('C:/wt', 'prompt', ['**'], { tag: TAG });
    expect(rows()[0].ended_at).not.toBeNull();
  });

  it('closes it when the run is rejected', async () => {
    spawned.stdout = JSON.stringify({ is_error: true, result: 'no' });
    await expect(runClaude('C:/wt', 'prompt', ['**'], { tag: TAG })).rejects.toThrow(/rejected/);
    expect(rows()[0].ended_at).not.toBeNull();
  });

  it('closes it when the process dies without an envelope', async () => {
    spawned.stdout = '';
    spawned.exitCode = 1;
    await expect(runClaude('C:/wt', 'prompt', ['**'], { tag: TAG })).rejects.toThrow(/exited with code 1/);
    expect(rows()[0].ended_at).not.toBeNull();
  });

  it('closes it when the run is cancelled mid-flight', async () => {
    spawned.hang = true;
    const controller = new AbortController();
    const pending = runClaude('C:/wt', 'prompt', ['**'], { tag: TAG, signal: controller.signal });
    await vi.waitFor(() => expect(spawned.args).toHaveLength(1));
    // The row exists while the run is live: that is what attributes a killed run.
    expect(rows()[0].ended_at).toBeNull();
    controller.abort();
    await expect(pending).rejects.toBeInstanceOf(RunAbortedError);
    expect(rows()[0].ended_at).not.toBeNull();
  });
});

describe('parseClaudeResult', () => {
  it('no longer reads usage from the envelope', () => {
    // On --resume the envelope reports the whole session's running total, and a
    // killed run prints none — the ledger is the only source.
    expect(parseClaudeResult(ENVELOPE)).toEqual({
      isError: false,
      result: 'done',
      permissionDenials: 0,
      sessionId: 'x',
    });
  });
});

describe('from run to ledger', () => {
  it('puts a tagged run’s transcript on its job and stage, killed or not', async () => {
    const projectsDir = join(dataDir, 'claude-projects');
    spawned.transcriptDir = join(projectsDir, 'C--wt');
    mkdirSync(spawned.transcriptDir, { recursive: true });

    // Killed: the process dies with no envelope, yet its transcript exists.
    spawned.stdout = '';
    spawned.exitCode = 1;
    await expect(runClaude('C:/wt', 'prompt', ['**'], { tag: TAG })).rejects.toThrow(/exited/);

    await ingestUsage({ projectsDir, docProjects: [TAG.projectCwd] });
    const implement = usageByJob(['job-1']).get('job-1')?.stages.get('implement');
    expect(implement?.runCount).toBe(1);
    expect(implement?.outputTokens).toBe(1_000_000); // two lines, one response
    expect(implement?.costUsd).toBeCloseTo(25, 9);
  });

  it('announces every settled run, which is what schedules the ingest', async () => {
    let settled = 0;
    const off = onRunSettled(() => settled++);
    await runClaude('C:/wt', 'prompt', ['**'], { tag: TAG });
    spawned.stdout = '';
    spawned.exitCode = 1;
    await expect(runClaude('C:/wt', 'prompt', ['**'], { tag: TAG })).rejects.toThrow();
    off();
    expect(settled).toBe(2);
  });
});
