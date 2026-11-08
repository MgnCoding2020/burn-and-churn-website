import { z } from 'zod';
import { menuForToday } from '../lib/availability';
import { createCashOrder, listBoard, moveOrder, priceOrder, STAGES } from '../lib/orders';
import { problem } from '../lib/problem';
import type { Define } from './app';

/**
 * The counter register and the order board (plan §6.3, ADR-0031). Barista and
 * up. Prices come from the server's menu; the browser sends only what was
 * ordered and how much cash was handed over.
 */

const MAX_LINES = 20;

const CashOrder = z.strictObject({
  idempotencyKey: z.uuid(),
  tender: z.literal('cash'),
  tenderedCents: z.number().int().min(1).max(100_000),
  lines: z
    .array(
      z.strictObject({
        itemId: z.string().regex(/^[a-z0-9-]{1,40}$/),
        variantId: z.string().regex(/^[a-z0-9-]{1,20}$/),
        qty: z.number().int().min(1).max(20),
      }),
    )
    .min(1)
    .max(MAX_LINES),
});

const StageMove = z.strictObject({
  from: z.enum(STAGES),
  to: z.enum(STAGES),
});

const ORDER_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

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

export function registerStaffOrders(define: Define) {
  // Ring up a sale and take cash.
  define({ method: 'POST', path: '/staff/orders', principal: 'Staff.Barista' }, async (c) => {
    const db = dbOf(c.env);
    if (!db) return problem(c, 503, 'Service unavailable');
    const parsed = CashOrder.safeParse(await readJson(c.req.raw));
    if (!parsed.success) return problem(c, 400, 'Bad request', 'The order is not valid.');
    const { idempotencyKey, lines, tenderedCents } = parsed.data;

    // Today's menu: an item marked sold out (86) can't be sold, even from a stale page.
    const priced = priceOrder(lines, await menuForToday(db));
    if (!priced.ok) {
      const detail =
        priced.error === 'unavailable'
          ? 'An item in the order is sold out.'
          : 'An item in the order is not on the menu.';
      return problem(c, 422, 'Unprocessable order', detail);
    }
    if (tenderedCents < priced.totalCents) {
      return problem(c, 422, 'Unprocessable order', 'The cash handed over is less than the total.');
    }

    const result = await createCashOrder(db, {
      idempotencyKey,
      takenBy: c.get('user')!.id,
      actorRole: c.get('user')!.role!,
      requestId: c.get('requestId'),
      lines: priced.lines,
      totalCents: priced.totalCents,
      tenderedCents,
    });
    if ('error' in result) return problem(c, 409, 'Conflict', 'That order key was already used.');
    return c.json(
      {
        id: result.id,
        number: result.number,
        totalCents: result.totalCents,
        changeCents: result.changeCents,
      },
      result.replayed ? 200 : 201,
    );
  });

  // The order board. Polled every few seconds; reading it doesn't count as activity.
  define({ method: 'GET', path: '/staff/orders', principal: 'Staff.Barista' }, async (c) => {
    const db = dbOf(c.env);
    if (!db) return problem(c, 503, 'Service unavailable');
    return c.json({ orders: await listBoard(db), at: Date.now() });
  });

  // Move an order one step: New → In progress → Ready → Collected.
  define(
    { method: 'POST', path: '/staff/orders/:id/stage', principal: 'Staff.Barista' },
    async (c) => {
      const db = dbOf(c.env);
      if (!db) return problem(c, 503, 'Service unavailable');
      const id = c.req.param('id') ?? '';
      if (!ORDER_ID.test(id)) return problem(c, 404, 'Not found');
      const parsed = StageMove.safeParse(await readJson(c.req.raw));
      if (!parsed.success) return problem(c, 400, 'Bad request', 'The move is not valid.');
      const outcome = await moveOrder(db, id, parsed.data.from, parsed.data.to);
      if (outcome === 'not_found') return problem(c, 404, 'Not found');
      if (outcome === 'not_allowed')
        return problem(c, 422, 'Unprocessable move', 'Orders move one step at a time.');
      if (outcome === 'conflict')
        return problem(c, 409, 'Conflict', 'Someone else already moved this order.');
      return c.json({ id, stage: parsed.data.to });
    },
  );
}
