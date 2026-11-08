// Browser tests' own local database (Playwright's webServer runs this before
// `wrangler dev`): rebuilt from migrations/ on every run, kept apart from the
// developer's local data, and used to seed signed-in staff sessions.
// Plain .mjs because it uses Node APIs (ADR-0020: no @types/node).
import { execFileSync } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

export const E2E_STATE = '.wrangler/e2e-state';

const win = process.platform === 'win32';

function wrangler(args) {
  execFileSync(win ? 'npx.cmd' : 'npx', ['wrangler', ...args, '--persist-to', E2E_STATE], {
    stdio: 'pipe',
    shell: win,
    env: { ...process.env, WRANGLER_SEND_METRICS: 'false', CI: 'true' },
  });
}

/**
 * A signed-in staff member (a barista unless `role` says otherwise), written
 * straight into the test database; `name` and `role` are test constants, never
 * input. Returns the session cookie value. `idleMs` sets the idle limit each
 * request slides to; until the first request it has a minute's slack, since
 * seeding takes seconds.
 */
export function seedStaffSession({
  idleMs,
  absoluteMs = 8 * 3_600_000,
  role = 'Staff.Barista',
  name = 'Test Barista',
}) {
  const token = randomBytes(32).toString('base64url');
  const hash = createHash('sha256').update(token).digest('hex');
  const userId = randomUUID();
  const now = Date.now();
  const at = new Date(now).toISOString();
  const sql = `
    INSERT INTO users (id, idp, idp_sub, display_name, role, created_at, last_seen_at)
    VALUES ('${userId}', 'workforce', '${randomUUID()}', '${name}', '${role}', '${at}', '${at}');
    INSERT INTO sessions (id_hash, user_id, idp, role, created_at, expires_at, idle_expires_at, idle_ms)
    VALUES ('${hash}', '${userId}', 'workforce', '${role}', ${now}, ${now + absoluteMs},
            ${now + Math.min(Math.max(idleMs, 60_000), absoluteMs)}, ${idleMs});`;
  execSql(sql);
  return token;
}

/** Changes the idle limit a session slides to (as if the role's limit changed). */
export function setSessionIdle(token, idleMs) {
  const hash = createHash('sha256').update(token).digest('hex');
  execSql(`UPDATE sessions SET idle_ms = ${idleMs} WHERE id_hash = '${hash}';`);
}

function execSql(sql) {
  // A file, not --command: no shell quoting to get wrong on Windows.
  const dir = mkdtempSync(join(tmpdir(), 'bc-e2e-'));
  const file = join(dir, 'seed.sql');
  writeFileSync(file, sql);
  try {
    // Tests run in parallel and the running server holds the database too:
    // retry briefly if it's locked.
    for (let attempt = 1; ; attempt++) {
      try {
        wrangler(['d1', 'execute', 'DB', '--local', '--file', file]);
        break;
      } catch (err) {
        if (attempt >= 5) throw err;
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 300 * attempt);
      }
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// `node tests/setup/e2e-db.mjs`: rebuild the database before the server starts.
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  rmSync(E2E_STATE, { recursive: true, force: true });
  wrangler(['d1', 'migrations', 'apply', 'DB', '--local']);
}
