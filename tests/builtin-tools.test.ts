import { describe, it, expect } from 'vitest';
import { builtinToolsFor } from '../src/server/agent/claude-run.js';

/**
 * Which tool DEFINITIONS a run carries.
 *
 * `--allowedTools` is a permission list and costs nothing; `--tools` decides
 * what exists in the prompt at all, and that is most of the prompt. Measured on
 * this machine: the full built-in set is ~22.7k tokens against ~4.5k for the six
 * a stage actually uses, re-read on every turn. The expensive ones are exactly
 * the ones no stage can call — Workflow ~8.6k, PowerShell ~4k, Agent ~2.5k.
 *
 * So this derives one from the other, and the properties worth pinning are the
 * ways that derivation could hand the CLI something it cannot use.
 */

describe('builtinToolsFor', () => {
  it('mirrors a stage allowlist unchanged', () => {
    expect(builtinToolsFor(['Read', 'Glob', 'Grep', 'Edit', 'Write', 'Bash'])).toEqual([
      'Read',
      'Glob',
      'Grep',
      'Edit',
      'Write',
      'Bash',
    ]);
  });

  it('reduces a permission pattern to its tool name', () => {
    // `--allowedTools` understands Bash(git *); `--tools` takes names only, and
    // passing the pattern through would name a tool that does not exist.
    expect(builtinToolsFor(['Bash(git *)', 'Read'])).toEqual(['Bash', 'Read']);
  });

  it('drops MCP tools, which are not built-ins', () => {
    // A stage given browser tooling would allow an mcp__ name; `--tools` must
    // not see it, and MCP availability is governed by --strict-mcp-config.
    expect(builtinToolsFor(['Read', 'mcp__claude-in-chrome__navigate'])).toEqual(['Read']);
  });

  it('de-duplicates, so a repeated pattern cannot double a name', () => {
    expect(builtinToolsFor(['Bash(git *)', 'Bash(npm *)', 'Bash'])).toEqual(['Bash']);
  });

  it('never yields an empty name from whitespace or a stray entry', () => {
    // An empty --tools value means "no tools at all", which would silently
    // produce a run that can read nothing.
    expect(builtinToolsFor(['  Read  ', '', '   '])).toEqual(['Read']);
  });
});
