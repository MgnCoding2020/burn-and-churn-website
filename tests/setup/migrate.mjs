// Vitest global setup: rebuilds the local test database from migrations/ before
// the run, so every run starts empty and proves the migrations apply cleanly.
// Plain .mjs (like scripts/*.mjs) because it uses Node APIs (ADR-0020: no @types/node).
import { execFileSync } from 'node:child_process';
import { rmSync } from 'node:fs';

export const TEST_STATE = '.wrangler/test-state';
// wrangler's --persist-to adds a v3/ folder itself; getPlatformProxy uses its path as given,
// so the tests open TEST_STATE/v3 (DB_STATE).
export const DB_STATE = TEST_STATE + '/v3';

export default function setup() {
  rmSync(TEST_STATE, { recursive: true, force: true });
  const win = process.platform === 'win32';
  execFileSync(
    win ? 'npx.cmd' : 'npx',
    [
      'wrangler',
      'd1',
      'migrations',
      'apply',
      'DB',
      '--local',
      '--config',
      'wrangler.test.jsonc',
      '--persist-to',
      TEST_STATE,
    ],
    {
      stdio: 'pipe',
      shell: win,
      env: { ...process.env, WRANGLER_SEND_METRICS: 'false', CI: 'true' },
    },
  );
}
