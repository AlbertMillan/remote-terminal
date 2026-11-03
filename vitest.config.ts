import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    // Node 25+ defines its own global `localStorage`, undefined without
    // --localstorage-file, and it shadows happy-dom's: DOM tests then fail on
    // `localStorage.clear()`. Turning Node's off lets happy-dom install its own.
    execArgv: ['--no-experimental-webstorage'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      include: ['src/**/*.ts'],
      exclude: ['src/client/**/*.ts'],
    },
  },
});
