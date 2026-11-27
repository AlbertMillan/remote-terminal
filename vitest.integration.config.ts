import { defineConfig } from 'vitest/config';
import { INTEGRATION_TESTS, baseTest } from './vitest.shared';

// The slow suites only (see vitest.shared.ts). Run with `npm run test:integration`,
// or one file: `npx vitest run --config vitest.integration.config.ts tests/track-update.test.ts`.
export default defineConfig({
  test: {
    ...baseTest,
    include: INTEGRATION_TESTS,
  },
});
