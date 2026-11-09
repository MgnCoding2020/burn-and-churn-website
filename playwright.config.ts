import { defineConfig, devices } from '@playwright/test';

const PORT = 8787;
const STAFF_DB_SPECS = 'e2e/staff-*.spec.ts';

export default defineConfig({
  testDir: 'tests',
  testMatch: ['e2e/**/*.spec.ts', 'a11y/**/*.spec.ts'],
  fullyParallel: true,
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    trace: 'retain-on-failure',
  },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'] }, testIgnore: STAFF_DB_SPECS },
    {
      name: 'phone',
      use: { ...devices['Pixel 7'], viewport: { width: 360, height: 780 } },
      testIgnore: STAFF_DB_SPECS,
    },
    // Specs that seed the shared local D1 from outside the server. Two seeding
    // at once can fail with "Failed to get session commit token", so they run
    // one file at a time.
    { name: 'staff', use: { ...devices['Desktop Chrome'] }, testMatch: STAFF_DB_SPECS, workers: 1 },
  ],
  // The built Worker on Cloudflare's local runtime, as deployed.
  webServer: {
    // Its own database, rebuilt from migrations each run (tests/setup/e2e-db.mjs).
    command: `npm run build && node tests/setup/e2e-db.mjs && npx wrangler dev --port ${PORT} --ip 127.0.0.1 --persist-to .wrangler/e2e-state`,
    url: `http://127.0.0.1:${PORT}/robots.txt`,
    reuseExistingServer: false,
    timeout: 180_000,
  },
});
