import { defineConfig } from 'vitest/config';
import { ALL_TESTS, INTEGRATION_TESTS, baseTest } from './vitest.shared';

// The fast set: everything except the integration suites (see vitest.shared.ts).
// Those run only through `npm run test:integration` (vitest.integration.config.ts).
export default defineConfig({
  test: {
    ...baseTest,
    include: ALL_TESTS,
    exclude: [...baseTest.exclude, ...INTEGRATION_TESTS],
  },
});
