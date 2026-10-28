import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { claudeProjectSlug, namesPrompt, promptDelivery, PROMPT_GRACE_MS } from '../src/server/agent/prompt-delivery.js';

/**
 * Did a started session's agent get its prompt? Claude writes no transcript
 * until its first message, and our prompt names `<id>/prompt.md`, so the
 * transcripts in the session's folder are the evidence. Real files, in a
 * stand-in home folder.
 */

const ID = '4de307d4-8f1b-4634-b2b9-041a17b8d5e0';
const CWD = 'C:\\Users\\Albert\\.claude-remote\\worktrees\\tracks\\39e42028';
const CREATED = '2026-10-04T16:47:45.785Z';
const T0 = Date.parse(CREATED);

let home: string;
/** The account's projects folder under the stand-in home. */
const projects = () => join(home, '.claude', 'projects');

function transcript(name: string, lines: object[], mtime = new Date(T0 + 5_000)): string {
  const dir = join(home, '.claude', 'projects', claudeProjectSlug(CWD));
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${name}.jsonl`);
  writeFileSync(path, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  utimesSync(path, mtime, mtime);
  return path;
}

const userLine = (content: string) => ({ type: 'user', message: { role: 'user', content } });
const ourPrompt = `Read C:/Users/Albert/.claude-remote/prompts/${ID}/prompt.md and follow it.`;
const session = (claudeSessionId: string | null = null) => ({ id: ID, cwd: CWD, createdAt: CREATED, claudeSessionId });

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'cr-prompt-delivery-'));
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

describe('claudeProjectSlug', () => {
  it('matches the folder Claude Code made for a worktree (every non-alphanumeric is a dash)', () => {
    expect(claudeProjectSlug(CWD)).toBe('C--Users-Albert--claude-remote-worktrees-tracks-39e42028');
  });
});

describe('namesPrompt', () => {
  it('finds the prompt file in a user line, with either slash, JSON-escaped or not', () => {
    expect(namesPrompt(JSON.stringify(userLine(ourPrompt)), ID)).toBe(true);
    expect(namesPrompt(JSON.stringify(userLine(`Read C:\\data\\prompts\\${ID}\\prompt.md`)), ID)).toBe(true);
  });

  it('ignores another session’s prompt, and a non-user line naming ours', () => {
    expect(namesPrompt(JSON.stringify(userLine('Read C:/x/prompts/11111111-1111-4111-8111-111111111111/prompt.md')), ID)).toBe(false);
    expect(namesPrompt(JSON.stringify({ type: 'assistant', message: { content: ourPrompt } }), ID)).toBe(false);
  });
});

describe('promptDelivery', () => {
  it('is received once a transcript in the session’s folder starts with the prompt', () => {
    transcript('aaaa', [{ type: 'summary' }, userLine(ourPrompt)]);
    expect(promptDelivery(session(), T0 + 10_000, projects())).toEqual({ state: 'received' });
  });

  it('is pending inside the grace period with no transcript', () => {
    expect(promptDelivery(session(), T0 + PROMPT_GRACE_MS - 1, projects())).toEqual({ state: 'pending' });
  });

  it('is not-received after it: Claude registered but wrote nothing (the --add-dir bug)', () => {
    const d = promptDelivery(session('402eec0b-675c-4fab-a1fc-deaa35883ba7'), T0 + PROMPT_GRACE_MS, projects());
    expect(d.state).toBe('not-received');
    expect(d.detail).toMatch(/Claude started, but the prompt never reached it/);
  });

  it('names a Claude that never registered differently', () => {
    expect(promptDelivery(session(), T0 + PROMPT_GRACE_MS, projects()).detail).toMatch(/Claude may never have started/);
  });

  it('is not-received when the first message came from elsewhere (a cross-session message)', () => {
    transcript('bbbb', [userLine('Another Claude session sent a message: YOUR TASK …')]);
    expect(promptDelivery(session('bbbb'), T0 + PROMPT_GRACE_MS, projects()).state).toBe('not-received');
  });

  it('ignores a transcript older than the session (an earlier session in the same folder)', () => {
    transcript('cccc', [userLine(ourPrompt)], new Date(T0 - 60_000));
    expect(promptDelivery(session(), T0 + PROMPT_GRACE_MS, projects()).state).toBe('not-received');
  });

  it('finds the registered transcript even outside the computed folder', () => {
    const other = join(home, '.claude', 'projects', 'somewhere-else');
    mkdirSync(other, { recursive: true });
    writeFileSync(join(other, 'dddd.jsonl'), JSON.stringify(userLine(ourPrompt)) + '\n');
    expect(promptDelivery(session('dddd'), T0 + PROMPT_GRACE_MS, projects())).toEqual({ state: 'received' });
  });
});
