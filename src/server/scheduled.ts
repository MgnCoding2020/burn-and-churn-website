import { purgeExpiredSessions } from '../lib/session';

/**
 * Hourly clean-up (Cron Trigger in wrangler.jsonc, ADR-0028), so nothing is
 * kept past its limit (plan §9): expired sessions, any rows left in the
 * retired `oidc_logins` table (ADR-0030), and orders (with their refunds) and
 * cash drawer counts older than 90 days, and Stripe event IDs (replay protection)
 * and card payment attempts after 90 days (Stripe's retries stop long before).
 * Expired sessions are already refused when presented; this removes the ones
 * never presented again. The audit log is never touched.
 */

export interface CleanUpResult {
  sessions: number;
  logins: number;
  orders: number;
  drawers: number;
  stripeEvents: number;
  cardPayments: number;
}

/** Orders are kept for 90 days (plan §9, privacy page). */
export const ORDER_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;

export async function cleanUp(db: D1Database, now = Date.now()): Promise<CleanUpResult> {
  const sessions = await purgeExpiredSessions(db, now);
  const logins = await db.prepare('DELETE FROM oidc_logins WHERE expires_at <= ?').bind(now).run();
  // Children first: refunds and lines belong to the orders being removed.
  const cutoff = now - ORDER_RETENTION_MS;
  const old = 'SELECT id FROM orders WHERE created_at < ?';
  const [, , , orders, drawers, stripeEvents, cardPayments] = await db.batch([
    db.prepare(`DELETE FROM refund_lines WHERE order_id IN (${old})`).bind(cutoff),
    db.prepare(`DELETE FROM refunds WHERE order_id IN (${old})`).bind(cutoff),
    db
      .prepare(
        'DELETE FROM order_items WHERE order_id IN (SELECT id FROM orders WHERE created_at < ?)',
      )
      .bind(cutoff),
    db.prepare('DELETE FROM orders WHERE created_at < ?').bind(cutoff),
    db.prepare('DELETE FROM cash_drawers WHERE opened_at < ?').bind(cutoff),
    db.prepare('DELETE FROM stripe_events WHERE received_at < ?').bind(cutoff),
    db.prepare('DELETE FROM card_payments WHERE created_at < ?').bind(cutoff),
  ]);
  return {
    sessions,
    logins: logins.meta.changes ?? 0,
    orders: orders!.meta.changes ?? 0,
    drawers: drawers!.meta.changes ?? 0,
    stripeEvents: stripeEvents!.meta.changes ?? 0,
    cardPayments: cardPayments!.meta.changes ?? 0,
  };
}

export async function scheduled(_controller: ScheduledController, env: Env): Promise<void> {
  const db = (env as unknown as { DB?: D1Database }).DB;
  if (!db) return;
  const removed = await cleanUp(db);
  // Counts only, never IDs.
  console.log(JSON.stringify({ job: 'clean-up', removed }));
}
