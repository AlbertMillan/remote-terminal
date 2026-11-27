import { configDefaults } from 'vitest/config';

/**
 * The slow suites: real git repositories and worktrees, or real child processes
 * (builds, installs, the statusline script). Each spawns hundreds of processes,
 * and on a Windows machine with Defender's real-time scanning a git spawn costs
 * ~90ms, so together they take 10+ minutes locally and time out under parallel
 * load. On a GitHub Windows runner the same files take ~1 minute in all.
 *
 * `npm test` (what sessions and the factory's verify step run) leaves them out;
 * `npm run test:integration` runs only them. Add a file here when it builds real
 * repositories or spawns real processes per test; a file left out of both lists
 * stays in the fast set.
 */
export const INTEGRATION_TESTS = [
  'tests/agent-land.test.ts',
  'tests/factory-intake.test.ts',
  'tests/factory-merge-queue.test.ts',
  'tests/local-claude-settings.test.ts',
  'tests/project-build.test.ts',
  'tests/project-deps.test.ts',
  'tests/server-restart.test.ts',
  'tests/session-log-worktree.test.ts',
  'tests/statusline-script.test.ts',
  'tests/track-attribution.test.ts',
  'tests/track-branches.test.ts',
  'tests/track-delete.test.ts',
  'tests/track-plan.test.ts',
  'tests/track-update.test.ts',
  'tests/worktree-teardown.test.ts',
];

export const ALL_TESTS = ['tests/**/*.test.ts'];

/** Never `mergeConfig` the two configs: it concatenates `include`, running everything. */
export const baseTest = {
  globals: true,
  environment: 'node' as const,
  exclude: [...configDefaults.exclude],
  // Node 25+ defines its own global `localStorage`, undefined without
  // --localstorage-file, and it shadows happy-dom's: DOM tests then fail on
  // `localStorage.clear()`. Turning Node's off lets happy-dom install its own.
  execArgv: ['--no-experimental-webstorage'],
  coverage: {
    provider: 'v8' as const,
    reporter: ['text', 'json', 'html'],
    include: ['src/**/*.ts'],
    exclude: ['src/client/**/*.ts'],
  },
};
