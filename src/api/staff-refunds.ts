import { z } from 'zod';
import { problem } from '../lib/problem';
import { reasonSchema } from '../lib/reasons';
import { issueRefund } from '../lib/refunds';
import type { Define } from './app';

/**
 * Refunds (plan §4.4, ADR-0034): Manager+, never by the person who took the
 * payment unless Owner. The browser names lines and quantities; amounts come
 * from the sale.
 */

const ORDER_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const Refund = z.strictObject({
  idempotencyKey: z.uuid(),
  lines: z
    .array(
      z.strictObject({
        line: z.number().int().min(1).max(20),
        qty: z.number().int().min(1).max(20),
      }),
    )
    .min(1)
    .max(20)
    .refine((ls) => new Set(ls.map((l) => l.line)).size === ls.length, 'Each line once.'),
  reason: reasonSchema('refund'),
});

function dbOf(env: unknown): D1Database | undefined {
  return (env as { DB?: D1Database } | undefined)?.DB;
}

async function readJson(req: Request): Promise<unknown> {
  try {
    return await req.json();
  } catch {
    return undefined;
  }
}

export function registerStaffRefunds(define: Define) {
  define(
    { method: 'POST', path: '/staff/orders/:id/refunds', principal: 'Staff.Manager' },
    async (c) => {
      const db = dbOf(c.env);
      if (!db) return problem(c, 503, 'Service unavailable');
      const orderId = c.req.param('id') ?? '';
      if (!ORDER_ID.test(orderId)) return problem(c, 404, 'Not found');
      const parsed = Refund.safeParse(await readJson(c.req.raw));
      if (!parsed.success) return problem(c, 400, 'Bad request', 'The refund is not valid.');
      const user = c.get('user')!;
      const outcome = await issueRefund(
        db,
        { orderId, ...parsed.data },
        { userId: user.id, role: user.role!, requestId: c.get('requestId') },
      );
      switch (outcome) {
        case 'not_found':
          return problem(c, 404, 'Not found');
        case 'own_sale':
          return problem(
            c,
            403,
            'Forbidden',
            'You took this payment, so you can’t refund it. Another manager, or the owner, can.',
          );
        case 'bad_line':
          return problem(c, 422, 'Unprocessable refund', 'A chosen line isn’t on this sale.');
        case 'over_refund':
          return problem(
            c,
            409,
            'Conflict',
            'That is more than is left to refund on this sale. Reload to see what’s left.',
          );
        case 'key_reused':
          return problem(c, 409, 'Conflict', 'That refund key was already used.');
        default:
          return c.json(
            { id: outcome.id, amountCents: outcome.amountCents, tender: outcome.tender },
            outcome.replayed ? 200 : 201,
          );
      }
    },
  );
}
