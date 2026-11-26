/**
 * cr-session — start and list prompted sessions, and land or update this
 * session's own track, from inside a claude-remote session
 * (docs/session-orchestration.md).
 * Run by an agent through the Bash tool, via the path the server puts in
 * CLAUDE_REMOTE_CLI:
 *
 *   node "$CLAUDE_REMOTE_CLI" start --track "<name>" [--read-only] [--name <n>] [--mode auto|manual|acceptEdits|plan] [--mcp <server>]... [--account <name>] <<'EOF'
 *   <prompt>
 *   EOF
 *   node "$CLAUDE_REMOTE_CLI" list
 *   node "$CLAUDE_REMOTE_CLI" land [--track "<name>"]
 *   node "$CLAUDE_REMOTE_CLI" update [--track "<name>"]
 *   node "$CLAUDE_REMOTE_CLI" factory add [--track "<name>"] [--from <feature-id>]... <<'EOF'
 *   <free-form work>
 *   EOF
 *   node "$CLAUDE_REMOTE_CLI" factory send [--track "<name>"] [--review track|feature] [--model <feature-id>=<model>]...
 *   node "$CLAUDE_REMOTE_CLI" factory status
 *   node "$CLAUDE_REMOTE_CLI" factory take|return|done [<feature-id>|<track>]
 *
 * `factory` drives the code factory (project/code-factory.md) for this
 * session's project: `add` files loose work into the Inbox (`--from` files it
 * as work discovered on those items, into triage); `send` hands a planned
 * track (this worktree's when none is named) to the factory with optional
 * review granularity and per-feature models; `status` prints its state.
 * `take` stops the factory's agent on a unit and opens a new session in its
 * worktree that continues its conversation (not from a started session);
 * `return` gives the unit this session (or one it started) holds back to the
 * factory, which resumes it from the last commit; `done` sends that work to
 * the factory's summary, reviewer and merge queue — never a direct merge.
 *
 * `land` with no track lands the track whose worktree this session is in, and
 * closes this session to do it. `update` merges the base branch into that
 * track the way the board's Update from main does, keeping its plan, and
 * reinstalls dependencies when the lockfile changed. For both, `--track` names
 * a track a session this one started works in; the server refuses any other.
 *
 * A started session loads no MCP servers unless `start` names them with
 * `--mcp` (repeatable, or comma-separated): the user's whole roster is ~21k
 * tokens of every call (project/lean-started-sessions.md).
 *
 * `start --read-only` adds a read-only peer beside the session this one already
 * started on that track (its builder): at most two, and never before the builder
 * (project/builder-critic-pairs.md). The result carries the peers' notes folder.
 *
 * A started session runs under the caller's Claude login (docs/accounts.md);
 * `--account` naming any other is refused. `list` shows each one's account.
 *
 * The prompt comes on stdin and only there: a `--prompt` argument breaks on
 * quotes and on Windows' command-line length limit, and a heredoc keeps the
 * whole prompt inside the Bash call the user approves. Prints JSON. No
 * dependencies beyond Node's fetch.
 *
 * No `#!` line: it is always run through `node`, and vitest's module runner
 * rejects a hashbang in an imported .mjs, which fails the CLI's whole suite.
 */
import { pathToFileURL } from 'node:url';

const USAGE = `usage:
  node "$CLAUDE_REMOTE_CLI" start --track "<name>" [--read-only] [--name <n>] [--mode auto|manual|acceptEdits|plan] [--mcp <server>]... [--account <name>]  (prompt on stdin)
  node "$CLAUDE_REMOTE_CLI" list
  node "$CLAUDE_REMOTE_CLI" land [--track "<name>"]
  node "$CLAUDE_REMOTE_CLI" update [--track "<name>"]
  node "$CLAUDE_REMOTE_CLI" factory add [--track "<name>"] [--from <feature-id>]...  (the work, free-form, on stdin)
  node "$CLAUDE_REMOTE_CLI" factory send [--track "<name>"] [--review track|feature] [--model <feature-id>=<model>]...
  node "$CLAUDE_REMOTE_CLI" factory status
  node "$CLAUDE_REMOTE_CLI" factory take [<feature-id>|<track>]
  node "$CLAUDE_REMOTE_CLI" factory return [<feature-id>|<track>]
  node "$CLAUDE_REMOTE_CLI" factory done [<feature-id>|<track>]`;

const REVIEWS = ['track', 'feature'];
/** Subcommands that claim or release factory work for a terminal session. */
const CLAIM_SUBS = ['take', 'return', 'done'];

/**
 * `factory <sub> [flags]`. `--from` and `--model` repeat; `--model` takes
 * `<feature-id>=<model>` and collects into a map.
 */
export function parseFactoryArgs(argv) {
  const [sub, ...rest] = argv;
  const flags = {};
  for (let i = 0; i < rest.length; i++) {
    // take|return|done name their unit positionally: a feature id or a track name.
    if (CLAIM_SUBS.includes(sub) && !rest[i].startsWith('--')) {
      if (flags.target !== undefined) throw new UsageError(`factory ${sub} takes one feature id or track name`);
      flags.target = rest[i];
      continue;
    }
    const m = /^--(track|from|review|model)(?:=(.*))?$/.exec(rest[i]);
    if (!m) throw new UsageError(`unknown argument: ${rest[i]}`);
    const value = m[2] !== undefined ? m[2] : rest[++i];
    if (value === undefined) throw new UsageError(`--${m[1]} needs a value`);
    if (m[1] === 'from') {
      flags.from = [...(flags.from ?? []), ...value.split(',').map((v) => v.trim()).filter(Boolean)];
    } else if (m[1] === 'model') {
      const eq = value.indexOf('=');
      if (eq <= 0 || eq === value.length - 1) throw new UsageError('--model takes <feature-id>=<model>');
      flags.models = { ...(flags.models ?? {}), [value.slice(0, eq).trim()]: value.slice(eq + 1).trim() };
    } else {
      flags[m[1]] = value;
    }
  }
  return { sub, flags };
}

/** The request for a `factory` subcommand, or a usage error. */
async function factoryRequest(argv, stdin, headers) {
  const { sub, flags } = parseFactoryArgs(argv);
  const allowed = {
    add: ['track', 'from'],
    send: ['track', 'review', 'models'],
    status: [],
    take: ['target', 'track'],
    return: ['target'],
    done: ['target'],
  }[sub];
  if (!allowed) throw new UsageError(sub ? `unknown factory command: ${sub}` : 'factory needs add, send, status, take, return or done');
  const extra = Object.keys(flags).find((f) => !allowed.includes(f));
  if (extra) throw new UsageError(`factory ${sub} does not take --${extra === 'models' ? 'model' : extra}`);
  if (flags.track !== undefined && !flags.track.trim()) throw new UsageError('--track needs a track name');
  const post = (body) => ({
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (sub === 'status') return { path: '/api/agent/factory/status', request: { method: 'GET', headers } };
  if (CLAIM_SUBS.includes(sub)) {
    const target = flags.target ?? flags.track;
    if (flags.target !== undefined && flags.track !== undefined) throw new UsageError(`factory ${sub} takes a target or --track, not both`);
    return { path: `/api/agent/factory/${sub}`, request: post(target !== undefined ? { target } : {}) };
  }
  if (sub === 'send') {
    if (flags.review !== undefined && !REVIEWS.includes(flags.review)) {
      throw new UsageError(`--review must be one of: ${REVIEWS.join(', ')}`);
    }
    const body = {};
    if (flags.track !== undefined) body.track = flags.track;
    if (flags.review !== undefined) body.review = flags.review;
    if (flags.models !== undefined) body.models = flags.models;
    return { path: '/api/agent/factory/send', request: post(body) };
  }
  // add: the work on stdin, like start's prompt, and checked before any request.
  if (stdin.isTTY) throw new UsageError("the work goes on stdin (a quoted heredoc: <<'EOF' ... EOF), and stdin is a terminal");
  const text = await readAll(stdin);
  if (!text.trim()) throw new UsageError('the work on stdin is empty');
  const body = { text };
  if (flags.track !== undefined) body.track = flags.track;
  if (flags.from !== undefined) body.discoveredFrom = flags.from;
  return { path: '/api/agent/factory/add', request: post(body) };
}

// `auto` is the server's default. `default` is the old name for `manual`, still
// sent by a skill copy installed before the rename; the server maps it.
const MODES = ['auto', 'manual', 'acceptEdits', 'plan'];
const ACCEPTED_MODES = [...MODES, 'default'];

class UsageError extends Error {}

export function parseArgs(argv) {
  const [command, ...rest] = argv;
  const flags = {};
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    // The only flag without a value.
    if (arg === '--read-only') {
      flags.readOnly = true;
      continue;
    }
    const m = /^--(track|name|mode|mcp|account)(?:=(.*))?$/.exec(arg);
    if (!m) throw new UsageError(`unknown argument: ${arg}`);
    const value = m[2] !== undefined ? m[2] : rest[++i];
    if (value === undefined) throw new UsageError(`--${m[1]} needs a value`);
    // The only repeatable flag: `--mcp a --mcp b` and `--mcp a,b` are the same.
    if (m[1] === 'mcp') flags.mcp = [...(flags.mcp ?? []), ...value.split(',').map((v) => v.trim()).filter(Boolean)];
    else flags[m[1]] = value;
  }
  return { command, flags };
}

async function readAll(stream) {
  let text = '';
  stream.setEncoding?.('utf8');
  for await (const chunk of stream) text += chunk;
  return text;
}

/**
 * The CLI, with its world passed in so tests can drive it. Returns the exit
 * code; everything it prints goes through `out`/`err`.
 */
export async function main({
  argv = process.argv.slice(2),
  env = process.env,
  stdin = process.stdin,
  fetchImpl = globalThis.fetch,
  out = (s) => process.stdout.write(s),
  err = (s) => process.stderr.write(s),
} = {}) {
  const fail = (message, code = 1) => {
    err(`${JSON.stringify({ error: message })}\n`);
    return code;
  };

  let parsed;
  try {
    // `factory` has a subcommand of its own; its flags are parsed with it.
    parsed = argv[0] === 'factory' ? { command: 'factory', flags: {} } : parseArgs(argv);
  } catch (error) {
    if (error instanceof UsageError) return fail(`${error.message}\n${USAGE}`, 2);
    throw error;
  }
  const { command, flags } = parsed;

  const url = env.CLAUDE_REMOTE_URL;
  const token = env.CLAUDE_REMOTE_TOKEN;
  if (!url || !token) {
    return fail('CLAUDE_REMOTE_URL and CLAUDE_REMOTE_TOKEN are not set: run this from inside a claude-remote session');
  }
  const headers = { Authorization: `Bearer ${token}` };

  let request;
  let path = '/api/agent/sessions';
  if (command === 'factory') {
    try {
      ({ path, request } = await factoryRequest(argv.slice(1), stdin, headers));
    } catch (error) {
      if (error instanceof UsageError) return fail(`${error.message}\n${USAGE}`, 2);
      throw error;
    }
  } else if (command === 'start') {
    if (!flags.track || !flags.track.trim()) return fail(`--track is required\n${USAGE}`, 2);
    if (flags.mode !== undefined && !ACCEPTED_MODES.includes(flags.mode)) {
      return fail(`--mode must be one of: ${MODES.join(', ')}`, 2);
    }
    // Both checked before any request: a prompt the agent forgot to pipe in
    // must never start an empty session, and a terminal stdin would hang.
    if (stdin.isTTY) return fail("the prompt goes on stdin (a quoted heredoc: <<'EOF' ... EOF), and stdin is a terminal", 2);
    const prompt = await readAll(stdin);
    if (!prompt.trim()) return fail('the prompt on stdin is empty', 2);
    const body = { track: flags.track, prompt };
    if (flags.name !== undefined) body.name = flags.name;
    if (flags.mode !== undefined) body.permissionMode = flags.mode;
    if (flags.mcp !== undefined) body.mcpServers = flags.mcp;
    if (flags.account !== undefined) body.account = flags.account;
    if (flags.readOnly) body.access = 'read';
    request = {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    };
  } else if (command === 'list') {
    if (Object.keys(flags).length > 0) return fail(`list takes no flags\n${USAGE}`, 2);
    request = { method: 'GET', headers };
  } else if (command === 'land' || command === 'update') {
    // No track: the server takes it from this session's worktree. A named one
    // must be a track this session or one it started works in; the server checks.
    if (Object.keys(flags).some((f) => f !== 'track')) return fail(`${command} takes only --track\n${USAGE}`, 2);
    path = `/api/agent/${command}`;
    if (flags.track === undefined) {
      request = { method: 'POST', headers };
    } else {
      if (!flags.track.trim()) return fail(`--track needs a track name\n${USAGE}`, 2);
      request = {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ track: flags.track }),
      };
    }
  } else {
    return fail(command ? `unknown command: ${command}\n${USAGE}` : USAGE, 2);
  }

  let res;
  try {
    // No timeout: start waits for the track's branch and its dependency
    // install, and update for a reinstall, either of which can take minutes.
    res = await fetchImpl(`${url.replace(/\/+$/, '')}${path}`, request);
  } catch (error) {
    const cause = error?.cause?.code || error?.cause?.message || error?.message || String(error);
    return fail(`could not reach claude-remote at ${url}: ${cause}`);
  }
  const text = await res.text();
  if (!res.ok) {
    let message = text;
    try {
      message = JSON.parse(text).error ?? text;
    } catch {
      /* not JSON */
    }
    return fail(`${res.status}: ${message}`);
  }
  if (command === 'land') {
    let closesCaller = true;
    try {
      closesCaller = JSON.parse(text).closesCaller !== false;
    } catch {
      /* not JSON: assume the caller closes, the safe thing to tell its agent */
    }
    // Either the agent's last words before the server closes this session, or
    // a parent's report that its child's track is on its way.
    out(
      closesCaller
        ? 'Land accepted; this session will close. The result arrives as a notification in claude-remote.\n'
        : "Land accepted; the track's sessions will close. The result arrives as a notification in claude-remote.\n"
    );
    return 0;
  }
  if (command === 'update') {
    // The server's detail says what merged, any reinstall, and what to do next.
    try {
      out(`${JSON.parse(text).detail}\n`);
      return 0;
    } catch {
      /* not JSON: print it as it came */
    }
  }
  out(text.endsWith('\n') ? text : `${text}\n`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then(
    (code) => {
      process.exitCode = code;
    },
    (error) => {
      process.stderr.write(`${JSON.stringify({ error: error?.message ?? String(error) })}\n`);
      process.exitCode = 1;
    }
  );
}
