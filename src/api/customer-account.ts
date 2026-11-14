import type { Context } from 'hono';
import { eraseDirectoryAccount, erasureConfig, ErasureError } from '../lib/erasure';
import { clearedSessionCookie } from '../lib/session';
import type { AppEnv } from '../server/types';
import type { Define } from './app';

/**
 * Delete my data (plan §9 "Privacy", ADR-0043). A signed-in customer erases
 * their account: first from the customer directory (so they can't sign back
 * in to a half-deleted account), then everything this site holds. If the
 * directory step fails, nothing is deleted and they can try again.
 *
 * Kept as a record without personal data: one request-log line with our
 * internal user ID, which means nothing once the row is gone.
 */

export const DELETED_PAGE = '/account/deleted/';
export const DELETE_PROBLEM_PAGE = '/account/delete-problem/';

function refuse(c: Context<AppEnv>, reason: string, extra: Record<string, unknown> = {}) {
  console.warn(
    JSON.stringify({
      level: 'warn',
      requestId: c.get('requestId'),
      event: 'customer.erase_failed',
      reason,
      ...extra,
    }),
  );
  return c.redirect(DELETE_PROBLEM_PAGE, 303);
}

export function registerCustomerAccount(define: Define) {
  define(
    { method: 'POST', path: '/account/delete', principal: 'customer', limit: 'erasure' },
    async (c) => {
      const env = c.env as unknown as Record<string, unknown> | undefined;
      const db = env?.DB as D1Database | undefined;
      const cfg = erasureConfig(env);
      const user = c.get('user')!;
      if (!db || !cfg) return refuse(c, 'not_configured');

      // The form's checkbox: "I understand this can't be undone".
      const body = await c.req.parseBody().catch(() => ({}) as Record<string, unknown>);
      if (body.confirm !== 'yes') return refuse(c, 'not_confirmed');

      const row = await db
        .prepare(`SELECT idp_sub FROM users WHERE id = ? AND idp = 'customer'`)
        .bind(user.id)
        .first<{ idp_sub: string }>();
      if (!row) return refuse(c, 'no_user');

      let result;
      try {
        result = await eraseDirectoryAccount(cfg, row.idp_sub);
      } catch (err) {
        const e = err instanceof ErasureError ? err : new ErasureError('delete', 0, 'unknown');
        return refuse(c, 'directory', { step: e.step, status: e.status, code: e.code });
      }

      // Sessions go with the user (ON DELETE CASCADE); deleted explicitly as well.
      await db.batch([
        db.prepare('DELETE FROM sessions WHERE user_id = ?').bind(user.id),
        db.prepare(`DELETE FROM users WHERE id = ? AND idp = 'customer'`).bind(user.id),
      ]);
      console.log(
        JSON.stringify({
          level: 'info',
          requestId: c.get('requestId'),
          event: 'customer.erased',
          userId: user.id,
          directoryDeleted: result.deleted,
          purged: result.purged,
        }),
      );
      c.header('Set-Cookie', clearedSessionCookie(), { append: true });
      return c.redirect(DELETED_PAGE, 303);
    },
  );
}
