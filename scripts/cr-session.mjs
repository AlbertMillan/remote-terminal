/**
 * cr-session — start and list prompted sessions, and land this session's own
 * track, from inside a claude-remote session (docs/session-orchestration.md).
 * Run by an agent through the Bash tool, via the path the server puts in
 * CLAUDE_REMOTE_CLI:
 *
 *   node "$CLAUDE_REMOTE_CLI" start --track "<name>" [--name <n>] [--mode auto|manual|acceptEdits|plan] <<'EOF'
 *   <prompt>
 *   EOF
 *   node "$CLAUDE_REMOTE_CLI" list
 *   node "$CLAUDE_REMOTE_CLI" land
 *
 * `land` takes nothing: the server lands the track whose worktree this
 * session is in, and closes this session to do it.
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
  node "$CLAUDE_REMOTE_CLI" start --track "<name>" [--name <n>] [--mode auto|manual|acceptEdits|plan]  (prompt on stdin)
  node "$CLAUDE_REMOTE_CLI" list
  node "$CLAUDE_REMOTE_CLI" land`;

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
    const m = /^--(track|name|mode)(?:=(.*))?$/.exec(arg);
    if (!m) throw new UsageError(`unknown argument: ${arg}`);
    const value = m[2] !== undefined ? m[2] : rest[++i];
    if (value === undefined) throw new UsageError(`--${m[1]} needs a value`);
    flags[m[1]] = value;
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
    parsed = parseArgs(argv);
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
  if (command === 'start') {
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
    request = {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    };
  } else if (command === 'list') {
    if (Object.keys(flags).length > 0) return fail(`list takes no flags\n${USAGE}`, 2);
    request = { method: 'GET', headers };
  } else if (command === 'land') {
    // No track argument: the server takes it from this session's worktree,
    // so a session can only ever land its own.
    if (Object.keys(flags).length > 0) return fail(`land takes no flags\n${USAGE}`, 2);
    path = '/api/agent/land';
    request = { method: 'POST', headers };
  } else {
    return fail(command ? `unknown command: ${command}\n${USAGE}` : USAGE, 2);
  }

  let res;
  try {
    // No timeout: start waits for the track's branch and its dependency
    // install, which can take minutes.
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
    // The agent's last words before the server closes this session.
    out('Land accepted; this session will close. The result arrives as a notification in claude-remote.\n');
    return 0;
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
