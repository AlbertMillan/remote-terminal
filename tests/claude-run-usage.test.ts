import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'events';

/**
 * Usage accounting at the `claude -p` boundary.
 *
 * The property worth pinning is WHEN the sink fires: a run that produced an
 * envelope has already spent its tokens, whether or not runClaude then rejects
 * its output for an error or a denied tool call. Recording after those checks
 * would silently under-report exactly the runs you most want to see the cost
 * of — the failed ones.
 */

const spawned = vi.hoisted(() => ({
  /** stdout the fake `claude` process emits before exiting. */
  stdout: '',
  exitCode: 0,
}));

function fakeChild(): EventEmitter & Record<string, unknown> {
  const child = new EventEmitter() as EventEmitter & Record<string, unknown>;
  const stdout = new EventEmitter();
  const stderr = new EventEmitter();
  child.stdout = stdout;
  child.stderr = stderr;
  child.stdin = { on: () => {}, end: () => {} };
  child.pid = 1234;
  child.kill = () => {};
  setTimeout(() => {
    if (spawned.stdout) stdout.emit('data', spawned.stdout);
    child.emit('close', spawned.exitCode);
  }, 0);
  return child;
}

vi.mock('child_process', () => ({
  spawn: vi.fn(() => fakeChild()),
  // git status, via promisify(execFile). An empty tree keeps the scope-revert
  // a no-op, which is not what this file is about.
  execFile: vi.fn((_cmd: string, _args: string[], _opts: unknown, cb: unknown) => {
    const callback = typeof _opts === 'function' ? _opts : cb;
    (callback as (e: unknown, v: unknown) => void)(null, { stdout: '', stderr: '' });
  }),
}));

const { runClaude, parseClaudeResult, NO_USAGE } = await import(
  '../src/server/agent/claude-run.js'
);

/** A trimmed copy of a real `--output-format json` envelope. */
function envelope(extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    type: 'result',
    subtype: 'success',
    is_error: false,
    result: 'done',
    session_id: 'sess-1',
    total_cost_usd: 0.0287,
    permission_denials: [],
    usage: {
      input_tokens: 9,
      cache_creation_input_tokens: 13004,
      cache_read_input_tokens: 18004,
      output_tokens: 176,
    },
    modelUsage: {
      'claude-opus-5': {
        inputTokens: 9,
        outputTokens: 176,
        cacheReadInputTokens: 18004,
        cacheCreationInputTokens: 13004,
        costUSD: 0.0287,
      },
    },
    ...extra,
  });
}

beforeEach(() => {
  spawned.stdout = envelope();
  spawned.exitCode = 0;
});

describe('parseClaudeResult', () => {
  it('pulls tokens and cost out of the envelope', () => {
    expect(parseClaudeResult(envelope()).usage).toEqual({
      inputTokens: 9,
      outputTokens: 176,
      cacheReadTokens: 18004,
      cacheCreationTokens: 13004,
      costUsd: 0.0287,
    });
  });

  it('reads missing or malformed usage fields as zero, never NaN', () => {
    const usage = parseClaudeResult(
      JSON.stringify({ result: 'x', usage: { input_tokens: 'lots' } })
    ).usage;
    expect(usage).toEqual(NO_USAGE);
    expect(Number.isNaN(usage.inputTokens)).toBe(false);
  });

  it('totals the whole run from modelUsage, not the final turn', () => {
    // Measured against a real two-turn run: the top-level block reports only
    // the last turn's input (19) where modelUsage has the run's 967. Reading
    // the wrong one under-reports input by an order of magnitude.
    const usage = parseClaudeResult(
      JSON.stringify({
        usage: { input_tokens: 19, output_tokens: 825, cache_read_input_tokens: 52957 },
        modelUsage: {
          'claude-haiku-4-5': {
            inputTokens: 967,
            outputTokens: 843,
            cacheReadInputTokens: 52957,
            cacheCreationInputTokens: 12067,
            costUSD: 0.0256,
          },
        },
        total_cost_usd: 0.0256,
      })
    ).usage;
    expect(usage.inputTokens).toBe(967);
    expect(usage.outputTokens).toBe(843);
  });

  it('sums every model a run used', () => {
    const usage = parseClaudeResult(
      JSON.stringify({
        modelUsage: {
          'claude-opus-5': { inputTokens: 100, outputTokens: 10, costUSD: 1 },
          'claude-haiku-4-5': { inputTokens: 20, outputTokens: 5, costUSD: 0.1 },
        },
      })
    ).usage;
    expect(usage.inputTokens).toBe(120);
    expect(usage.outputTokens).toBe(15);
    // No total_cost_usd in this envelope, so the per-model costs stand in.
    expect(usage.costUsd).toBeCloseTo(1.1, 10);
  });

  it('falls back to the top-level usage block when modelUsage is absent', () => {
    const usage = parseClaudeResult(
      JSON.stringify({
        usage: { input_tokens: 7, output_tokens: 8, cache_read_input_tokens: 9 },
        total_cost_usd: 0.5,
      })
    ).usage;
    expect(usage).toEqual({
      inputTokens: 7,
      outputTokens: 8,
      cacheReadTokens: 9,
      cacheCreationTokens: 0,
      costUsd: 0.5,
    });
  });

  it('survives an envelope with no usage at all (older or future CLI)', () => {
    expect(parseClaudeResult('not json').usage).toEqual(NO_USAGE);
    expect(parseClaudeResult(JSON.stringify({ result: 'x' })).usage).toEqual(NO_USAGE);
  });
});

describe('runClaude usage sink', () => {
  it('reports what a successful run consumed', async () => {
    const seen: unknown[] = [];
    await runClaude('C:/wt', 'prompt', ['**'], { onUsage: (u) => seen.push(u) });
    expect(seen).toEqual([
      {
        inputTokens: 9,
        outputTokens: 176,
        cacheReadTokens: 18004,
        cacheCreationTokens: 13004,
        costUsd: 0.0287,
      },
    ]);
  });

  it('still reports usage when the run is rejected as an error', async () => {
    spawned.stdout = envelope({ is_error: true });
    const seen: unknown[] = [];
    await expect(
      runClaude('C:/wt', 'prompt', ['**'], { onUsage: (u) => seen.push(u) })
    ).rejects.toThrow(/rejected/);
    expect(seen).toHaveLength(1);
  });

  it('still reports usage when the run is rejected for a denied tool call', async () => {
    spawned.stdout = envelope({ permission_denials: [{ tool_name: 'Bash' }] });
    const seen: unknown[] = [];
    await expect(
      runClaude('C:/wt', 'prompt', ['**'], { onUsage: (u) => seen.push(u) })
    ).rejects.toThrow(/permissionDenials=1/);
    expect(seen).toHaveLength(1);
  });

  it('does not let a throwing sink fail the run', async () => {
    const result = await runClaude('C:/wt', 'prompt', ['**'], {
      onUsage: () => {
        throw new Error('accounting exploded');
      },
    });
    expect(result.result).toBe('done');
  });

  it('reports nothing when the process dies without an envelope', async () => {
    spawned.stdout = '';
    spawned.exitCode = 1;
    const seen: unknown[] = [];
    await expect(
      runClaude('C:/wt', 'prompt', ['**'], { onUsage: (u) => seen.push(u) })
    ).rejects.toThrow(/exited with code 1/);
    expect(seen).toHaveLength(0);
  });
});
