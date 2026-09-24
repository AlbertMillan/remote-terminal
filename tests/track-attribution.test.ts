import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { execFileSync } from 'child_process';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';

/**
 * Guessing a track's work on main from its sessions' transcripts, and the two
 * things built on the guess: Branch now, and the unticked items in Delete.
 *
 * Transcripts are hand-built JSONL in a fake ~/.claude/projects, shaped like
 * the real ones — which is what the Usage visibility case looked like: one
 * session that appended its track with `cat >> PROJECT.md`, then wrote source
 * files in the main checkout.
 */

const FAKE_HOME = mkdtempSync(join(tmpdir(), 'cr-attr-home-'));
vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>();
  return { ...actual, homedir: () => FAKE_HOME };
});

// Counts transcript opens: two concurrent scans of one file must share a
// single read, and whether bytes actually get skipped depends on timing no
// test can pin down — the open count is the deterministic signal.
const opens = vi.hoisted(() => ({ count: 0 }));
vi.mock('fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs/promises')>();
  return {
    ...actual,
    open: (...args: Parameters<typeof actual.open>) => {
      opens.count++;
      return actual.open(...args);
    },
  };
});

// The logger writes under homedir() — the fake one — and holds the file open,
// which is what kept FAKE_HOME from being removed.
vi.mock('../src/server/utils/logger.js', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

const dataDir = mkdtempSync(join(tmpdir(), 'cr-attr-data-'));
const configPath = join(dataDir, 'config.json');
writeFileSync(configPath, JSON.stringify({ persistence: { dataDir } }));
process.env.CLAUDE_REMOTE_CONFIG = configPath;

const { loadConfig } = await import('../src/server/config.js');
const { initDatabase, closeDatabase, getDatabase } = await import('../src/server/db/schema.js');
const { guessTrackWork, clearAttributionCache } = await import('../src/server/projects/track-attribution.js');
const tracks = await import('../src/server/projects/track-branches.js');
const { planTrackDelete, executeTrackDelete } = await import('../src/server/projects/track-delete.js');

const PLAN = `## Track: Usage
- [ ] \`f-u11111\` Step 1

## Track: Other
- [ ] \`f-o22222\` Something else
`;

let repo: string;
let transcripts: string;
const project = () => ({ cwd: repo });

function git(...args: string[]): string {
  return execFileSync('git', args, { cwd: repo, encoding: 'utf-8' }).trim();
}

/** Commit with a committer date: `--since`/`--until` filter on that, not the author date. */
function commitAt(offsetSec: number, message: string, all = true): void {
  execFileSync('git', ['commit', '-q', ...(all ? ['-a'] : []), '-m', message], {
    cwd: repo,
    env: { ...process.env, GIT_COMMITTER_DATE: at(offsetSec), GIT_AUTHOR_DATE: at(offsetSec) },
  });
}

/** File text with CRLF folded: this machine's git checks files out with autocrlf. */
const text = (p: string) => readFileSync(p, 'utf-8').replace(/\r/g, '');

const NOW = Date.now();
const at = (offsetSec: number) => new Date(NOW + offsetSec * 1000).toISOString();

function toolLine(name: string, input: Record<string, unknown>, when = at(0)): string {
  return JSON.stringify({
    type: 'assistant',
    timestamp: when,
    message: { content: [{ type: 'tool_use', id: 'x', name, input }] },
  });
}

function writeTranscript(sessionId: string, lines: string[]): string {
  const path = join(transcripts, `${sessionId}.jsonl`);
  writeFileSync(path, [JSON.stringify({ type: 'user', timestamp: at(-120) }), ...lines].join('\n') + '\n');
  return path;
}

/** The Usage visibility shape: track appended from a shell, then code written on main. */
function usageSession(extra: string[] = []): string {
  return writeTranscript('sess-usage', [
    toolLine('Bash', { command: "cat >> PROJECT.md <<'EOF'\n## Track: Usage\n- [ ] `f-u11111` Step 1\nEOF" }),
    toolLine('Write', { file_path: join(repo, 'src', 'usage', 'pricing.ts'), content: 'x' }),
    toolLine('Edit', { file_path: join(repo, 'src', 'schema.ts'), old_string: 'a', new_string: 'b' }),
    toolLine('Write', { file_path: join(repo, 'project', 'usage.md'), content: 'spec' }),
    ...extra,
  ]);
}

beforeAll(() => {
  loadConfig();
  initDatabase();
});

afterAll(() => {
  closeDatabase();
  rmSync(dataDir, { recursive: true, force: true });
  rmSync(FAKE_HOME, { recursive: true, force: true });
});

beforeEach(() => {
  getDatabase().exec('DELETE FROM track_branches; DELETE FROM jobs;');
  clearAttributionCache();
  repo = mkdtempSync(join(tmpdir(), 'cr-attr-repo-'));
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'Test');
  git('config', 'commit.gpgsign', 'false');
  mkdirSync(join(repo, 'src'));
  writeFileSync(join(repo, 'PROJECT.md'), PLAN);
  writeFileSync(join(repo, 'src', 'schema.ts'), 'a\n');
  writeFileSync(join(repo, 'src', 'other.ts'), 'o\n');
  git('add', '.');
  commitAt(-7200, 'base', false);

  transcripts = join(FAKE_HOME, '.claude', 'projects', resolve(repo).replace(/[^a-zA-Z0-9]/g, '-'));
  mkdirSync(transcripts, { recursive: true });
});

describe('guessTrackWork', () => {
  it('attributes the session that created the track from a shell, and takes its still-dirty files', async () => {
    usageSession();
    mkdirSync(join(repo, 'src', 'usage'));
    writeFileSync(join(repo, 'src', 'usage', 'pricing.ts'), 'x\n');
    writeFileSync(join(repo, 'src', 'schema.ts'), 'b\n');

    const guess = await guessTrackWork(project(), 'Usage');

    expect(guess.sessions).toEqual(['sess-usage']);
    expect(guess.files).toEqual(
      expect.arrayContaining([
        { path: 'src/schema.ts', status: 'modified' },
        { path: 'src/usage/pricing.ts', status: 'untracked' },
      ])
    );
    expect(guess.files).toHaveLength(2); // project/usage.md is planning, never guessed
  });

  it('drops files that were restored since (a rewound checkpoint)', async () => {
    usageSession();
    const guess = await guessTrackWork(project(), 'Usage');
    expect(guess.files).toEqual([]);
  });

  it('does not see an edit made only through a shell', async () => {
    usageSession([toolLine('Bash', { command: 'echo y > src/other.ts' })]);
    writeFileSync(join(repo, 'src', 'other.ts'), 'y\n');
    const guess = await guessTrackWork(project(), 'Usage');
    expect(guess.files.map((f) => f.path)).not.toContain('src/other.ts');
  });

  it('ignores sessions that never touched the track', async () => {
    writeTranscript('sess-other', [
      toolLine('Edit', { file_path: join(repo, 'PROJECT.md'), old_string: 'x', new_string: '- [ ] `f-o22222` Something else' }),
      toolLine('Write', { file_path: join(repo, 'src', 'other.ts'), content: 'z' }),
    ]);
    writeFileSync(join(repo, 'src', 'other.ts'), 'z\n');
    expect((await guessTrackWork(project(), 'Usage')).files).toEqual([]);
    expect((await guessTrackWork(project(), 'Other')).files).toEqual([{ path: 'src/other.ts', status: 'modified' }]);
  });

  it('attributes a session listed in the SESSION-LOG phase group', async () => {
    writeTranscript('sess-logged', [toolLine('Write', { file_path: join(repo, 'src', 'other.ts'), content: 'q' })]);
    writeFileSync(join(repo, 'src', 'other.ts'), 'q\n');
    writeFileSync(
      join(repo, 'SESSION-LOG.md'),
      '# Session Log\n\n<!-- claude-remote-phases\n[\n  { "group": "Usage", "source": "PROJECT.md", "items": [\n' +
        '    { "id": "f-u11111", "title": "Step 1", "status": "pending", "sessionIds": ["sess-logged"] }\n  ]}\n]\n-->\n'
    );
    expect((await guessTrackWork(project(), 'Usage')).sessions).toEqual(['sess-logged']);
  });

  it('guesses commits made in the session’s window that touch a file it wrote', async () => {
    usageSession();
    writeFileSync(join(repo, 'src', 'schema.ts'), 'b\n');
    git('commit', '-q', '-am', 'session commit');
    const sha = git('rev-parse', 'HEAD');
    writeFileSync(join(repo, 'src', 'other.ts'), 'unrelated\n');
    git('commit', '-q', '-am', 'unrelated commit');

    const guess = await guessTrackWork(project(), 'Usage');
    expect(guess.commits).toEqual([{ sha, subject: 'session commit' }]);
  });

  it('gives concurrent callers the whole transcript, however many chunks it spans', async () => {
    // The race needs a CACHED entry with a long unread tail: two scans then
    // share one offset. So scan once, append over two 4 MB read chunks with the
    // line that matters at the very end, and only then scan twice at once —
    // each advancing the shared offset would jump past bytes neither parsed.
    const path = writeTranscript('sess-usage', [
      toolLine('Bash', { command: "cat >> PROJECT.md <<'EOF'\n- [ ] `f-u11111` Step 1\nEOF" }),
    ]);
    await guessTrackWork(project(), 'Usage');

    const padding = JSON.stringify({ type: 'user', timestamp: at(0), note: 'x'.repeat(1000) });
    appendFileSync(
      path,
      [...Array.from({ length: 9000 }, () => padding), toolLine('Write', { file_path: join(repo, 'src', 'tail.ts'), content: 't' })].join('\n') + '\n'
    );
    writeFileSync(join(repo, 'src', 'tail.ts'), 't\n');

    opens.count = 0;
    const [a, b] = await Promise.all([guessTrackWork(project(), 'Usage'), guessTrackWork(project(), 'Usage')]);
    expect(opens.count).toBe(1); // one shared scan, not two racing on one offset
    expect(a.files).toEqual([{ path: 'src/tail.ts', status: 'untracked' }]);
    expect(b.files).toEqual([{ path: 'src/tail.ts', status: 'untracked' }]);
    expect((await guessTrackWork(project(), 'Usage')).files).toHaveLength(1);
  });

  it('forgets a transcript once it is deleted', async () => {
    const path = usageSession();
    writeFileSync(join(repo, 'src', 'schema.ts'), 'b\n');
    expect((await guessTrackWork(project(), 'Usage')).files).toHaveLength(1);
    rmSync(path);
    expect((await guessTrackWork(project(), 'Usage')).sessions).toEqual([]);
  });

  it('reads only what a growing transcript appended', async () => {
    const path = usageSession();
    await guessTrackWork(project(), 'Usage');
    appendFileSync(path, toolLine('Write', { file_path: join(repo, 'src', 'late.ts'), content: 'l' }) + '\n');
    writeFileSync(join(repo, 'src', 'late.ts'), 'l\n');

    const guess = await guessTrackWork(project(), 'Usage');
    expect(guess.files).toEqual([{ path: 'src/late.ts', status: 'untracked' }]);
  });
});

describe('branchNow', () => {
  beforeEach(() => {
    usageSession();
    mkdirSync(join(repo, 'src', 'usage'));
    writeFileSync(join(repo, 'src', 'usage', 'pricing.ts'), 'x\n');
    writeFileSync(join(repo, 'src', 'schema.ts'), 'b\n');
  });

  it('moves the confirmed files into a new track worktree and leaves main clean of them', async () => {
    const { branch, moved } = await tracks.branchNow(project(), 'Usage', ['src/usage/pricing.ts', 'src/schema.ts']);

    expect(moved.sort()).toEqual(['src/schema.ts', 'src/usage/pricing.ts']);
    expect(text(join(branch.worktreePath, 'src', 'schema.ts'))).toBe('b\n');
    expect(existsSync(join(branch.worktreePath, 'src', 'usage', 'pricing.ts'))).toBe(true);
    expect(git('status', '--porcelain')).toBe('');
  });

  it('leaves unconfirmed files on main, and ignores paths it did not guess', async () => {
    writeFileSync(join(repo, 'src', 'other.ts'), 'mine\n');
    await tracks.branchNow(project(), 'Usage', ['src/schema.ts', 'src/other.ts']);

    expect(existsSync(join(repo, 'src', 'usage', 'pricing.ts'))).toBe(true);
    expect(text(join(repo, 'src', 'other.ts'))).toBe('mine\n');
    expect(text(join(repo, 'src', 'schema.ts'))).toBe('a\n');
  });

  it('refuses a track that already has a branch', async () => {
    await tracks.ensureTrackBranch(project(), 'Usage');
    await expect(tracks.branchNow(project(), 'Usage', ['src/schema.ts'])).rejects.toMatchObject({ status: 409 });
  });
});

describe('guesses in Delete track', () => {
  const deps = () => ({
    liveSessions: () => [],
    terminateSession: vi.fn(async () => true),
    cancelJob: vi.fn(async () => undefined),
    discardJob: vi.fn(async () => undefined),
  });

  it('lists guessed files and commits, and touches none unless ticked', async () => {
    usageSession();
    writeFileSync(join(repo, 'src', 'schema.ts'), 'b\n');
    const plan = await planTrackDelete(project(), 'Usage', []);
    expect(plan.guessedFiles).toEqual([{ path: 'src/schema.ts', status: 'modified' }]);

    await executeTrackDelete(project(), 'Usage', { token: plan.token, revert: [], deleteSpecs: [] }, deps());

    expect(readFileSync(join(repo, 'src', 'schema.ts'), 'utf-8')).toBe('b\n');
    expect(readFileSync(join(repo, 'PROJECT.md'), 'utf-8')).not.toContain('Usage');
  });

  it('restores ticked files and reverts ticked commits in the delete commit', async () => {
    usageSession();
    writeFileSync(join(repo, 'src', 'schema.ts'), 'b\n');
    git('commit', '-q', '-am', 'session commit');
    const sha = git('rev-parse', 'HEAD');
    mkdirSync(join(repo, 'src', 'usage'));
    writeFileSync(join(repo, 'src', 'usage', 'pricing.ts'), 'x\n');

    const plan = await planTrackDelete(project(), 'Usage', []);
    expect(plan.guessedCommits.map((c) => c.sha)).toEqual([sha]);
    const result = await executeTrackDelete(
      project(),
      'Usage',
      {
        token: plan.token,
        revert: [],
        deleteSpecs: [],
        restoreFiles: ['src/usage/pricing.ts'],
        revertGuessed: [sha],
      },
      deps()
    );

    expect(result.committed).not.toBeNull();
    expect(text(join(repo, 'src', 'schema.ts'))).toBe('a\n');
    expect(existsSync(join(repo, 'src', 'usage', 'pricing.ts'))).toBe(false);
    expect(git('status', '--porcelain')).toBe('');
  });

  it('puts ticked files back when a revert conflicts', async () => {
    usageSession();
    writeFileSync(join(repo, 'src', 'schema.ts'), 'b\n');
    git('commit', '-q', '-am', 'session commit');
    const sha = git('rev-parse', 'HEAD');
    writeFileSync(join(repo, 'src', 'schema.ts'), 'c\n');
    commitAt(3600, 'later edit, outside the session window');
    mkdirSync(join(repo, 'src', 'usage'));
    writeFileSync(join(repo, 'src', 'usage', 'pricing.ts'), 'keep me\n');

    const plan = await planTrackDelete(project(), 'Usage', []);
    await expect(
      executeTrackDelete(
        project(),
        'Usage',
        { token: plan.token, revert: [], deleteSpecs: [], restoreFiles: ['src/usage/pricing.ts'], revertGuessed: [sha] },
        deps()
      )
    ).rejects.toMatchObject({ status: 409 });

    expect(readFileSync(join(repo, 'src', 'usage', 'pricing.ts'), 'utf-8')).toBe('keep me\n');
    expect(readFileSync(join(repo, 'PROJECT.md'), 'utf-8')).toContain('Usage');
  });
});
