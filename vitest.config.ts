import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/unit/**/*.test.ts', 'tests/api/**/*.test.ts', 'tests/db/**/*.test.ts'],
    globalSetup: ['tests/setup/migrate.mjs'],
    testTimeout: 20_000,
    environment: 'node',
  },
});
