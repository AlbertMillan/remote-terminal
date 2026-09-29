import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import Fastify from 'fastify';

/**
 * Favourites live in the hand-editable projects.json, so the property worth
 * pinning is what a star click must NOT do: overwrite a file it can't parse,
 * or drop anything else the user wrote there.
 */

const dataDir = mkdtempSync(join(tmpdir(), 'cr-favorites-'));
const configPath = join(dataDir, 'config.json');
writeFileSync(configPath, JSON.stringify({ persistence: { dataDir } }));
process.env.CLAUDE_REMOTE_CONFIG = configPath;

const ALPHA = 'C:\\Projects\\alpha';
const BETA = 'C:\\Projects\\beta';
const GONE = 'C:\\Projects\\gone';

// The board is whatever discovery finds on this machine; pin it instead.
const board = vi.hoisted(() => ({ cwds: [] as string[] }));
vi.mock('../src/server/projects/workspace.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/server/projects/workspace.js')>();
  return { ...actual, listBoardCwds: () => board.cwds };
});

const { loadConfig } = await import('../src/server/config.js');
loadConfig();
const { setFavorite, getRegistryPath, RegistryUnreadableError } = await import(
  '../src/server/projects/registry.js'
);
const { registerProjectRoutes } = await import('../src/server/projects/routes.js');
const { favoritesFirst, isLastFavorite } = await import('../src/client/project-workspace.js');

const registryPath = getRegistryPath();
const readRaw = (): Record<string, unknown> => JSON.parse(readFileSync(registryPath, 'utf-8'));

beforeEach(() => {
  rmSync(registryPath, { force: true });
  board.cwds = [ALPHA, BETA];
});

afterAll(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

describe('setFavorite', () => {
  it('creates the file when there is none, and round-trips a star', () => {
    expect(setFavorite(ALPHA, true)).toEqual([ALPHA]);
    expect(readRaw().favorites).toEqual([ALPHA]);
    expect(setFavorite(ALPHA, false)).toEqual([]);
    expect(readRaw().favorites).toEqual([]);
  });

  it('matches by pathKey, so a differently-cased spelling unstars it', () => {
    setFavorite('c:\\projects\\ALPHA', true);
    expect(setFavorite(ALPHA, false)).toEqual([]);
  });

  it('never lists the same project twice', () => {
    setFavorite(ALPHA, true);
    expect(setFavorite('c:/Projects/alpha', true)).toHaveLength(1);
  });

  it('leaves everything else in the file as the user wrote it', () => {
    const hand = {
      projects: [{ cwd: ALPHA, name: 'Alpha', note: 'kept' }, { junk: true }],
      splitChildren: ['C:\\ideas'],
      myOwnKey: { anything: 1 },
    };
    writeFileSync(registryPath, JSON.stringify(hand));
    setFavorite(BETA, true);
    expect(readRaw()).toEqual({ ...hand, favorites: [BETA] });
  });

  it('refuses to rewrite a file it cannot parse', () => {
    const broken = '{ "projects": [ { "cwd": "C:\\\\x" }, ] }';
    writeFileSync(registryPath, broken);
    expect(() => setFavorite(ALPHA, true)).toThrow(RegistryUnreadableError);
    expect(readFileSync(registryPath, 'utf-8')).toBe(broken);
  });

  it('refuses JSON that is not an object', () => {
    writeFileSync(registryPath, '[1, 2]');
    expect(() => setFavorite(ALPHA, true)).toThrow(RegistryUnreadableError);
  });

  it('prunes favourites whose project is no longer on the board', () => {
    writeFileSync(registryPath, JSON.stringify({ favorites: [GONE, BETA] }));
    const onBoard = (cwd: string) => cwd !== GONE;
    expect(setFavorite(ALPHA, true, onBoard)).toEqual([BETA, ALPHA]);
  });

  it('leaves no temp file behind', () => {
    setFavorite(ALPHA, true);
    expect(readdirSync(dataDir).filter((f) => f.endsWith('.tmp'))).toEqual([]);
  });
});

describe('POST /api/projects/favorite', () => {
  async function post(body: unknown) {
    const app = Fastify({ logger: false });
    registerProjectRoutes(app);
    const res = await app.inject({ method: 'POST', url: '/api/projects/favorite', payload: body as object });
    await app.close();
    return res;
  }

  it('stars a project on the board, under the board spelling', async () => {
    const res = await post({ cwd: 'c:\\projects\\alpha', favorite: true });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ cwd: ALPHA, favorite: true, favorites: [ALPHA] });
  });

  it('rejects a non-boolean favorite', async () => {
    expect((await post({ cwd: ALPHA, favorite: 'yes' })).statusCode).toBe(400);
    expect((await post({ favorite: true })).statusCode).toBe(400);
    expect(existsSync(registryPath)).toBe(false);
  });

  it('refuses a directory that is not on the board', async () => {
    const res = await post({ cwd: 'C:\\Windows', favorite: true });
    expect(res.statusCode).toBe(404);
    expect(existsSync(registryPath)).toBe(false);
  });

  it('answers 409 and keeps the file when projects.json is malformed', async () => {
    writeFileSync(registryPath, '{ nope');
    const res = await post({ cwd: ALPHA, favorite: true });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toMatch(/not valid JSON/);
    expect(readFileSync(registryPath, 'utf-8')).toBe('{ nope');
  });
});

describe('sidebar ordering', () => {
  const row = (name: string, favorite: boolean) => ({ name, favorite });

  it('puts favourites first and keeps recency order within each group', () => {
    const ordered = favoritesFirst([row('a', false), row('b', true), row('c', false), row('d', true)]);
    expect(ordered.map((p) => p.name)).toEqual(['b', 'd', 'a', 'c']);
  });

  it('draws the divider only between favourites and a non-empty rest', () => {
    const mixed = favoritesFirst([row('a', false), row('b', true)]);
    expect(mixed.map((_, i) => isLastFavorite(mixed, i))).toEqual([true, false]);

    const allFav = [row('a', true), row('b', true)];
    expect(allFav.map((_, i) => isLastFavorite(allFav, i))).toEqual([false, false]);

    const none = [row('a', false), row('b', false)];
    expect(none.map((_, i) => isLastFavorite(none, i))).toEqual([false, false]);
  });
});
