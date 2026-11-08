import { purgeExpiredSessions } from '../lib/session';

/**
 * Hourly clean-up (Cron Trigger in wrangler.jsonc, ADR-0028): expired
 * sessions and abandoned sign-in attempts are deleted, so nothing is kept
 * past its limit (plan §9, privacy: sessions purged on expiry). Expired rows
 * are already refused when presented; this removes the ones never presented
 * again. The audit log is never touched.
 */

export interface CleanUpResult {
  sessions: number;
  logins: number;
}

export async function cleanUp(db: D1Database, now = Date.now()): Promise<CleanUpResult> {
  const sessions = await purgeExpiredSessions(db, now);
  const res = await db.prepare('DELETE FROM oidc_logins WHERE expires_at <= ?').bind(now).run();
  return { sessions, logins: res.meta.changes ?? 0 };
}

export async function scheduled(_controller: ScheduledController, env: Env): Promise<void> {
  const db = (env as unknown as { DB?: D1Database }).DB;
  if (!db) return;
  const removed = await cleanUp(db);
  // Counts only, never IDs.
  console.log(JSON.stringify({ job: 'clean-up', removed }));
}
