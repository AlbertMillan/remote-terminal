import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { existsSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { makeTmpDataDir } from './helpers/tmp-data-dir.js';
import { launchEnv, main } from '../scripts/move-session-transcripts.mjs';

/**
 * scripts/move-session-transcripts.mjs (f-ilxxdj): a `personal` row's transcript
 * moves out of the work folder after a canary resume, with its subagent folder and
 * its `usage_files` rows; a failed canary moves it back and stops.
 */

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const PERSONAL_UUID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const SLUG = 'C--proj';

function setup(label: string) {
  const home = makeTmpDataDir(label);
  const work = join(home, '.claude', 'projects', SLUG);
  const personal = join(home, '.claude-personal');
  mkdirSync(join(work, A, 'subagents'), { recursive: true });
  mkdirSync(personal, { recursive: true });
  writeFileSync(join(work, `${A}.jsonl`), '{"cwd":"x"}\n');
  writeFileSync(join(work, A, 'subagents', 'agent-1.jsonl'), '{}\n');
  writeFileSync(join(work, `${B}.jsonl`), '{"cwd":"x"}\n{"more":1}\n');
  writeFileSync(join(personal, '.claude.json'), JSON.stringify({ oauthAccount: { accountUuid: PERSONAL_UUID } }));
  const configPath = join(home, 'config.json');
  writeFileSync(
    configPath,
    JSON.stringify({
      accounts: {
        personal: { configDir: join(home, '.claude-personal'), accountUuid: PERSONAL_UUID },
        work: { configDir: join(home, '.claude'), organizationUuid: 'org' },
      },
    })
  );
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE sessions (account TEXT, claude_session_id TEXT, cwd TEXT);
    CREATE TABLE usage_files (path TEXT PRIMARY KEY, offset INTEGER, project_cwd TEXT);
  `);
  const insert = db.prepare('INSERT INTO sessions VALUES (?, ?, ?)');
  insert.run('personal', A, home);
  insert.run('personal', B, home);
  insert.run('work', '33333333-3333-4333-8333-333333333333', home);
  db.prepare('INSERT INTO usage_files VALUES (?, 42, ?)').run(join(work, `${A}.jsonl`), 'C:\\proj');
  db.prepare('INSERT INTO usage_files VALUES (?, 7, ?)').run(join(work, A, 'subagents', 'agent-1.jsonl'), 'C:\\proj');
  return { home, work, toDir: join(personal, 'projects', SLUG), configPath, db };
}

describe('move-session-transcripts.mjs', () => {
  it('moves every personal row after a canary resume, with subagents and usage rows', () => {
    const { home, work, toDir, configPath, db } = setup('move-ok');
    const canaries: string[] = [];
    const code = main([], { home, configPath, db, log: () => {}, resumeCanary: ({ id }: { id: string }) => (canaries.push(id), { ok: true, detail: 'OK' }) });
    expect(code).toBe(0);
    // The smaller transcript is the canary.
    expect(canaries).toEqual([A]);
    for (const id of [A, B]) {
      expect(existsSync(join(toDir, `${id}.jsonl`))).toBe(true);
      expect(existsSync(join(work, `${id}.jsonl`))).toBe(false);
    }
    expect(existsSync(join(toDir, A, 'subagents', 'agent-1.jsonl'))).toBe(true);
    const paths = db.prepare('SELECT path, offset FROM usage_files ORDER BY offset').all();
    expect(paths).toEqual([
      { path: join(toDir, A, 'subagents', 'agent-1.jsonl'), offset: 7 },
      { path: join(toDir, `${A}.jsonl`), offset: 42 },
    ]);
    // A second run has nothing left to move.
    const log: string[] = [];
    expect(main([], { home, configPath, db, log: (s: string) => log.push(s), resumeCanary: () => ({ ok: true, detail: '' }) })).toBe(0);
    expect(log.every((l) => l.includes('already there'))).toBe(true);
  });

  it('moves the canary back and nothing else when its resume fails', () => {
    const { home, work, toDir, configPath, db } = setup('move-canary-fail');
    const log: string[] = [];
    const code = main([], { home, configPath, db, log: (s: string) => log.push(s), resumeCanary: () => ({ ok: false, detail: 'invalid signature' }) });
    expect(code).toBe(1);
    expect(existsSync(join(work, `${A}.jsonl`))).toBe(true);
    expect(existsSync(join(work, A, 'subagents', 'agent-1.jsonl'))).toBe(true);
    expect(existsSync(join(toDir, `${A}.jsonl`))).toBe(false);
    expect(existsSync(join(work, `${B}.jsonl`))).toBe(true);
    expect(log.at(-1)).toMatch(/canary failed.*invalid signature/);
  });

  it('refuses when the personal folder holds org-pushed settings, and moves nothing on --dry-run', () => {
    const { home, work, configPath, db } = setup('move-refused');
    const canary = () => ({ ok: true, detail: '' });
    expect(main(['--dry-run'], { home, configPath, db, log: () => {}, resumeCanary: canary })).toBe(0);
    expect(existsSync(join(work, `${A}.jsonl`))).toBe(true);
    writeFileSync(join(home, '.claude-personal', 'remote-settings.json'), '{}');
    const log: string[] = [];
    expect(main([], { home, configPath, db, log: (s: string) => log.push(s), resumeCanary: canary })).toBe(1);
    expect(log.at(-1)).toMatch(/org-pushed settings/);
    expect(existsSync(join(work, `${A}.jsonl`))).toBe(true);
  });

  it('launches with the account folder and without telemetry or auth overrides', () => {
    const env = launchEnv(
      { PATH: 'p', CLAUDE_CODE_ENABLE_TELEMETRY: '1', otel_exporter_otlp_endpoint: 'x', ANTHROPIC_API_KEY: 'k', CLAUDE_CONFIG_DIR: 'old' },
      'C:\\h\\.claude-personal',
      'C:\\h'
    );
    expect(env).toEqual({ PATH: 'p', CLAUDE_CONFIG_DIR: 'C:\\h\\.claude-personal' });
  });
});
